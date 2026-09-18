// saaras-probe.mjs — minimal Sarvam realtime-session check, no app code.
// Streams audio at 16kHz linear16 mono in 20ms chunks (like the gateway fork)
// and prints EVERY server event. Decides: is the session alive or deaf?
//
//   SARVAM_API_KEY=... node scripts/saaras-probe.mjs [--tts "मराठी वाक्य" | file.wav]
//
// Modes: synthetic AM-noise bursts (default), --tts (real Marathi TTS audio
// generated via Sarvam bulbul:v3, resampled to 16k), or a file (.wav parsed,
// anything else treated as raw s16le).
//
// Key lookup: $SARVAM_API_KEY, else SARVAM_API_KEY= line in
// /opt/rakshak/gateway.env (voice-box runs as the asterisk user).
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

function loadKey() {
  const env = (process.env.SARVAM_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  if (env) return env;
  try {
    const f = readFileSync("/opt/rakshak/gateway.env", "utf8");
    const m = f.match(/^SARVAM_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* not on the voice box */ }
  return "";
}
const KEY = loadKey();
if (!KEY) {
  console.error("SARVAM_API_KEY is not set (and no /opt/rakshak/gateway.env)");
  process.exit(1);
}

const SR = 16000;
const CHUNK = 640; // 20ms of 16kHz s16le — same as the gateway fork

function synthBursts(seconds = 4) {
  const n = SR * seconds;
  const out = new Int16Array(n);
  let seed = 123456789;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const gate = t % 1.0 < 0.5 ? 1 : 0.05; // 0.5s on/off — speech-like energy envelope
    const v = (rnd() * 0.6 + Math.sin(2 * Math.PI * 220 * t) * 0.4) * gate;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 20000)));
  }
  return Buffer.from(out.buffer);
}

// Parse a wav file -> mono int16 samples + rate (never assumes 44 bytes).
function parseWav(buf) {
  if (buf.subarray(0, 4).toString() !== "RIFF") throw new Error("not a wav");
  let off = 12;
  let rate = 0, ch = 0, bits = 0, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt " && size >= 16) {
      ch = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!data || !rate || !bits) throw new Error("wav missing fmt/data");
  if (bits !== 16) throw new Error(`only 16-bit wav supported, got ${bits}`);
  const frames = Math.floor(data.length / 2 / ch);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2);
    mono[i] = Math.round(s / ch);
  }
  return { samples: mono, rate };
}

function resample16(mono, fromRate) {
  if (fromRate === SR) return Buffer.from(mono.buffer);
  const out = new Int16Array(Math.floor((mono.length * SR) / fromRate));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * fromRate) / SR;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = mono[i0] ?? 0;
    const b = mono[Math.min(i0 + 1, mono.length - 1)] ?? 0;
    out[i] = Math.round(a + (b - a) * f);
  }
  return Buffer.from(out.buffer);
}

async function ttsAudio(text) {
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-subscription-key": KEY },
    body: JSON.stringify({ text, target_language_code: "mr-IN", speaker: "shubh", model: "bulbul:v3" }),
  });
  if (!res.ok) throw new Error(`tts failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const b64 = (body?.audios?.[0] ?? "").split(",").pop();
  if (!b64) throw new Error("tts returned no audio");
  const wav = Buffer.from(b64, "base64");
  const { samples, rate } = parseWav(wav);
  console.log(`tts wav: ${samples.length} samples @ ${rate}Hz -> resampling to ${SR}Hz`);
  return resample16(samples, rate);
}

async function main() {
  const args = process.argv.slice(2);
  let audio;
  if (args[0] === "--tts") {
    audio = await ttsAudio(args.slice(1).join(" ") || "रक्षक आपत्कालीन सेवा. कृपया आपले ठिकाण सांगा.");
  } else if (args[0]) {
    const buf = readFileSync(args[0]);
    audio = args[0].endsWith(".wav") ? resample16(...(() => { const p = parseWav(buf); return [p.samples, p.rate]; })()) : buf;
  } else {
    audio = synthBursts();
  }
  console.log(`sending ${audio.length} bytes (${(audio.length / 2 / SR).toFixed(2)}s of 16kHz s16le)`);

  const params = new URLSearchParams({
    language_code: "auto",
    model: "saaras:v3-realtime",
    stream_type: "fast",
    encoding: "linear16",
    sample_rate: String(SR),
  });
  const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text-realtime/ws?${params}`, {
    headers: { "api-subscription-key": KEY },
  });

  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
  ws.on("open", () => {
    console.log(`${stamp()} ws open`);
    let off = 0;
    const timer = setInterval(() => {
      if (off >= audio.length) {
        clearInterval(timer);
        ws.send(JSON.stringify({ event: "end" }));
        setTimeout(() => process.exit(0), 4000);
        return;
      }
      ws.send(JSON.stringify({ event: "audio_input", audio: audio.subarray(off, off + CHUNK).toString("base64") }));
      off += CHUNK;
    }, 20);
  });
  ws.on("message", (raw) => console.log(`${stamp()} SERVER: ${String(raw).slice(0, 300)}`));
  ws.on("error", (e) => console.log(`${stamp()} WS-ERROR: ${e.message}`));
  ws.on("close", (c, r) => console.log(`${stamp()} WS-CLOSE: ${c} ${String(r).slice(0, 120)}`));
  setTimeout(() => {
    console.log("TIMEOUT — no final, closing");
    process.exit(2);
  }, 30000);
}

main().catch((e) => {
  console.error(`PROBE FAILED: ${e.message}`);
  process.exit(1);
});
