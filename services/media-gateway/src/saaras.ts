// Sarvam Saaras Realtime adapter boundary (spec §8).
//
// The live path (Asterisk External Media → Saaras Realtime → partials) plugs in
// here in the Asterisk phase. Until then the gateway runs in replay/file mode:
// it accepts complete audio over WS, forwards it to the API batch endpoint,
// and relays client- or STT-provided partial frames as transcript.partial events.
//
// This file intentionally contains no fake STT — partials are only emitted
// when a real source (client mic agent or Saaras session) provides them.

export interface RealtimeCallbacks {
  onPartial: (text: string, language?: string) => void;
  onFinal: (text: string, language?: string, confidence?: number) => void;
  onError: (err: Error) => void;
  onClose: () => void;
  /** Raw server event tap (diagnostics): fired for every parsed message. */
  onEvent?: (event: string) => void;
}

export interface RealtimeSession {
  sendAudio(_chunk: Uint8Array): void;
  close(): void;
}

export interface RealtimeAdapter {
  readonly kind: string;
  connect(_callId: string, _cb: RealtimeCallbacks): Promise<RealtimeSession>;
}

/** Pass-through adapter: relays externally provided partials, performs no recognition. */
export class PassthroughAdapter implements RealtimeAdapter {
  readonly kind = "passthrough";
  async connect(_callId: string, _cb: RealtimeCallbacks): Promise<RealtimeSession> {
    return {
      sendAudio() {
        /* buffered by the session manager for finalize */
      },
      close() {
        /* nothing held */
      },
    };
  }
}

export interface SaarasRealtimeOptions {
  /** Override for tests / private endpoints. */
  url?: string;
  /** BCP-47 code or "auto". Default "auto" (code-mixed emergency speech). */
  languageCode?: string;
  /** Partial latency/accuracy tradeoff. Default "fast" (barge-in matters). */
  streamType?: "fast" | "balanced" | "simulated";
  /** 8000 (telephony) or 16000. Must match the PCM actually sent. */
  sampleRate?: 8000 | 16000;
  /** VAD sensitivity 0.0-1.0. Sent only when set (server default rules). */
  threshold?: number;
  /** End-of-speech silence ms. Sent only when set. */
  silenceDurationMs?: number;
  /** Minimum speech ms per utterance. Sent only when set. */
  minSpeechDurationMs?: number;
  /** Socket factory; default is the `ws` package. Injected in tests. */
  createSocket?: (url: string, opts: { headers: Record<string, string> }) => SocketLike;
}

/** Minimal surface of `ws` the adapter needs (unit-test seam). */
export interface SocketLike {
  on(event: "open" | "message" | "error" | "close", cb: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
}

const REALTIME_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

/** Live adapter: Asterisk/mic linear16 PCM → Saaras `saaras:v3-realtime` → partials/finals.
 *  `sendAudio` takes raw mono linear16 PCM bytes at the configured sample rate
 *  (NOT wav — strip the 44-byte header before sending). */
export class SaarasRealtimeAdapter implements RealtimeAdapter {
  readonly kind = "saaras-realtime";
  private readonly opts: Required<Omit<SaarasRealtimeOptions, "createSocket" | "threshold" | "silenceDurationMs" | "minSpeechDurationMs">> &
    Pick<SaarasRealtimeOptions, "createSocket" | "threshold" | "silenceDurationMs" | "minSpeechDurationMs">;

  constructor(opts: SaarasRealtimeOptions = {}) {
    this.opts = {
      url: opts.url ?? REALTIME_URL,
      languageCode: opts.languageCode ?? "auto",
      streamType: opts.streamType ?? "fast",
      sampleRate: opts.sampleRate ?? 16000,
      threshold: opts.threshold,
      silenceDurationMs: opts.silenceDurationMs,
      minSpeechDurationMs: opts.minSpeechDurationMs,
      createSocket: opts.createSocket,
    };
  }

  async connect(callId: string, cb: RealtimeCallbacks): Promise<RealtimeSession> {
    const key = (process.env.SARVAM_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
    if (!key) throw new Error("SARVAM_API_KEY is not set — cannot open Saaras realtime session");
    const params = new URLSearchParams({
      language_code: this.opts.languageCode,
      model: "saaras:v3-realtime",
      stream_type: this.opts.streamType,
      encoding: "linear16",
      sample_rate: String(this.opts.sampleRate),
    });
    // VAD knobs are connection-only and optional: absent = server defaults.
    // Set them (env GATEWAY_VAD_* on the voice box) only for noisy-line tuning.
    if (this.opts.threshold !== undefined) params.set("threshold", String(this.opts.threshold));
    if (this.opts.silenceDurationMs !== undefined) params.set("silence_duration_ms", String(this.opts.silenceDurationMs));
    if (this.opts.minSpeechDurationMs !== undefined) params.set("min_speech_duration_ms", String(this.opts.minSpeechDurationMs));
    const url = `${this.opts.url}?${params}`;
    // Lazy import keeps unit tests (injected factory) free of the `ws` package.
    const { WebSocket } = await import("ws");
    const ws: SocketLike = this.opts.createSocket
      ? this.opts.createSocket(url, { headers: { "api-subscription-key": key } })
      : (new WebSocket(url, { headers: { "api-subscription-key": key } }) as unknown as SocketLike);

    let closed = false;
    let sendFailed = false;
    const session: RealtimeSession = {
      sendAudio(chunk: Uint8Array) {
        if (closed) return;
        try {
          ws.send(JSON.stringify({ event: "audio_input", audio: Buffer.from(chunk).toString("base64") }));
        } catch (err) {
          // Tripwire: a dead-but-never-closed socket would otherwise drop
          // every packet silently (callers of sendAudio swallow errors).
          if (!sendFailed) {
            sendFailed = true;
            cb.onError(err instanceof Error ? err : new Error(`saaras send failed: ${String(err)}`));
          }
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          ws.send(JSON.stringify({ event: "end" }));
        } catch {
          /* closing anyway */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => resolve();
      const onError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
      ws.on("open", onOpen);
      ws.on("error", onError);
    });

    ws.on("message", (raw: unknown) => {
      let msg: { event?: string; text?: string; language?: string; language_confidence?: number; code?: string | number; is_fatal?: boolean; message?: string };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      try {
        cb.onEvent?.(msg.event ?? "?");
      } catch {
        /* tap must never break the session */
      }
      switch (msg.event) {
        case "transcript.partial":
          if (msg.text) cb.onPartial(msg.text, msg.language);
          break;
        case "transcript.final":
          if (msg.text) cb.onFinal(msg.text, msg.language, msg.language_confidence);
          break;
        case "error":
          cb.onError(new Error(`Saaras realtime ${msg.code ?? ""}: ${msg.message ?? "unknown error"}`.trim()));
          if (msg.is_fatal) session.close();
          break;
        case "session.end":
          session.close();
          break;
        default:
          break; // session.begin, vad.*, pong, config.updated need no action
      }
    });
    ws.on("error", (err: unknown) => cb.onError(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () => {
      closed = true;
      cb.onClose();
    });
    void callId;
    return session;
  }
}

function numEnv(name: string): number | undefined {
  const v = (process.env[name] ?? "").trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function createAdapter(): RealtimeAdapter {
  // REALTIME=saaras opens a live Saaras session per call leg (needs SARVAM_API_KEY
  // + 16k/8k linear16 PCM from Asterisk/mic). Anything else keeps replay/file mode.
  if ((process.env.REALTIME ?? "").toLowerCase() === "saaras") {
    return new SaarasRealtimeAdapter({
      threshold: numEnv("GATEWAY_VAD_THRESHOLD"),
      silenceDurationMs: numEnv("GATEWAY_VAD_SILENCE_MS"),
      minSpeechDurationMs: numEnv("GATEWAY_VAD_MIN_SPEECH_MS"),
    });
  }
  return new PassthroughAdapter();
}
