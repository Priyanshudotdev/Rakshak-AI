import { parseJsonFromText } from "./json.js";
import { fillExtractionPrompt, fillPriorityPrompt } from "./prompts.js";
import { withTimeout } from "./timeout.js";

const SARVAM_TIMEOUT = 60_000;
const GEMINI_TIMEOUT = 20_000;
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

function sarvamKey(): string {
  return (process.env.SARVAM_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
}

function geminiKey(): string {
  return (process.env.GEMINI_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
}

async function sarvamComplete(prompt: string): Promise<string> {
  const k = sarvamKey();
  if (!k) throw new Error("SARVAM_API_KEY is not set");
  return withTimeout(async () => {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      // Docs require BOTH headers; subscription key alone hangs. Reasoning is
      // disabled (null) but the model sometimes reasons anyway and truncates
      // at max_tokens with content:null — so the budget covers reasoning +
      // answer (traced live: ~900 reasoning + ~500 answer).
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": k,
        Authorization: `Bearer ${k}`,
      },
      body: JSON.stringify({
        model: "sarvam-105b",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2500,
        temperature: 0.2,
        reasoning_effort: null,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`Sarvam chat failed: ${res.status}`);
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("") : content;
    if (typeof text === "string" && text.trim()) return text;
    throw new Error("Could not read Sarvam chat content");
  }, SARVAM_TIMEOUT, "Sarvam chat");
}

async function geminiComplete(prompt: string): Promise<string> {
  const k = geminiKey();
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return withTimeout(async () => {
    let lastError: unknown = null;
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(k)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`${model} failed: ${res.status}`);
        const data: any = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("");
        if (text) return text;
        lastError = new Error(`${model} returned empty text`);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(String(lastError ?? "Gemini failed"));
  }, GEMINI_TIMEOUT, "Gemini");
}

async function completeJson(prompt: string): Promise<{ data: Record<string, unknown>; model: string }> {
  const errors: string[] = [];
  try {
    return { data: parseJsonFromText(await sarvamComplete(prompt)), model: "sarvam-105b" };
  } catch (err) {
    errors.push(`sarvam: ${err}`);
  }
  try {
    return { data: parseJsonFromText(await geminiComplete(prompt)), model: "gemini" };
  } catch (err) {
    errors.push(`gemini: ${err}`);
    throw new Error(errors.join(" | "));
  }
}

export async function extract(originalText: string, englishText: string, language: string) {
  const prompt = fillExtractionPrompt(language || "Unknown", originalText || englishText, englishText || originalText);
  return completeJson(prompt);
}

export async function assessPriority(extraction: unknown) {
  const prompt = fillPriorityPrompt(JSON.stringify(extraction, null, 2));
  return completeJson(prompt);
}
