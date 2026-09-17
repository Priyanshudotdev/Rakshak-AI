import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager } from "./session.js";
import { AriController } from "./ari.js";
import { createAdapter } from "./saaras.js";

// Media Gateway (spec §7): Asterisk media <-> Sarvam STT transport + session mgmt.
// Replay/file mode (current): WS audio intake -> session buffer -> API batch endpoint.
// Realtime mode (Asterisk phase): Saaras Realtime adapter streams partials.
//
// WS protocol (text frames are JSON, binary frames are audio chunks):
//   {type:"start", callId?, from?, to?}   (re)start a session
//   {type:"partial", text, language?}      relay a live partial transcript
//   {type:"finalize", filename?}           process buffered audio via the API
//   {type:"tts-stop"}                      barge-in: caller spoke over TTS
//   {type:"end", reason?}                  close the call leg
// Connect at /gateway/audio?callId=CALL_xxx (auto-starts the session).

const PORT = Number(process.env.PORT ?? 3002);
const API_URL = process.env.API_URL ?? "http://localhost:3001";
const INGEST_KEY = process.env.EVENT_INGEST_KEY ?? "";
const IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 60_000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 200);

const sessions = new SessionManager(MAX_SESSIONS);
const adapter = createAdapter();

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields }));
}

async function publish(name: string, callId: string, payload: unknown): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/api/events/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INGEST_KEY ? { "x-ingest-key": INGEST_KEY } : {}),
      },
      body: JSON.stringify({ name, callId, payload }),
    });
    if (!res.ok) log("warn", "event publish rejected", { name, callId, status: res.status });
  } catch (err) {
    log("warn", "event publish failed", { name, callId, err: String(err) });
  }
}

async function finalize(callId: string, filename?: string): Promise<void> {
  const drained = sessions.takeAudio(callId);
  if (!drained) return;
  const form = new FormData();
  form.append("file", new Blob([drained.bytes as unknown as BlobPart]), filename || "gateway.webm");
  try {
    const res = await fetch(`${API_URL}/api/process-audio?callId=${encodeURIComponent(callId)}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      log("warn", "process-audio rejected", { callId, status: res.status });
      return;
    }
    const body = (await res.json()) as { data?: { transcript_original?: string; original_language?: string; id?: string } };
    await publish("transcript.final", callId, {
      original_text: body.data?.transcript_original ?? "",
      language: body.data?.original_language ?? "Unknown",
      record_id: body.data?.id,
    });
  } catch (err) {
    log("warn", "finalize failed", { callId, err: String(err) });
  }
}

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "media-gateway", mode: adapter.kind === "passthrough" ? "replay" : "realtime", sessions: sessions.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, path: "/gateway/audio" });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryId = url.searchParams.get("callId") ?? `CALL-${Date.now().toString(36).toUpperCase()}`;
  let callId = queryId;
  const marker = ws as unknown as { isAlive?: boolean };
  marker.isAlive = true;
  ws.on("pong", () => {
    marker.isAlive = true;
  });

  try {
    sessions.start(callId);
  } catch {
    ws.close(1008, "gateway at capacity");
    return;
  }
  void publish("call.started", callId, { via: "gateway", mode: "replay" });
  // Keep one realtime adapter session per call leg for the Asterisk phase.
  void adapter.connect(callId, {
    onPartial: (text, language) => {
      void publish("transcript.partial", callId, { original_text: text, language: language ?? "Unknown" });
    },
    onFinal: (text, language) => {
      void publish("transcript.final", callId, { original_text: text, language: language ?? "Unknown" });
    },
    onError: (err) => log("warn", "realtime error", { callId, err: String(err) }),
    onClose: () => undefined,
  }).catch((err) => log("warn", "realtime connect failed", { callId, err: String(err) }));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const ok = sessions.pushAudio(callId, data as Buffer);
      if (!ok) {
        void publish("call.ended", callId, { reason: "buffer-overflow" });
        ws.close(1009, "session buffer full");
      }
      return;
    }
    let frame: { type?: string; [k: string]: unknown };
    try {
      frame = JSON.parse(String(data)) as typeof frame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "start": {
        const id = typeof frame.callId === "string" && frame.callId ? frame.callId : callId;
        try {
          sessions.start(id, frame.from as string | undefined, frame.to as string | undefined);
        } catch {
          ws.close(1008, "gateway at capacity");
          return;
        }
        callId = id;
        void publish("call.answered", callId, {});
        break;
      }
      case "partial": {
        if (typeof frame.text === "string" && frame.text) {
          sessions.markPartial(callId);
          void publish("transcript.partial", callId, {
            original_text: frame.text,
            language: (frame.language as string | undefined) ?? "Unknown",
          });
        }
        break;
      }
      case "finalize": {
        sessions.touch(callId);
        void finalize(callId, frame.filename as string | undefined);
        break;
      }
      case "tts-stop": {
        // Barge-in: caller spoke while TTS was playing — stop outgoing audio.
        if (sessions.stopTts(callId)) void publish("speech.started", callId, { barge_in: true });
        break;
      }
      case "end": {
        const ended = sessions.end(callId);
        if (ended) void publish("call.ended", callId, { reason: (frame.reason as string | undefined) ?? "client-hangup" });
        ws.close(1000, "bye");
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    const ended = sessions.end(callId);
    if (ended) void publish("call.ended", callId, { reason: "transport-close" });
  });
});

setInterval(() => {
  for (const client of wss.clients) {
    const marker = client as unknown as { isAlive?: boolean };
    if (marker.isAlive === false) {
      client.terminate();
      continue;
    }
    marker.isAlive = false;
    client.ping();
  }
}, 30_000);

setInterval(() => {
  const idle = sessions.sweepIdle(IDLE_MS);
  for (const session of idle) {
    void publish("call.ended", session.callId, { reason: "idle-timeout" });
  }
  if (idle.length) log("info", "swept idle sessions", { count: idle.length });
}, 15_000);

// Realtime legs (REALTIME=saaras): answer ARI Stasis calls and fork caller
// audio into the Saaras adapter. Replay mode keeps the WS batch path above.
let ari: AriController | null = null;

/** Reply voice follows the CALLER's language (spec §5): Marathi, Hindi or
 *  English — detected per utterance, Marathi default. */
function replyVoice(language?: string): { code: string; ack: string; confirm: (incident?: string) => string } {
  const lang = (language ?? "").toLowerCase();
  if (lang.startsWith("hi") || lang.includes("hindi")) {
    return {
      code: "hi-IN",
      ack: "जानकारी मिल गई है, जाँच रहे हैं।",
      confirm: (incident) =>
        incident && incident !== "Unknown"
          ? `आपकी रिपोर्ट दर्ज हो गई है। ${incident} के लिए मदद भेज रहे हैं।`
          : "आपकी रिपोर्ट दर्ज हो गई है, मदद जल्द पहुँचेगी।",
    };
  }
  if (lang.startsWith("en") || lang.includes("english")) {
    return {
      code: "en-IN",
      ack: "Got it, checking now.",
      confirm: (incident) =>
        incident && incident !== "Unknown"
          ? `Your report is recorded. Help is on the way for the ${incident}.`
          : "Your report is recorded, help will arrive soon.",
    };
  }
  return {
    code: "mr-IN",
    ack: "माहिती मिळाली, तपासत आहे.",
    confirm: (incident) =>
      incident && incident !== "Unknown"
        ? `आपली तक्रार नोंदवली आहे. ${incident} साठी मदत पाठवत आहोत.`
        : "आपली तक्रार नोंदवली आहे, मदत लवकरच पोहोचेल.",
  };
}

/** Full loop for one final transcript: understand via process-call, then speak
 *  a calm reply back into the caller's ear, in their language. All best-effort. */
async function handleFinal(callId: string, text: string, language?: string): Promise<void> {
  if (!ari || !text.trim()) return;
  const channelId = ari.channelForCall(callId);
  if (!channelId) return;
  const voice = replyVoice(language);
  try {
    await speak(channelId, voice.ack, voice.code);
    const res = await fetch(`${API_URL}/api/process-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text, language: language ?? "Marathi" }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      data?: { extraction?: { incident_type?: string }; priority?: { level?: string } };
    };
    await speak(channelId, voice.confirm(body.data?.extraction?.incident_type), voice.code);
  } catch (err) {
    log("warn", "final-loop failed", { callId, err: String(err) });
  }
}

async function synthesizeSpeech(text: string, languageCode = "mr-IN"): Promise<Buffer | null> {
  try {
    const res = await fetch(`${API_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language_code: languageCode }),
    });
    if (!res.ok) {
      log("warn", "tts synth rejected", { status: res.status });
      return null;
    }
    const body = (await res.json()) as { data?: { audio_base64?: string } };
    const b64 = (body.data?.audio_base64 ?? "").split(",", 2)[1] ?? "";
    if (!b64) {
      log("warn", "tts synth empty");
      return null;
    }
    return Buffer.from(b64, "base64");
  } catch (err) {
    log("warn", "tts synth failed", { err: String(err) });
    return null;
  }
}

async function speak(channelId: string, text: string, languageCode = "mr-IN"): Promise<void> {
  if (!ari) return;
  await ari.playReply(channelId, text, languageCode);
}

if (adapter.kind === "saaras-realtime") {
  ari = new AriController(
    {
      publish,
      log,
      adapter,
      synthesize: synthesizeSpeech,
      onFinalTranscript: (callId, text, language) => {
        void handleFinal(callId, text, language);
      },
    },
    {},
  );
  ari.start().catch((err) => log("warn", "ari controller failed", { err: String(err) }));
}

http.listen(PORT, () => {
  log("info", `media-gateway listening on :${PORT}`, { mode: adapter.kind, api: API_URL });
});
