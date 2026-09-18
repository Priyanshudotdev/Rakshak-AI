import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RealtimeAdapter, RealtimeSession } from "./saaras.js";

// ARI call control (spec §6): answer Stasis calls, fork caller audio to the
// realtime adapter via one External Media channel per call, bridge, cleanup.
// Hand-rolled on `ws` + fetch (no ari-client dep): the surface is tiny and
// stays fully typed + unit-testable with an injected socket factory.

export interface AriOptions {
  /** e.g. http://asterisk:8088 (ws:// derived for events). */
  baseUrl?: string;
  app?: string;
  username?: string;
  password?: string;
  /** Hostname Asterisk uses to reach THIS gateway's RTP (compose: media-gateway). */
  rtpHost?: string;
  /** First UDP port for per-call RTP; +1 per concurrent call. */
  rtpPortBase?: number;
  /** Shared sounds dir (same volume as Asterisk's sounds/tts). */
  ttsDir?: string;
  createSocket?: (url: string) => SocketLike;
  fetchFn?: typeof fetch;
}

export interface SocketLike {
  on(event: "open" | "message" | "error" | "close", cb: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
}

export interface AriHooks {
  publish(name: string, callId: string, payload: unknown): void;
  log(level: string, msg: string, fields?: Record<string, unknown>): void;
  adapter: RealtimeAdapter;
  /** Full-loop handler: incident extraction + spoken reply for final transcripts. */
  onFinalTranscript?: (callId: string, text: string, language: string | undefined, role: LegRole) => void;
  /** Synthesize speech in the given language code. Returns wav bytes (or null). */
  synthesize?: (text: string, languageCode?: string) => Promise<Buffer | null>;
}

interface RtpPeer {
  address: string;
  port: number;
  seq: number;
  timestamp: number;
  ssrc: number;
  /** Payload type Asterisk uses for this slin16 leg — learned inbound. */
  pt: number;
}

/** Build a minimal 16-bit mono WAV at the given rate. Pure, unit-tested. */
export function buildWav16(samples: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]);
}

/** Naive linear-interpolation resampler for mono int16 (test-harness grade). */
export function resampleLinear16(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[i0] ?? 0;
    const b = samples[Math.min(i0 + 1, samples.length - 1)] ?? 0;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Parse a WAV header by walking subchunks to the `data` chunk. Never assumes
 *  44 bytes: synths often emit JUNK/LIST/fact chunks that shift the audio,
 *  and every shifted byte plays as static. Returns PCM info or null. */
export function parseWavHeader(wav: Buffer): {
  dataOffset: number;
  dataLength: number;
  sampleRate: number;
  channels: number;
  bits: number;
} | null {
  try {
    if (wav.length < 16 || wav.subarray(0, 4).toString() !== "RIFF") return null;
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    if (wav.subarray(8, 12).toString() !== "WAVE") return null;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let offset = 12;
    let dataOffset = -1;
    let dataLength = 0;
    while (offset + 8 <= wav.length) {
      const id = wav.subarray(offset, offset + 4).toString();
      const size = view.getUint32(offset + 4, true);
      if (id === "fmt " && size >= 16 && offset + 24 <= wav.length) {
        channels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bits = view.getUint16(offset + 22, true);
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataLength = size;
        break;
      }
      offset += 8 + size + (size % 2);
      if (offset > wav.length) break;
    }
    if (dataOffset < 0 || !sampleRate || !channels || !bits) return null;
    return { dataOffset, dataLength, sampleRate, channels, bits };
  } catch {
    return null;
  }
}

type LegRole = "caller" | "operator";

interface Leg {
  callId: string;
  channelId: string;
  /** Empty for operator legs (no media fork — they share the caller bridge). */
  externalId: string;
  bridgeId: string;
  role: LegRole;
  udp: UdpSocket | null;
  saaras: RealtimeSession | null;
  rtpPort: number;
  rxPackets: number;
  rxBytes: number;
  rxByPt: Map<number, number>;
  txPackets: number;
  txBytes: number;
}

/** Strip an RTP header (handles CSRC list + one extension header). */
export function rtpPayload(packet: Buffer): Buffer {
  if (packet.length < 12) return Buffer.alloc(0);
  let offset = 12 + (packet[0] & 0x0f) * 4;
  if (packet[0] & 0x10) {
    if (packet.length < offset + 4) return Buffer.alloc(0);
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  return packet.length > offset ? packet.subarray(offset) : Buffer.alloc(0);
}

export class AriController {
  private readonly opts: Required<Omit<AriOptions, "createSocket" | "fetchFn">> &
    Pick<AriOptions, "createSocket" | "fetchFn">;
  private readonly hooks: AriHooks;
  private ws: SocketLike | null = null;
  private nextRtpPort: number;
  private readonly legs = new Map<string, Leg>(); // by channel id
  private readonly peers = new Map<number, RtpPeer>(); // by our UDP port
  // Sync claim set: onCall awaits network I/O before legs.set, so back-to-back
  // StasisStart events for one channel would double-fork without this.
  private readonly claimed = new Set<string>();
  private stopped = false;

  constructor(hooks: AriHooks, opts: AriOptions = {}) {
    this.hooks = hooks;
    this.opts = {
      baseUrl: (opts.baseUrl ?? process.env.ARI_URL ?? "http://asterisk:8088").replace(/\/$/, ""),
      app: opts.app ?? process.env.ARI_APP ?? "rakshak",
      username: opts.username ?? process.env.ARI_USER ?? "rakshak-gateway",
      password: opts.password ?? process.env.ARI_PASSWORD ?? "rakshak-ari-test-only",
      rtpHost: opts.rtpHost ?? process.env.GATEWAY_RTP_HOST ?? "media-gateway",
      rtpPortBase: opts.rtpPortBase ?? Number(process.env.GATEWAY_RTP_BASE ?? 17777),
      ttsDir: opts.ttsDir ?? process.env.TTS_FILE_DIR ?? "/tts-out",
      createSocket: opts.createSocket,
      fetchFn: opts.fetchFn,
    };
    this.nextRtpPort = this.opts.rtpPortBase;
  }

  private api(path: string): string {
    const qs = `api_key=${encodeURIComponent(this.opts.username)}:${encodeURIComponent(this.opts.password)}`;
    return `${this.opts.baseUrl}/ari/${path}${path.includes("?") ? "&" : "?"}${qs}`;
  }

  private async rest(method: string, path: string, body?: unknown): Promise<any> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(this.api(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ARI ${method} ${path} -> ${res.status}`);
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = 3000;

  /** Connect with backoff until the first open (Asterisk may still boot),
   *  then stay connected. Resolves only once online. */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectDelay = 3000;
    for (;;) {
      try {
        await this.connectOnce();
        break;
      } catch (err) {
        if (this.stopped) return;
        this.hooks.log("warn", "ari connect failed, retrying", { err: String(err) });
        await new Promise((r) => setTimeout(r, this.reconnectDelay));
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    }
    this.reconnectDelay = 3000;
    this.armReconnect();
  }

  private armReconnect(): void {
    if (this.stopped) return;
    this.ws?.on("close", () => {
      if (this.stopped) return;
      this.hooks.log("warn", "ari disconnected, reconnecting");
      this.retryLoop();
    });
  }

  /** Persistent retry with backoff: runs until the socket is back. */
  private retryLoop(): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = () => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.connectOnce().then(
        () => {
          this.reconnectDelay = 3000;
          this.armReconnect();
        },
        (err: unknown) => {
          this.hooks.log("warn", "ari reconnect failed", { err: String(err) });
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
          this.retryLoop();
        },
      );
    };
    this.reconnectTimer = setTimeout(attempt, this.reconnectDelay);
  }

  private async connectOnce(): Promise<void> {
    const url = this.api("events").replace(/^http/, "ws") + `&app=${encodeURIComponent(this.opts.app)}&subscribeAll=true`;
    let ws: SocketLike;
    if (this.opts.createSocket) {
      ws = this.opts.createSocket(url);
    } else {
      const { WebSocket } = await import("ws");
      ws = new WebSocket(url) as unknown as SocketLike;
    }
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    });
    this.hooks.log("info", "ari connected", { app: this.opts.app });
    ws.on("message", (raw: unknown) => {
      try {
        this.onEvent(JSON.parse(String(raw)) as { type?: string });
      } catch (err) {
        this.hooks.log("warn", "ari bad frame", { err: String(err) });
      }
    });
    ws.on("error", (err: unknown) => this.hooks.log("warn", "ari socket error", { err: String(err) }));
  }

  private async onEvent(event: { type?: string; [k: string]: any }): Promise<void> {
    try {
      if (event.type === "StasisStart") await this.onCall(event);
      else if (event.type === "StasisEnd" || event.type === "ChannelHangupRequest") {
        const id = event.channel?.id ?? event.channelId;
        if (id) await this.teardown(String(id));
      }
    } catch (err) {
      this.hooks.log("warn", "ari event failed", { type: event.type, err: String(err) });
    }
  }

  private async onCall(event: { [k: string]: any }): Promise<void> {
    const channel = event.channel ?? {};
    const channelId = String(channel.id ?? "");
    const channelName = String(channel.name ?? "");
    const exten = String(event.args?.[0] ?? "");
    const caller = String(channel.caller?.number ?? "");
    if (!channelId) return;
    // Our own External Media forks enter the same ARI app — they are media
    // pipes, not callers. Bridging them again cascades: each fork births
    // another fork until RTP ports exhaust and Asterisk falls over.
    if (channelName.startsWith("UnicastRTP/")) return;
    // Duplicate StasisStart for a leg we already own: ignore, never double-fork.
    if (this.legs.has(channelId) || this.claimed.has(channelId)) return;
    this.claimed.add(channelId);
    try {
      if (exten === "9002") await this.setupOperator(channelId, caller);
      else await this.setupLeg(channelId, exten, caller);
    } catch (err) {
      this.claimed.delete(channelId);
      throw err;
    }
  }

  /** Operator join (1001 dials 9002): own STT fork like a caller, then into
   *  the newest live emergency bridge. Operator speech is transcribed with
   *  role=operator so it translates toward the caller — never as incidents.
   *  Nobody waiting: polite hangup, the dashboard shows nothing to join. */
  private async setupOperator(channelId: string, caller: string): Promise<void> {
    const target = [...this.legs.values()].reverse().find((l) => l.role === "caller");
    if (!target) {
      this.hooks.log("info", "operator join with no live call", { caller });
      await this.rest("POST", `channels/${encodeURIComponent(channelId)}/hangup`);
      this.hooks.publish("call.ended", `ARI-${channelId.slice(0, 8).toUpperCase()}`, { reason: "no-live-call" });
      return;
    }
    const callId = `ARI-OP-${channelId.slice(0, 8).toUpperCase()}`;
    const fork = await this.forkMedia(callId, channelId, "operator");
    await this.rest("POST", `channels/${encodeURIComponent(channelId)}/answer`);
    await this.rest("POST", `bridges/${target.bridgeId}/addChannel`, { channel: [channelId, fork.externalId] });
    this.legs.set(channelId, {
      callId,
      channelId,
      externalId: fork.externalId,
      bridgeId: target.bridgeId,
      role: "operator",
      udp: fork.udp,
      saaras: fork.saaras,
      rtpPort: fork.rtpPort,
      rxPackets: 0,
      rxBytes: 0,
      rxByPt: new Map(),
      txPackets: 0,
      txBytes: 0,
    });
    this.hooks.publish("call.answered", callId, { via: "ari", role: "operator", joined: target.callId, caller });
    this.hooks.log("info", "operator joined emergency bridge", { callId, joined: target.callId });
  }

  /** Shared media fork: Saaras session + one UDP port + External Media
   *  channel. Role tags every final so caller speech (incidents + replies)
   *  and operator speech (translate-only) route differently. */
  private async forkMedia(
    callId: string,
    channelId: string,
    role: LegRole,
  ): Promise<{ udp: UdpSocket; saaras: RealtimeSession; rtpPort: number; externalId: string }> {
    const saaras = await this.hooks.adapter.connect(callId, {
      onPartial: (text, language) =>
        this.hooks.publish("transcript.partial", callId, { original_text: text, language: language ?? "Unknown", role }),
      onFinal: (text, language) => {
        this.hooks.publish("transcript.final", callId, { original_text: text, language: language ?? "Unknown", role });
        try {
          this.hooks.onFinalTranscript?.(callId, text, language, role);
        } catch (err) {
          this.hooks.log("warn", "final handler failed", { callId, err: String(err) });
        }
      },
      onError: (err) => this.hooks.log("warn", "realtime error", { callId, err: String(err) }),
      onClose: () => undefined,
    });

    // One UDP port per leg: no SSRC demux needed, trivially testable.
    const rtpPort = this.nextRtpPort++;
    const udp = createSocket("udp4");
    udp.on("message", (msg, rinfo) => {
      if (rinfo && msg.length >= 2 && !this.peers.has(rtpPort)) {
        // Learn the return path from the first packet: Asterisk sends from
        // its RTP port, so TTS replies go back to exactly there — with the
        // SAME payload type it uses (PT=0 hardcoded decodes as mu-law static).
        const pt = msg[1] & 0x7f;
        this.peers.set(rtpPort, {
          address: rinfo.address,
          port: rinfo.port,
          seq: Math.floor(Math.random() * 60000),
          timestamp: Math.floor(Math.random() * 0xffffffff),
          ssrc: Math.floor(Math.random() * 0xffffffff),
          pt,
        });
        this.hooks.log("info", "rtp flowing", { callId, from: `${rinfo.address}:${rinfo.port}`, pt });
      }
      const leg = this.legs.get(channelId);
      const pcm = rtpPayload(msg);
      if (leg?.saaras && pcm.length) {
        leg.rxPackets += 1;
        leg.rxBytes += pcm.length;
        const pt = msg.length >= 2 ? msg[1] & 0x7f : -1;
        leg.rxByPt.set(pt, (leg.rxByPt.get(pt) ?? 0) + 1);
        try {
          leg.saaras.sendAudio(pcm);
        } catch {
          /* session closing */
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(rtpPort, "0.0.0.0", () => resolve());
    });

    const external = await this.rest("POST", "channels/externalMedia", {
      app: this.opts.app,
      external_host: `${this.opts.rtpHost}:${rtpPort}`,
      format: "slin16",
      encapsulation: "rtp",
      transport: "udp",
      connection_type: "client",
      direction: "both",
      variables: { RAKSHAK_CALL_ID: callId },
    });
    return { udp, saaras, rtpPort, externalId: String(external.id) };
  }

  private async setupLeg(channelId: string, exten: string, caller: string): Promise<void> {
    const callId = `ARI-${channelId.slice(0, 8).toUpperCase()}`;
    this.hooks.publish("call.answered", callId, { via: "ari", exten, caller });

    const fork = await this.forkMedia(callId, channelId, "caller");

    await this.rest("POST", `channels/${encodeURIComponent(channelId)}/answer`);
    const bridge = await this.rest("POST", "bridges", { type: "mixing" });
    await this.rest("POST", `bridges/${bridge.id}/addChannel`, { channel: [channelId, fork.externalId] });

    this.legs.set(channelId, {
      callId,
      channelId,
      externalId: fork.externalId,
      bridgeId: String(bridge.id),
      role: "caller",
      udp: fork.udp,
      saaras: fork.saaras,
      rtpPort: fork.rtpPort,
      rxPackets: 0,
      rxBytes: 0,
      rxByPt: new Map(),
      txPackets: 0,
      txBytes: 0,
    });
    this.hooks.log("info", "ari leg bridged", { callId, exten });
    // Greeting FIRST: an emergency caller waiting in silence assumes the line
    // is dead and says nothing worth transcribing (proven by a 27 s silent
    // recording). The prompt tells them they're connected and what to say.
    if (exten !== "9002") {
      void this.playReply(
        channelId,
        "रक्षक आपत्कालीन सेवा. कृपया आपले ठिकाण आणि काय घडले ते सांगा.",
      ).catch(() => undefined);
    }
    // Audible-silence watchdog: if Asterisk never streams, say so plainly
    // instead of failing mute.
    const forkPort = fork.rtpPort;
    setTimeout(() => {
      const leg = this.legs.get(channelId);
      if (leg && leg.rxPackets === 0) {
        this.hooks.log("warn", "no inbound RTP yet", { callId, rtpPort: forkPort, hint: "caller mic muted or Asterisk not streaming" });
      }
    }, 8000);
  }

  /** The other leg sharing this call's bridge (caller↔operator), if any. */
  bridgePeer(callId: string): { callId: string; channelId: string; role: LegRole } | null {
    const leg = [...this.legs.values()].find((l) => l.callId === callId);
    if (!leg) return null;
    const other = [...this.legs.values()].find((l) => l.bridgeId === leg.bridgeId && l.channelId !== leg.channelId);
    return other ? { callId: other.callId, channelId: other.channelId, role: other.role } : null;
  }

  /** Resolve the ARI channel behind a call id (for the reply path). */
  channelForCall(callId: string): string | null {
    for (const [channelId, leg] of this.legs) {
      if (leg.callId === callId) return channelId;
    }
    return null;
  }

  private readonly sendQueues = new Map<string, Promise<void>>();

  /** Speak text into the call via Asterisk's own playback (reliable path).
   *  Writes the wav to the shared sounds volume and plays it on the CALLER
   *  channel — no hand-built RTP involved. Serialized per channel. */
  async playReply(channelId: string, text: string, languageCode = "mr-IN"): Promise<void> {
    const leg = this.legs.get(channelId);
    if (!leg || !this.hooks.synthesize) return;
    const prev = this.sendQueues.get(channelId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        if (!this.legs.has(channelId)) {
          this.hooks.log("warn", "reply skipped, leg gone", { callId: leg.callId });
          return;
        }
        const wav = await this.hooks.synthesize!(text, languageCode);
        if (!wav) {
          this.hooks.log("warn", "reply skipped, no audio", { callId: leg.callId });
          return;
        }
        if (!this.legs.has(channelId)) {
          this.hooks.log("warn", "reply skipped, leg gone", { callId: leg.callId });
          return;
        }
        // Normalize to telephony-native 8 kHz/16-bit mono: 22050 Hz uploads
        // played silent, so remove all transcoding ambiguity server-side.
        const info = parseWavHeader(wav);
        let out = wav;
        if (info && (info.sampleRate !== 8000 || info.channels !== 1 || info.bits !== 16)) {
          const count = Math.floor(Math.min(info.dataLength, wav.length - info.dataOffset) / 2);
          const pcm = new Int16Array(wav.buffer, wav.byteOffset + info.dataOffset, count);
          out = buildWav16(resampleLinear16(pcm, info.sampleRate, 8000), 8000);
          this.hooks.log("info", "tts normalized", { callId: leg.callId, from: info.sampleRate });
        }
        const name = `tts-${leg.callId}-${Date.now().toString(36)}`;
        await mkdir(dirname(this.ttsPath(name)), { recursive: true });
        await writeFile(this.ttsPath(name), out);
        try {
          const playback = await this.rest("POST", `channels/${encodeURIComponent(channelId)}/play`, {
            media: `sound:tts/${name}`,
          });
          this.hooks.log("info", "reply playing", { callId: leg.callId, playback: playback?.id ?? "?" });
        } finally {
          this.sweepTts(name).catch(() => undefined);
        }
      })
      .catch((err: unknown) => {
        this.hooks.log("warn", "reply playback failed", { callId: leg.callId, err: String(err) });
      })
      .then(() => {
        if (this.sendQueues.get(channelId) === next) this.sendQueues.delete(channelId);
      });
    this.sendQueues.set(channelId, next);
    return next;
  }

  private ttsPath(name: string): string {
    return `${this.opts.ttsDir}/${name}.wav`;
  }

  private readonly played: string[] = [];

  private async sweepTts(except: string): Promise<void> {
    this.played.push(except);
    if (this.played.length <= 20) return;
    const { unlink } = await import("node:fs/promises");
    const old = this.played.splice(0, this.played.length - 20);
    for (const name of old) {
      if (name === except) continue;
      try {
        await unlink(this.ttsPath(name));
      } catch {
        /* already gone */
      }
    }
  }

  /** Send mono 16 kHz PCM16 into the call (TTS injection), paced in real time
   *  in 20 ms frames. Replies queue per channel: overlapping finals would
   *  otherwise interleave packet streams (shared seq/timestamp) into garbage.
   *  No-op until the first inbound packet teaches us the return path. */
  sendCallAudio(channelId: string, pcm16: Int16Array): Promise<void> {
    const prev = this.sendQueues.get(channelId) ?? Promise.resolve();
    const next = prev
      .then(() => this.sendOne(channelId, pcm16))
      .catch(() => undefined)
      .then(() => {
        if (this.sendQueues.get(channelId) === next) this.sendQueues.delete(channelId);
      });
    this.sendQueues.set(channelId, next);
    return next;
  }

  private async sendOne(channelId: string, pcm16: Int16Array): Promise<void> {
    const leg = this.legs.get(channelId);
    const peer = leg ? this.peers.get(leg.rtpPort) : undefined;
    if (!leg?.udp || !peer) return;
    const FRAME = 320; // 20 ms @ 16 kHz
    let first = true;
    for (let i = 0; i < pcm16.length; i += FRAME) {
      if (!this.legs.has(channelId)) return; // hung up mid-reply
      if (leg) {
        leg.txPackets += 1;
        leg.txBytes += pcm16.subarray(i, i + FRAME).length * 2;
      }
      const chunk = pcm16.subarray(i, i + FRAME);
      const packet = Buffer.alloc(12 + chunk.length * 2);
      packet[0] = 0x80;
      packet[1] = (first ? 0x80 : 0x00) | (peer.pt & 0x7f);
      first = false;
      packet.writeUInt16BE(peer.seq & 0xffff, 2);
      packet.writeUInt32BE(peer.timestamp >>> 0, 4);
      packet.writeUInt32BE(peer.ssrc >>> 0, 8);
      for (let s = 0; s < chunk.length; s++) packet.writeInt16LE(chunk[s] ?? 0, 12 + s * 2);
      peer.seq += 1;
      peer.timestamp += chunk.length;
      try {
        leg.udp.send(packet, peer.port, peer.address);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Feed one RTP packet (unit-test seam; the UDP path calls the same code). */
  feedRtp(channelId: string, packet: Buffer): void {
    const leg = this.legs.get(channelId);
    if (!leg?.saaras) return;
    const pcm = rtpPayload(packet);
    if (pcm.length) {
      try {
        leg.saaras.sendAudio(pcm);
      } catch {
        /* session closing */
      }
    }
  }

  private async teardown(channelId: string): Promise<void> {
    const leg = this.legs.get(channelId);
    this.claimed.delete(channelId);
    if (!leg) return;
    this.hooks.log("info", "ari leg stats", {
      callId: leg.callId,
      role: leg.role,
      rxPackets: leg.rxPackets,
      rxBytes: leg.rxBytes,
      rxByPt: [...leg.rxByPt.entries()].map(([pt, n]) => `${pt}:${n}`).join(","),
      txPackets: leg.txPackets,
      txBytes: leg.txBytes,
      replyPt: this.peers.get(leg.rtpPort)?.pt,
    });
    this.legs.delete(channelId);
    this.peers.delete(leg.rtpPort);
    try {
      leg.saaras?.close();
    } catch {
      /* ignore */
    }
    try {
      leg.udp?.close();
    } catch {
      /* ignore */
    }
    if (leg.role === "operator") {
      // Operator leaves: free only their channel, the emergency leg continues.
      try {
        await this.rest("POST", `channels/${encodeURIComponent(channelId)}/hangup`);
      } catch (err) {
        this.hooks.log("warn", "teardown step failed", { callId: leg.callId, err: String(err) });
      }
      this.hooks.publish("call.ended", leg.callId, { reason: "operator-left" });
      return;
    }
    // Caller leaves: clear joined operators first so nobody listens to dead air.
    for (const [id, other] of [...this.legs]) {
      if (other.role === "operator" && other.bridgeId === leg.bridgeId) {
        this.legs.delete(id);
        this.claimed.delete(id);
        try {
          await this.rest("POST", `channels/${encodeURIComponent(id)}/hangup`);
        } catch {
          /* already gone */
        }
        this.hooks.publish("call.ended", other.callId, { reason: "caller-left" });
      }
    }
    for (const [method, path] of [
      ["DELETE", `bridges/${leg.bridgeId}`],
      ["POST", `channels/${leg.channelId}/hangup`],
      // The fork itself: without this it lingers in Stasis holding its RTP
      // port, and repeated calls exhaust the range (the earlier crash).
      ["POST", `channels/${leg.externalId}/hangup`],
    ] as const) {
      try {
        await this.rest(method, path);
      } catch (err) {
        this.hooks.log("warn", "teardown step failed", { callId: leg.callId, method, path, err: String(err) });
      }
    }
    this.hooks.publish("call.ended", leg.callId, { reason: "ari-hangup" });
  }

  /** Stop reconnects and drop every leg (tests / shutdown). */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const id of [...this.legs.keys()]) await this.teardown(id);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
