import { withTimeout } from "./timeout.js";

// Incident embeddings for pgvector similarity (spec §18, Phase 6).
// Decision: Gemini `gemini-embedding-001` with outputDimensionality=1536 —
// exactly the VECTOR(1536) width in 001_core.sql, so no resize/pad hacks.
// Returns null (never throws) when the key is missing or the call fails;
// callers treat null as "no vector" and keep working without similarity.

export const EMBED_DIMS = 1536;
export const EMBED_MODEL = "gemini-embedding-001";
const EMBED_TIMEOUT = 20_000;
const MAX_CHARS = 8000;

function geminiKey(): string {
  return (process.env.GEMINI_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Pure request builder (unit-tested offline): model, dims, truncation. */
export function buildEmbedRequest(text: string): { model: string; text: string; outputDimensionality: number } {
  return {
    model: `models/${EMBED_MODEL}`,
    text: (text || "").slice(0, MAX_CHARS),
    outputDimensionality: EMBED_DIMS,
  };
}

/** pgvector text literal: '[0.1,0.2,...]'. Null unless exactly 1536 finite dims. */
export function toVectorLiteral(values: unknown): string | null {
  if (!Array.isArray(values) || values.length !== EMBED_DIMS) return null;
  const nums = values as unknown[];
  for (const v of nums) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  return `[${(nums as number[]).join(",")}]`;
}

export async function embedText(text: string): Promise<string | null> {
  const clean = (text || "").trim();
  if (!clean) return null;
  const key = geminiKey();
  if (!key) return null;
  try {
    return await withTimeout(async () => {
      const req = buildEmbedRequest(clean);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          content: { parts: [{ text: req.text }] },
          outputDimensionality: req.outputDimensionality,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      return toVectorLiteral(data?.embedding?.values);
    }, EMBED_TIMEOUT, "embedding");
  } catch {
    return null;
  }
}
