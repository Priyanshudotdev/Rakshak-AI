import { isEnglish, languageName } from "./languages.js";
import { withTimeout } from "./timeout.js";

const BASE = "https://api.sarvam.ai";
const STT_TIMEOUT = 35_000;
const TEXT_TIMEOUT = 25_000;
const TTS_TIMEOUT = 40_000;

function key(): string {
  const k = (process.env.SARVAM_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  if (!k) throw new Error("SARVAM_API_KEY is not set");
  return k;
}

async function postJson(path: string, body: unknown, timeoutMs: number, label: string): Promise<any> {
  return withTimeout(async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-subscription-key": key() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }, timeoutMs, label);
}

export async function identifyLanguage(text: string): Promise<{ language_code?: string; language: string; script_code?: string; confidence: number }> {
  const data = await postJson("/text-lid", { input: text.slice(0, 1000) }, TEXT_TIMEOUT, "language detection");
  const code = data?.language_code as string | undefined;
  return {
    language_code: code,
    language: languageName(code),
    script_code: data?.script_code,
    confidence: Number(data?.language_probability ?? 0.9),
  };
}

function translateModel(source: string): string {
  return source === "auto" ? "mayura:v1" : "sarvam-translate:v1";
}

export async function translateToEnglish(text: string, sourceLanguageCode?: string | null): Promise<string> {
  if (!text.trim() || isEnglish(sourceLanguageCode)) return text;
  let source = sourceLanguageCode || "auto";
  if (source === "unknown") source = "auto";
  const data = await postJson("/translate", {
    input: text.slice(0, 2000),
    source_language_code: source,
    target_language_code: "en-IN",
    model: translateModel(source),
  }, TEXT_TIMEOUT, "translation to english");
  return data?.translated_text ?? text;
}

export async function translateToMarathi(text: string, sourceLanguageCode?: string | null): Promise<string> {
  if (!text.trim()) return text;
  if (sourceLanguageCode && ["mr", "mr-in"].includes(sourceLanguageCode.toLowerCase())) return text;
  let source = sourceLanguageCode || "auto";
  if (source === "unknown") source = "auto";
  try {
    const data = await postJson("/translate", {
      input: text.slice(0, 2000),
      source_language_code: source,
      target_language_code: "mr-IN",
      model: translateModel(source),
    }, TEXT_TIMEOUT, "translation to marathi");
    return data?.translated_text ?? text;
  } catch {
    return text;
  }
}

export async function transcribeAudio(fileBytes: Uint8Array, filename = "call.webm"): Promise<{ transcript: string; language_code?: string; language: string; confidence: number; request_id?: string }> {
  return withTimeout(async () => {
    const form = new FormData();
    form.append("file", new Blob([fileBytes as unknown as BlobPart]), filename);
    form.append("model", "saaras:v3");
    form.append("mode", "transcribe");
    form.append("language_code", "unknown");
    const res = await fetch(`${BASE}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": key() },
      body: form,
    });
    if (!res.ok) throw new Error(`speech transcription failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    const code = data?.language_code;
    return {
      transcript: data?.transcript ?? "",
      language_code: code,
      language: languageName(code),
      confidence: Number(data?.language_probability ?? 0),
      request_id: data?.request_id,
    };
  }, STT_TIMEOUT, "speech transcription");
}

export async function transcribeAndTranslateAudio(fileBytes: Uint8Array, filename = "call.webm") {
  const native = await transcribeAudio(fileBytes, filename);
  const original = native.transcript || "";
  const code = native.language_code;
  const english = original && !isEnglish(code) ? await translateToEnglish(original, code) : original;
  const marathi = await translateToMarathi(original, code);
  return {
    transcript_original: original,
    transcript_english: english || original,
    transcript_marathi: marathi || original,
    language_code: code,
    language: languageName(code),
    confidence: native.confidence,
  };
}

const VALID_TTS = new Set(["bn-IN","en-IN","gu-IN","hi-IN","kn-IN","ml-IN","mr-IN","od-IN","pa-IN","ta-IN","te-IN"]);

export async function synthesizeSpeech(text: string, languageCode = "mr-IN", speaker = "shubh", model = "bulbul:v3"): Promise<string | null> {
  const clean = (text || "").trim();
  if (!clean) return null;
  const target = VALID_TTS.has(languageCode) ? languageCode : "mr-IN";
  const attempt = async (chunk: string): Promise<string | null> => {
    try {
      const data = await postJson("/text-to-speech", {
        text: chunk, target_language_code: target, speaker, model,
      }, TTS_TIMEOUT, "speech synthesis");
      const audios: string[] | undefined = data?.audios;
      if (audios?.length) {
        const b64 = audios[0];
        return b64.startsWith("data:") ? b64 : `data:audio/wav;base64,${b64}`;
      }
    } catch { /* fall through to short-chunk retry */ }
    return null;
  };
  return (await attempt(clean.slice(0, 1500))) ?? (await attempt(clean.slice(0, 300)));
}
