// Live-transcript publish helpers (spec §13 realtime path).
//
// Single source for every `transcript.partial` / `transcript.final` payload
// the gateway emits (forkMedia onPartial/onFinal + the WS replay path in
// index.ts). Guarantees the dashboard contract:
//
//   { original_text: string (never undefined), language: string (fallback
//     "Unknown"), role: "caller" | "operator" } + optional confidence on finals.
//
// Partials are throttled to ~5/s per call (200 ms) so a chatty STT or a
// per-packet WS client cannot melt the dashboard UI — intermediate frames
// are coalesced (dropped) and the next frame after the window carries the
// latest text.

export type TranscriptRole = "caller" | "operator";

/** Max partial rate: one publish per call per 200 ms (~5/s). */
export const PARTIAL_MIN_INTERVAL_MS = 200;

export function normalizeLanguage(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "Unknown";
}

export function normalizeRole(value: unknown): TranscriptRole {
  return value === "operator" ? "operator" : "caller";
}

/** Coerce to string — never undefined (contract: original_text always present). */
export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface TranscriptPartialPayload {
  original_text: string;
  language: string;
  role: TranscriptRole;
}

export interface TranscriptFinalPayload extends TranscriptPartialPayload {
  confidence?: number;
}

export function buildPartialPayload(
  text: unknown,
  language: unknown,
  role: unknown,
): TranscriptPartialPayload {
  return {
    original_text: normalizeText(text),
    language: normalizeLanguage(language),
    role: normalizeRole(role),
  };
}

export function buildFinalPayload(
  text: unknown,
  language: unknown,
  role: unknown,
  confidence?: unknown,
): TranscriptFinalPayload {
  const base = buildPartialPayload(text, language, role);
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    return { ...base, confidence };
  }
  return base;
}

/** True when the text is worth publishing (non-blank string). */
export function isPublishableText(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * Per-call partial throttle: at most one publish per `intervalMs`.
 * Leading edge sends immediately; frames arriving inside the window are
 * coalesced away (the next frame after the window carries the latest text).
 * Finals bypass the throttle entirely (they are rare + must land).
 */
export class PartialThrottle {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly intervalMs: number = PARTIAL_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when this partial may publish (and records the send). */
  shouldSend(callId: string): boolean {
    const now = this.now();
    const last = this.lastSent.get(callId);
    if (last === undefined || now - last >= this.intervalMs) {
      this.lastSent.set(callId, now);
      return true;
    }
    return false;
  }

  /** Record a send without a check (e.g. a final resets the partial window). */
  markSent(callId: string): void {
    this.lastSent.set(callId, this.now());
  }

  /** Clear the window so the next partial sends immediately. */
  reset(callId?: string): void {
    if (callId === undefined) this.lastSent.clear();
    else this.lastSent.delete(callId);
  }
}
