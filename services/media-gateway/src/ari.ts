import { createSocket, type Socket as UdpSocket } from "node:dgram";
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
}

interface Leg {
  callId: string;
  channelId: string;
  externalId: string;
  bridgeId: string;
  udp: UdpSocket;
  saaras: RealtimeSession;
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

  /** Connect (and stay connected with backoff). Resolves on first open. */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectDelay = 3000;
    await this.connectOnce();
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
      await this.setupLeg(channelId, exten, caller);
    } catch (err) {
      this.claimed.delete(channelId);
      throw err;
    }
  }

  private async setupLeg(channelId: string, exten: string, caller: string): Promise<void> {
    const callId = `ARI-${channelId.slice(0, 8).toUpperCase()}`;
    this.hooks.publish("call.answered", callId, { via: "ari", exten, caller });

    const saaras = await this.hooks.adapter.connect(callId, {
      onPartial: (text, language) => this.hooks.publish("transcript.partial", callId, { original_text: text, language: language ?? "Unknown" }),
      onFinal: (text, language) => this.hooks.publish("transcript.final", callId, { original_text: text, language: language ?? "Unknown" }),
      onError: (err) => this.hooks.log("warn", "realtime error", { callId, err: String(err) }),
      onClose: () => undefined,
    });

    // One UDP port per call: no SSRC demux needed, trivially testable.
    const rtpPort = this.nextRtpPort++;
    const udp = createSocket("udp4");
    udp.on("message", (msg) => {
      const pcm = rtpPayload(msg);
      if (pcm.length) {
        try {
          saaras.sendAudio(pcm);
        } catch {
          /* session closing */
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(rtpPort, "0.0.0.0", () => resolve());
    });

    await this.rest("POST", `channels/${encodeURIComponent(channelId)}/answer`);
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
    const bridge = await this.rest("POST", "bridges", { type: "mixing" });
    await this.rest("POST", `bridges/${bridge.id}/addChannel`, { channel: [channelId, external.id] });

    this.legs.set(channelId, {
      callId,
      channelId,
      externalId: String(external.id),
      bridgeId: String(bridge.id),
      udp,
      saaras,
    });
    this.hooks.log("info", "ari leg bridged", { callId, exten });
  }

  /** Feed one RTP packet (unit-test seam; the UDP path calls the same code). */
  feedRtp(channelId: string, packet: Buffer): void {
    const leg = this.legs.get(channelId);
    if (!leg) return;
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
    this.legs.delete(channelId);
    try {
      leg.saaras.close();
    } catch {
      /* ignore */
    }
    try {
      leg.udp.close();
    } catch {
      /* ignore */
    }
    for (const [method, path] of [
      ["DELETE", `bridges/${leg.bridgeId}`],
      ["POST", `channels/${leg.channelId}/hangup`],
    ] as const) {
      try {
        await this.rest(method, path);
      } catch {
        /* already gone */
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