import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RealtimeAdapter, RealtimeSession } from "./saaras.js";
import {
  buildFinalPayload,
  buildPartialPayload,
  isPublishableText,
  PartialThrottle,
} from "./transcripts.js";

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
  /** Base URL of the Rakshak API (operator lookup). Defaults to process.env.API_URL. */
  apiUrl?: string;
  /** Ingest key for API calls. Defaults to process.env.EVENT_INGEST_KEY. */
  ingestKey?: string;
  /** TTL for the operator lookup cache (default 60s). */
  lookupTtlMs?: number;
  /** Waiting-room poll interval (default 5000ms). Inject small values in tests. */
  waitRoomPollMs?: number;
  /** Waiting-room max wait (default 10min). Inject small values in tests. */
  waitRoomTimeoutMs?: number;
  createSocket?: (url: string) => SocketLike;
  fetchFn?: typeof fetch;
}

/** Operator directory profile (mirrors GET /api/operators/lookup). */
export interface OperatorProfile {
  operator_id: string;
  default_language: string;
  known_languages: string[];
}

/** Hold message played to operators waiting for a live emergency call. */
export const OPERATOR_HOLD_MESSAGE = "You are connected. Waiting for a live emergency call.";

/** Normalize a raw CLI/caller number to E.164.
 *  Strips non-digits; 10 digits -> prefix +91; otherwise keeps the existing
 *  + prefix (assumes the digits already include a country code). Short
 *  service numbers (e.g. "1001") become "+1001" so lookups stay consistent. */
export function normalizeCli(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const hadPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return "";
  while (digits.length > 10 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (hadPlus) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return `+${digits}`;
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
  onFinalTranscript?: (callId: string, text: string, language: string | undefined, role: LegRole, confidence?: number) => void;
  /** Synthesize speech in the given language code. Returns wav bytes (or null). */
  synthesize?: (text: string, languageCode?: string) => Promise<Buffer | null>;
  /** Fired when a DID-routed operator joins a caller bridge (so the
   *  conversation layer can cache the profile per call at join). */
  onOperatorJoin?: (callerCallId: string, operatorCallId: string, profile: OperatorProfile) => void;
  /** Fired when a leg tears down (so per-call caches can be cleared). */
  onCallTeardown?: (callId: string, role: LegRole, bridgeId: string) => void;
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
  /** ExternalMedia fork for this leg's private STT tap (never in the call bridge). */
  externalId: string;
  /** Snoop channel tapping this leg (spy=in, whisper=none). Never bridged as a caller. */
  snoopId: string;
  /** Private tap bridge holding [snoopId, externalId] for this leg only. */
  tapBridgeId: string;
  bridgeId: string;
  role: LegRole;
  udp: UdpSocket | null;
  saaras: RealtimeSession | null;
  rtpPort: number;
  rxPackets: number;
  rxBytes: number;
  rxByPt: Map<number, number>;
  /** Peak int16 amplitude seen (0 = digital silence the whole call). */
  peak: number;
  /** Packets with peak above speech floor — proves real audio, not zeros. */
  nonSilent: number;
  audioPresent: boolean;
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
  /** Operator lookup cache: E164 -> profile (hit) or null (404). 60s TTL. */
  private readonly lookupCache = new Map<string, { value: OperatorProfile | null; expiresAt: number }>();
  /** Operator profiles cached per call at join: callId or bridgeId -> profile. */
  private readonly operatorProfiles = new Map<string, OperatorProfile>();
  /** Waiting-room poll timers: operator channelId -> timeout. */
  private readonly waitingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Partial throttle: one transcript.partial per call per 200 ms (~5/s) so a
   *  chatty STT never melts the dashboard. Finals bypass it (rare + must land). */
  private readonly partialThrottle = new PartialThrottle();
  /** Toggle-driven conferencing: caller real bridge id -> last applied membership.
   *  Desired membership = !translationToggle (OFF => conferenced, ON+unknown => separated).
   *  Keyed by the caller leg's REAL Asterisk bridge id (1:1 with callerCallId).
   *  Skip redundant REST; cleared on teardown and on new operator joins (so the
   *  next enforcement pass applies to the fresh operator set). */
  private readonly conferenceState = new Map<string, boolean>();

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
      apiUrl: (opts.apiUrl ?? process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, ""),
      ingestKey: opts.ingestKey ?? process.env.EVENT_INGEST_KEY ?? "",
      lookupTtlMs: opts.lookupTtlMs ?? 60_000,
      waitRoomPollMs: opts.waitRoomPollMs ?? 5000,
      waitRoomTimeoutMs: opts.waitRoomTimeoutMs ?? 10 * 60 * 1000,
      createSocket: opts.createSocket,
      fetchFn: opts.fetchFn,
    };
    this.nextRtpPort = this.opts.rtpPortBase;
  }

  /** Operator directory lookup with a 60s TTL cache (hits + 404s).
   *  Never throws: API down / unexpected shape fails CLOSED to null
   *  (caller flow) so emergency calls are never blocked on this. */
  async lookupOperator(mobileE164: string): Promise<OperatorProfile | null> {
    if (!mobileE164) return null;
    const now = Date.now();
    const cached = this.lookupCache.get(mobileE164);
    if (cached && cached.expiresAt > now) return cached.value;
    // Drop expired entries lazily.
    if (cached) this.lookupCache.delete(mobileE164);
    const ttl = this.opts.lookupTtlMs ?? 60_000;
    const apiUrl = (this.opts.apiUrl ?? "").replace(/\/$/, "");
    if (!apiUrl) return null;
    const url = `${apiUrl}/api/operators/lookup?mobile=${encodeURIComponent(mobileE164)}`;
    try {
      const fetchFn = this.opts.fetchFn ?? fetch;
      const headers: Record<string, string> = {};
      const key = this.opts.ingestKey ?? "";
      if (key) headers["x-ingest-key"] = key;
      const res = (await fetchFn(url, { method: "GET", headers } as never)) as unknown as {
        ok: boolean;
        status?: number;
        json: () => Promise<unknown>;
      };
      if (!res.ok) {
        if (res.status === 404) {
          this.lookupCache.set(mobileE164, { value: null, expiresAt: Date.now() + ttl });
        }
        return null;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        return null;
      }
      const data = (body as { data?: unknown } | null)?.data ?? body;
      const rec = data as { operator_id?: unknown; default_language?: unknown; known_languages?: unknown };
      if (rec && typeof rec.operator_id === "string" && rec.operator_id) {
        const profile: OperatorProfile = {
          operator_id: rec.operator_id,
          default_language: typeof rec.default_language === "string" && rec.default_language ? rec.default_language : "en-IN",
          known_languages: Array.isArray(rec.known_languages) ? rec.known_languages.map((x) => String(x)) : [],
        };
        this.lookupCache.set(mobileE164, { value: profile, expiresAt: Date.now() + ttl });
        return profile;
      }
      return null;
    } catch (err) {
      this.hooks.log("warn", "operator lookup failed, failing closed to caller", {
        mobile: mobileE164,
        err: String(err),
      });
      return null;
    }
  }

  /** Profile cached per call at join (operator callId, caller callId or bridgeId). */
  getOperatorProfile(callIdOrBridge: string): OperatorProfile | null {
    return this.operatorProfiles.get(callIdOrBridge) ?? null;
  }

  /** Number of operators currently parked in the waiting room (test seam). */
  waitingCount(): number {
    return this.waitingTimers.size;
  }

  /** Toggle-driven conferencing (spec: translation toggle OFF or known tongue =>
   *  DIRECT CONFERENCE; toggle ON + unknown tongue => SEPARATED).
   *  Desired membership = !toggleEnabled (conversation layer ORs known-tongue),
   *  enforced continuously from finals + join. In-flight utterances finish under
   *  the old state: this only moves bridge membership, never preempts playback.
   *  Failures warn-never-break: a failed add/remove logs and returns, never
   *  throws, never breaks the call loop or teardown. Idempotent: redundant calls
   *  for the same bridge+desired are skipped via conferenceState. */
  async setOperatorConferenced(callerCallId: string, conferenced: boolean): Promise<void> {
    try {
      const callerLeg =
        [...this.legs.values()].find((l) => l.callId === callerCallId) ??
        [...this.legs.values()].find((l) => l.bridgeId === callerCallId && l.role === "caller");
      if (!callerLeg) return;
      const callerBridgeId = callerLeg.bridgeId;
      // No REAL bridge yet (waiting-room placeholder) — nothing to mix.
      if (!callerBridgeId || callerBridgeId.startsWith("waiting-")) return;
      if (this.conferenceState.get(callerBridgeId) === conferenced) return;
      const ops = [...this.legs.values()].filter((l) => l.role === "operator" && l.bridgeId === callerBridgeId);
      if (ops.length === 0) return;
      let allOk = true;
      for (const op of ops) {
        try {
          if (conferenced) {
            await this.rest("POST", `bridges/${encodeURIComponent(callerBridgeId)}/addChannel`, {
              channel: [op.channelId],
            });
          } else {
            await this.rest("POST", `bridges/${encodeURIComponent(callerBridgeId)}/removeChannel`, {
              channel: [op.channelId],
            });
          }
        } catch (err) {
          allOk = false;
          this.hooks.log("warn", "conference membership change failed", {
            callerCallId,
            bridgeId: callerBridgeId,
            opChannel: op.channelId,
            conferenced,
            err: String(err),
          });
        }
      }
      // Only record on full success so the next final retries after a failure.
      if (allOk) this.conferenceState.set(callerBridgeId, conferenced);
    } catch (err) {
      this.hooks.log("warn", "setOperatorConferenced failed", { callerCallId, conferenced, err: String(err) });
    }
  }

  /** Last applied conferencing state for a caller call/bridge (test seam). */
  getConferencedState(callerCallIdOrBridge: string): boolean | undefined {
    const leg = [...this.legs.values()].find(
      (l) => l.callId === callerCallIdOrBridge || l.bridgeId === callerCallIdOrBridge,
    );
    const bridgeId = leg ? leg.bridgeId : callerCallIdOrBridge;
    return this.conferenceState.get(bridgeId);
  }

  /** Number of tracked conference entries (test seam: teardown clears). */
  conferenceCount(): number {
    return this.conferenceState.size;
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
    // Snoop taps enter Stasis too — they are per-leg media pipes, never
    // callers. Forking them would cascade the same way.
    if (channelName.startsWith("Snoop/") || channelName.toLowerCase().startsWith("snoop/")) return;
    // Duplicate StasisStart for a leg we already own: ignore, never double-fork.
    if (this.legs.has(channelId) || this.claimed.has(channelId)) return;
    this.claimed.add(channelId);
    try {
      // DID routing: callers and operators dial the SAME public DID. The only
      // discriminator is the CLI — operators are known mobiles in the directory.
      // Lookup failures fail CLOSED to caller flow (never block emergencies).
      const cli = normalizeCli(caller);
      let profile: OperatorProfile | null = null;
      if (cli) {
        try {
          profile = await this.lookupOperator(cli);
        } catch {
          profile = null;
        }
      }
      if (profile) {
        await this.setupOperatorFlow(channelId, caller, profile);
      } else if (exten === "9002") {
        await this.setupOperator(channelId, caller);
      } else {
        await this.setupLeg(channelId, exten, caller);
      }
    } catch (err) {
      this.claimed.delete(channelId);
      throw err;
    }
  }

  private findNewestCaller(): Leg | null {
    const all = [...this.legs.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const leg = all[i];
      if (leg?.role === "caller") return leg;
    }
    return null;
  }

  /** DID-routed operator flow: answer + STT fork from the start, join the
   *  newest live caller bridge, or park in the waiting room (hold message +
   *  5s poll up to 10min) when nobody is waiting.
   *  Toggle-driven conferencing: the operator channel joins LOGICALLY here
   *  (bridgeId link so bridgePeer() routes translations). Physical mixing is
   *  owned by setOperatorConferenced (translation toggle OFF or known tongue
   *  => added to the caller mixing bridge for direct conference; toggle ON +
   *  unknown tongue => kept out, translation-only renditions via playReply). */
  private async setupOperatorFlow(channelId: string, caller: string, profile: OperatorProfile): Promise<void> {
    const callId = `ARI-OP-${channelId.slice(0, 8).toUpperCase()}`;
    const fork = await this.forkMedia(callId, channelId, "operator");
    await this.rest("POST", `channels/${encodeURIComponent(channelId)}/answer`);
    this.legs.set(channelId, {
      callId,
      channelId,
      externalId: fork.externalId,
      snoopId: fork.snoopId,
      tapBridgeId: fork.tapBridgeId,
      bridgeId: `waiting-${channelId}`,
      role: "operator",
      udp: fork.udp,
      saaras: fork.saaras,
      rtpPort: fork.rtpPort,
      rxPackets: 0,
      rxBytes: 0,
      rxByPt: new Map(),
      peak: 0,
      nonSilent: 0,
      audioPresent: false,
      txPackets: 0,
      txBytes: 0,
    });
    this.operatorProfiles.set(callId, profile);
    this.hooks.publish("call.answered", callId, {
      via: "ari",
      role: "operator",
      caller,
      operator_id: profile.operator_id,
    });
    this.hooks.log("info", "operator answered (DID routing)", { callId, operator: profile.operator_id, caller });
    const target = this.findNewestCaller();
    if (target) {
      try {
        await this.attachOperatorToCaller(channelId, target, profile);
      } catch (err) {
        this.hooks.log("warn", "operator immediate join failed, entering waiting room", {
          callId,
          err: String(err),
        });
        const lang = profile.default_language || "en-IN";
        void this.playReply(channelId, OPERATOR_HOLD_MESSAGE, lang).catch(() => undefined);
        this.hooks.publish("operator.waiting", callId, { operator_id: profile.operator_id });
        this.startWaitingPoll(channelId, profile);
      }
      return;
    }
    const lang = profile.default_language || "en-IN";
    void this.playReply(channelId, OPERATOR_HOLD_MESSAGE, lang).catch(() => undefined);
    this.hooks.publish("operator.waiting", callId, { operator_id: profile.operator_id });
    this.startWaitingPoll(channelId, profile);
  }

  private async attachOperatorToCaller(operatorChannelId: string, target: Leg, profile: OperatorProfile): Promise<void> {
    const leg = this.legs.get(operatorChannelId);
    if (!leg) return;
    // Logical join only: link bridgeId so bridgePeer() routes translations.
    // Physical mixing is owned by setOperatorConferenced (toggle-driven).
    // Reset applied state so the join enforcement pass (conversation layer,
    // toggle defaults false => conference) applies to the fresh operator set
    // instead of being skipped as redundant.
    leg.bridgeId = target.bridgeId;
    this.conferenceState.delete(target.bridgeId);
    const callerCallId = target.callId;
    const operatorCallId = leg.callId;
    this.operatorProfiles.set(operatorCallId, profile);
    this.operatorProfiles.set(callerCallId, profile);
    this.operatorProfiles.set(target.bridgeId, profile);
    try {
      this.hooks.onOperatorJoin?.(callerCallId, operatorCallId, profile);
    } catch {
      /* hook must never break the join */
    }
    try {
      this.hooks.publish("operator.joined", callerCallId, { call_id: callerCallId, operator_id: profile.operator_id });
    } catch {
      /* publish must never break the join */
    }
    this.hooks.log("info", "operator joined emergency bridge", { callId: operatorCallId, joined: callerCallId });
  }

  private startWaitingPoll(operatorChannelId: string, profile: OperatorProfile): void {
    const pollMs = this.opts.waitRoomPollMs ?? 5000;
    const timeoutMs = this.opts.waitRoomTimeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    const existing = this.waitingTimers.get(operatorChannelId);
    if (existing) {
      try {
        clearTimeout(existing);
      } catch {
        /* ignore */
      }
      this.waitingTimers.delete(operatorChannelId);
    }
    const tick = async (): Promise<void> => {
      this.waitingTimers.delete(operatorChannelId);
      const leg = this.legs.get(operatorChannelId);
      if (!leg) return;
      const target = this.findNewestCaller();
      if (target) {
        try {
          await this.attachOperatorToCaller(operatorChannelId, target, profile);
        } catch (err) {
          this.hooks.log("warn", "operator poll join failed", { err: String(err) });
          if (Date.now() < deadline && this.legs.has(operatorChannelId)) {
            const t = setTimeout(() => void tick(), pollMs);
            (t as unknown as { unref?: () => void }).unref?.();
            this.waitingTimers.set(operatorChannelId, t);
          }
        }
        return;
      }
      if (Date.now() >= deadline) {
        try {
          await this.rest("POST", `channels/${encodeURIComponent(operatorChannelId)}/hangup`);
        } catch {
          /* already gone */
        }
        try {
          await this.teardown(operatorChannelId);
        } catch {
          /* ignore */
        }
        return;
      }
      const t = setTimeout(() => void tick(), pollMs);
      (t as unknown as { unref?: () => void }).unref?.();
      this.waitingTimers.set(operatorChannelId, t);
    };
    const first = setTimeout(() => void tick(), pollMs);
    (first as unknown as { unref?: () => void }).unref?.();
    this.waitingTimers.set(operatorChannelId, first);
  }

  /** Operator join (1001 dials 9002): own STT fork like a caller, then linked
   *  to the newest live emergency bridge (logical join; physical mixing is
   *  toggle-driven via setOperatorConferenced).
   *  Operator speech is transcribed with role=operator so it translates
   *  toward the caller — never as incidents.
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
    // Logical join only (toggle-driven mixing via setOperatorConferenced).
    // Reset applied state so join enforcement conferences the fresh leg.
    this.conferenceState.delete(target.bridgeId);
    this.legs.set(channelId, {
      callId,
      channelId,
      externalId: fork.externalId,
      snoopId: fork.snoopId,
      tapBridgeId: fork.tapBridgeId,
      bridgeId: target.bridgeId,
      role: "operator",
      udp: fork.udp,
      saaras: fork.saaras,
      rtpPort: fork.rtpPort,
      rxPackets: 0,
      rxBytes: 0,
      rxByPt: new Map(),
      peak: 0,
      nonSilent: 0,
      audioPresent: false,
      txPackets: 0,
      txBytes: 0,
    });
    this.hooks.publish("call.answered", callId, { via: "ari", role: "operator", joined: target.callId, caller });
    try {
      this.hooks.publish("operator.joined", target.callId, { call_id: target.callId, operator_id: caller || callId });
    } catch {
      /* publish must never break the join */
    }
    this.hooks.log("info", "operator joined emergency bridge", { callId, joined: target.callId });
  }

  /** Shared media fork: Saaras session + one UDP port + per-leg snoop tap.
   *  Role tags every final so caller speech (incidents + replies)
   *  and operator speech (translate-only) route differently.
   *  Snoop design (translation-only, no self-transcription loop):
   *  - spy="in" hears ONLY what this endpoint says, never the bridge mix
   *    or our own TTS playback sent back to it. spy="both" would re-hear
   *    TTS and loop self-transcriptions into the conversation.
   *  - whisper="none" never injects tap audio back into the call.
   *  - The snoop + ExternalMedia live in a private tap bridge per leg,
   *    never in the call bridge. STT hears exactly its own leg's raw audio. */
  private async forkMedia(
    callId: string,
    channelId: string,
    role: LegRole,
  ): Promise<{ udp: UdpSocket; saaras: RealtimeSession; rtpPort: number; externalId: string; snoopId: string; tapBridgeId: string }> {
    let evCount = 0;
    const saaras = await this.hooks.adapter.connect(callId, {
      onPartial: (text, language) => {
        // Contract: original_text always a string, language falls back to
        // "Unknown", role tags the leg, callId is this leg's call. Blank
        // frames never publish; faster-than-5/s frames coalesce.
        if (!isPublishableText(text)) return;
        if (!this.partialThrottle.shouldSend(callId)) return;
        this.hooks.publish("transcript.partial", callId, buildPartialPayload(text, language, role));
      },
      onFinal: (text, language, confidence) => {
        if (!isPublishableText(text)) return;
        // Finals always land (no throttle) and re-arm the partial window so
        // the next partial after a final is immediate, not swallowed.
        this.partialThrottle.reset(callId);
        this.hooks.publish("transcript.final", callId, buildFinalPayload(text, language, role, confidence));
        try {
          this.hooks.onFinalTranscript?.(callId, text, language, role, confidence);
        } catch (err) {
          this.hooks.log("warn", "final handler failed", { callId, err: String(err) });
        }
      },
      onError: (err) => this.hooks.log("warn", "realtime error", { callId, err: String(err) }),
      onClose: () => this.hooks.log("warn", "realtime closed", { callId }),
      onEvent: (e) => {
        if (evCount < 40) {
          this.hooks.log("info", "saaras event", { callId, n: evCount, event: e });
        }
        evCount++;
      },
    });
    this.hooks.log("info", "realtime session open", { callId });
    // Any step below can throw (UDP bind, ARI errors). Track creations so the
    // catch cleans up: otherwise Saaras sessions, UDP ports and tap bridges
    // leak on every failed fork (billing + port exhaustion).
    let externalId = "";
    let snoopId = "";
    let tapBridgeId = "";
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
        // Audio-content probe: peak amplitude distinguishes real speech from
        // a stream of digital zeros (which counts packets but feeds STT silence).
        let peak = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) {
          const s = pcm.readInt16LE(i);
          const a = s < 0 ? -s : s;
          if (a > peak) peak = a;
        }
        if (peak > leg.peak) leg.peak = peak;
        if (peak > 500) {
          leg.nonSilent += 1;
          if (!leg.audioPresent) {
            leg.audioPresent = true;
            const samples: number[] = [];
            for (let i = 0; i + 1 < pcm.length && samples.length < 12; i += 2) {
              samples.push(pcm.readInt16LE(i));
            }
            this.hooks.log("info", "caller audio present", { callId: leg.callId, peak, samples: samples.join(",") });
          }
        }
        try {
          leg.saaras.sendAudio(pcm);
        } catch {
          /* session closing */
        }
      }
    });
    // From here on every step can throw (UDP bind, ARI errors) — the catch
    // below cleans up creations so failed forks leak nothing.
    try {
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
    externalId = String(external.id);
    // Per-leg tap: snoop THIS leg channel, then bridge snoop+fork privately.
    // The tap bridge is separate from the call bridge — the fork never hears
    // bridge mix or TTS playback.
    const snoop = await this.rest("POST", `channels/${encodeURIComponent(channelId)}/snoop`, {
      app: this.opts.app,
      spy: "in",
      whisper: "none",
    });
    snoopId = String(snoop.id);
    const tapBridge = await this.rest("POST", "bridges", { type: "mixing" });
    tapBridgeId = String(tapBridge.id);
    await this.rest("POST", `bridges/${tapBridgeId}/addChannel`, { channel: [snoopId, externalId] });
    } catch (err) {
      this.hooks.log("warn", "fork setup failed, cleaning up", { callId, err: String(err) });
      try {
        saaras.close();
      } catch {
        /* ignore */
      }
      try {
        udp.close();
      } catch {
        /* ignore */
      }
      for (const [method, path] of [
        ...(snoopId ? [["POST", `channels/${snoopId}/hangup`] as const] : []),
        ...(externalId ? [["POST", `channels/${externalId}/hangup`] as const] : []),
        ...(tapBridgeId ? [["DELETE", `bridges/${tapBridgeId}`] as const] : []),
      ]) {
        try {
          await this.rest(method, path);
        } catch {
          /* best effort */
        }
      }
      throw err;
    }
    return { udp, saaras, rtpPort, externalId, snoopId, tapBridgeId };
  }

  private async setupLeg(channelId: string, exten: string, caller: string): Promise<void> {
    const callId = `ARI-${channelId.slice(0, 8).toUpperCase()}`;
    this.hooks.publish("call.answered", callId, { via: "ari", exten, caller });

    const fork = await this.forkMedia(callId, channelId, "caller");

    await this.rest("POST", `channels/${encodeURIComponent(channelId)}/answer`);
    const bridge = await this.rest("POST", "bridges", { type: "mixing" });
    // Caller bridge holds ONLY the caller channel. The STT fork lives in its
    // own per-leg tap bridge (snoop+ExternalMedia) so TTS playback into the
    // caller channel never loops back into STT.
    await this.rest("POST", `bridges/${bridge.id}/addChannel`, { channel: [channelId] });

    this.legs.set(channelId, {
      callId,
      channelId,
      externalId: fork.externalId,
      snoopId: fork.snoopId,
      tapBridgeId: fork.tapBridgeId,
      bridgeId: String(bridge.id),
      role: "caller",
      udp: fork.udp,
      saaras: fork.saaras,
      rtpPort: fork.rtpPort,
      rxPackets: 0,
      rxBytes: 0,
      rxByPt: new Map(),
      peak: 0,
      nonSilent: 0,
      audioPresent: false,
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
    const wt = this.waitingTimers.get(channelId);
    if (wt) {
      try {
        clearTimeout(wt);
      } catch {
        /* ignore */
      }
      this.waitingTimers.delete(channelId);
    }
    const leg = this.legs.get(channelId);
    this.claimed.delete(channelId);
    if (!leg) return;
    this.hooks.log("info", "ari leg stats", {
      callId: leg.callId,
      role: leg.role,
      rxPackets: leg.rxPackets,
      rxBytes: leg.rxBytes,
      rxByPt: [...leg.rxByPt.entries()].map(([pt, n]) => `${pt}:${n}`).join(","),
      peak: leg.peak,
      nonSilent: leg.nonSilent,
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
      // Operator leaves: free only their channel + private tap, the emergency leg continues.
      // Clear conferencing state when no operators remain on the bridge so the
      // next join enforcement re-applies instead of skipping as redundant.
      // A failed clear must never break teardown (Map.delete never throws).
      const opBridge = leg.bridgeId;
      this.operatorProfiles.delete(leg.callId);
      try {
        this.hooks.onCallTeardown?.(leg.callId, leg.role, leg.bridgeId);
      } catch {
        /* hook must never break teardown */
      }
      for (const [method, path] of [
        ["POST", `channels/${encodeURIComponent(channelId)}/hangup`],
        // Private tap: snoop + fork + tap bridge. Without this the fork
        // lingers in Stasis holding its RTP port (the earlier crash).
        ...(leg.snoopId ? [["POST", `channels/${encodeURIComponent(leg.snoopId)}/hangup`] as const] : []),
        ...(leg.externalId ? [["POST", `channels/${encodeURIComponent(leg.externalId)}/hangup`] as const] : []),
        ...(leg.tapBridgeId ? [["DELETE", `bridges/${leg.tapBridgeId}`] as const] : []),
      ] as const) {
        try {
          await this.rest(method, path);
        } catch (err) {
          this.hooks.log("warn", "teardown step failed", { callId: leg.callId, method, path, err: String(err) });
        }
      }
      this.hooks.publish("call.ended", leg.callId, { reason: "operator-left" });
      try {
        const stillJoined = [...this.legs.values()].some((l) => l.role === "operator" && l.bridgeId === opBridge);
        if (!stillJoined) this.conferenceState.delete(opBridge);
      } catch {
        /* never break teardown */
      }
      return;
    }
    // Caller leaves: clear joined operators first so nobody listens to dead air.
    const callerCallId = leg.callId;
    const bridgeId = leg.bridgeId;
    for (const [id, other] of [...this.legs]) {
      if (other.role === "operator" && other.bridgeId === bridgeId) {
        const w = this.waitingTimers.get(id);
        if (w) {
          try {
            clearTimeout(w);
          } catch {
            /* ignore */
          }
          this.waitingTimers.delete(id);
        }
        this.legs.delete(id);
        this.claimed.delete(id);
        this.operatorProfiles.delete(other.callId);
        this.peers.delete(other.rtpPort);
        try {
          other.saaras?.close();
        } catch {
          /* ignore */
        }
        try {
          other.udp?.close();
        } catch {
          /* ignore */
        }
        try {
          this.hooks.onCallTeardown?.(other.callId, other.role, bridgeId);
        } catch {
          /* ignore */
        }
        for (const [method, path] of [
          ["POST", `channels/${encodeURIComponent(id)}/hangup`],
          ...(other.snoopId ? [["POST", `channels/${encodeURIComponent(other.snoopId)}/hangup`] as const] : []),
          ...(other.externalId ? [["POST", `channels/${encodeURIComponent(other.externalId)}/hangup`] as const] : []),
          ...(other.tapBridgeId ? [["DELETE", `bridges/${other.tapBridgeId}`] as const] : []),
        ] as const) {
          try {
            await this.rest(method, path);
          } catch {
            /* already gone */
          }
        }
        this.hooks.publish("call.ended", other.callId, { reason: "caller-left" });
      }
    }
    // Clear per-call caches (toggle entries live in conversation via the hook;
    // profile entries live here; conferencing membership here).
    this.operatorProfiles.delete(callerCallId);
    this.operatorProfiles.delete(bridgeId);
    try {
      this.conferenceState.delete(bridgeId);
      this.conferenceState.delete(callerCallId);
    } catch {
      /* never break teardown */
    }
    try {
      this.hooks.onCallTeardown?.(callerCallId, leg.role, bridgeId);
    } catch {
      /* ignore */
    }
    for (const [method, path] of [
      ["DELETE", `bridges/${leg.bridgeId}`],
      ["POST", `channels/${leg.channelId}/hangup`],
      // The fork itself: without this it lingers in Stasis holding its RTP
      // port, and repeated calls exhaust the range (the earlier crash).
      // Plus the per-leg snoop tap (snoop channel + tap bridge).
      ...(leg.externalId ? [["POST", `channels/${leg.externalId}/hangup`] as const] : []),
      ...(leg.snoopId ? [["POST", `channels/${leg.snoopId}/hangup`] as const] : []),
      ...(leg.tapBridgeId ? [["DELETE", `bridges/${leg.tapBridgeId}`] as const] : []),
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
    for (const [, t] of [...this.waitingTimers]) {
      try {
        clearTimeout(t);
      } catch {
        /* ignore */
      }
    }
    this.waitingTimers.clear();
    for (const id of [...this.legs.keys()]) await this.teardown(id);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
