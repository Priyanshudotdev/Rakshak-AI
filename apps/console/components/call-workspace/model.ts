/**
 * Pure model helpers for the live call workspace.
 *
 * Data honesty: every helper below surfaces values carried by live events or
 * linked records, and falls back to "Unknown" / "—". Nothing here invents
 * caller, location, or network data.
 */

import type { LiveCall, LiveEvent } from "@/lib/live";

/** Speaker labels shown in the live timeline. */
export type Speaker = "Caller" | "Operator" | "AI" | "System";

export type EntryKind = "utterance" | "system";

export interface TimelineEntry {
  key: string;
  at: string;
  speaker: Speaker;
  kind: EntryKind;
  original: string;
  translated?: string;
  language?: string;
  confidence?: number;
  eventName: string;
  /** True when attached via the operator-leg heuristic (documented below). */
  opLeg: boolean;
}

type Payload = Record<string, unknown>;

function payloadOf(e: LiveEvent): Payload {
  return (e.payload ?? {}) as Payload;
}

/** First non-empty string found under any of the candidate payload keys. */
export function pStr(p: Payload, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function pNum(p: Payload, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pBool(p: Payload, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

const ORIGINAL_KEYS = ["original_text", "text", "utterance"];
const TRANSLATED_KEYS = ["translated_text", "translation", "rendition", "translated"];
const LANGUAGE_KEYS = ["language", "lang", "detected_language", "caller_language"];
const CONFIDENCE_KEYS = ["confidence", "lang_confidence", "detection_confidence"];

function speakerForUtterance(p: Payload, opLeg: boolean): Speaker {
  const role = (pStr(p, ["role", "speaker", "from"]) ?? "").toLowerCase();
  if (role === "operator" || role === "agent") return "Operator";
  if (role === "ai" || role === "assistant" || role === "system-voice") return "AI";
  if (opLeg) return "Operator";
  return "Caller";
}

/** Human-readable one-liner for system (non-utterance) events. */
export function describeSystemEvent(e: LiveEvent): string {
  const p = payloadOf(e);
  switch (e.name) {
    case "call.started":
      return `Call started — ${pStr(p, ["caller", "from", "caller_id"]) ?? "unknown caller"}`;
    case "call.answered":
      return "Call answered — operator audio path open (phone-side; no console PSTN control)";
    case "call.ended":
      return `Call ended${pStr(p, ["reason"]) ? ` — ${pStr(p, ["reason"]) as string}` : ""}`;
    case "operator.waiting":
      return `Operator waiting — ${pStr(p, ["operator_id", "operator"]) ?? "unassigned"}`;
    case "operator.joined":
      return `Operator joined${pStr(p, ["operator_id", "operator"]) ? ` — ${pStr(p, ["operator_id", "operator"]) as string}` : ""}`;
    case "incident.created":
      return `Incident detected — ${pStr(p, ["incident_type", "type"]) ?? "Unknown type"}${pStr(p, ["location"]) ? ` @ ${pStr(p, ["location"]) as string}` : ""}`;
    case "priority.updated":
      return `Priority updated — ${pStr(p, ["level", "priority"]) ?? "Unknown"}`;
    case "translation.toggled": {
      const on = pBool(p, ["enabled"]);
      return on === undefined ? "Translation setting changed" : on ? "Translation resumed" : "Translation paused";
    }
    case "translation.suggested":
      return `Translation suggested — caller tongue ${pStr(p, ["caller_language", "language"]) ?? "unknown"}`;
    default:
      return e.name;
  }
}

const SYSTEM_NAMES = new Set([
  "call.started",
  "call.answered",
  "call.ended",
  "operator.waiting",
  "operator.joined",
  "incident.created",
  "priority.updated",
  "translation.toggled",
  "translation.suggested",
]);

/**
 * OPERATOR-LEG HEURISTIC (mirrors lib/live.ts deriveCalls grouping).
 *
 * The media gateway bridges the caller leg and an operator leg that carries
 * its own callId (`ARI-OP-*`), so operator-side `transcript.final` events do
 * NOT arrive under this page's callId. Rule used here:
 *   1. Always include events whose `callId` equals this callId, plus events
 *      whose payload `call_id` equals it (operator.joined, translation.*).
 *   2. Additionally include `transcript.final` events from `ARI-OP-*` legs
 *      whose timestamp falls inside this call's window
 *      [startedAt .. endedAt-or-now]. Per the backend
 *      (services/media-gateway/src/conversation.ts) operator finals translate
 *      toward the caller tongue and never create incidents — they are shown
 *      as Operator utterances, flagged `opLeg: true`.
 *   3. `transcript.partial` frames are skipped: the timeline is finals-only.
 */
export function buildTimeline(events: LiveEvent[], callId: string, call?: LiveCall): TimelineEntry[] {
  const start = call?.startedAt;
  const end = call?.status === "ended" ? call.lastAt : undefined;
  const inWindow = (at: string): boolean => (!start || at >= start) && (!end || at <= end);

  const out: TimelineEntry[] = [];
  for (const e of events) {
    const p = payloadOf(e);
    const direct = e.callId === callId;
    const linked = pStr(p, ["call_id"]) === callId;
    const isOpLeg = e.callId.startsWith("ARI-OP-");

    if (e.name === "transcript.final") {
      const text = pStr(p, ORIGINAL_KEYS);
      if (!text) continue;
      if (direct) {
        out.push({
          key: `${e.callId}|${e.at}|${text.slice(0, 64)}`,
          at: e.at,
          speaker: speakerForUtterance(p, false),
          kind: "utterance",
          original: text,
          translated: pStr(p, TRANSLATED_KEYS),
          language: pStr(p, LANGUAGE_KEYS),
          confidence: pNum(p, CONFIDENCE_KEYS),
          eventName: e.name,
          opLeg: false,
        });
      } else if (isOpLeg && inWindow(e.at)) {
        out.push({
          key: `${e.callId}|${e.at}|${text.slice(0, 64)}`,
          at: e.at,
          speaker: "Operator",
          kind: "utterance",
          original: text,
          translated: pStr(p, TRANSLATED_KEYS),
          language: pStr(p, LANGUAGE_KEYS),
          confidence: pNum(p, CONFIDENCE_KEYS),
          eventName: e.name,
          opLeg: true,
        });
      }
      continue;
    }

    if (e.name === "transcript.partial") continue;
    if (e.name === "gateway.hello") continue;

    if (direct || linked) {
      if (!SYSTEM_NAMES.has(e.name)) continue;
      out.push({
        key: `sys|${e.callId}|${e.at}|${e.name}`,
        at: e.at,
        speaker: "System",
        kind: "system",
        original: describeSystemEvent(e),
        eventName: e.name,
        opLeg: false,
      });
    } else if (isOpLeg && inWindow(e.at) && (e.name.startsWith("operator.") || e.name === "call.ended")) {
      out.push({
        key: `sys|${e.callId}|${e.at}|${e.name}`,
        at: e.at,
        speaker: "System",
        kind: "system",
        original: `${describeSystemEvent(e)} (operator leg ${e.callId})`,
        eventName: e.name,
        opLeg: true,
      });
    }
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/** Mask a caller identity: keep the last 2 digits, mask the rest. */
export function maskCaller(from: string | undefined): string {
  if (!from || !from.trim() || from === "Unknown caller") return "Unknown caller";
  const total = (from.match(/\d/g) ?? []).length;
  if (total <= 2) return from;
  let seen = 0;
  return from.replace(/\d/g, (d) => {
    seen += 1;
    return seen <= total - 2 ? "•" : d;
  });
}

/**
 * Scan events (newest first) for the first value under any candidate key.
 * Used for callback/location/network fields that may ride on call.started or
 * incident payloads. Returns undefined when absent — callers render "—".
 */
export function firstPayloadString(
  events: LiveEvent[],
  callId: string,
  keys: string[],
): string | undefined {
  const asc = [...events].sort((a, b) => (a.at > b.at ? -1 : 1));
  for (const e of asc) {
    if (e.callId !== callId) continue;
    const v = pStr(payloadOf(e), keys);
    if (v) return v;
  }
  return undefined;
}

export const CALLBACK_KEYS = ["callback", "callback_number", "caller", "from", "caller_id"];
export const LOCATION_EVENT_KEYS = ["location", "address", "area"];
export const NETWORK_KEYS = ["network_quality", "quality", "mos", "signal", "signal_strength", "rtt"];

/**
 * Latest `translation.suggested` for a call, if any.
 *
 * Reuses the same direct/linked matching as buildTimeline (event.callId or
 * payload.call_id) plus the shared pStr helper — no duplicate parsing.
 * Returns the suggested caller tongue for the mismatch nudge; null when absent.
 */
export function latestTranslationSuggestion(
  events: LiveEvent[],
  callId: string,
): { language: string; at: string } | null {
  const candidates = events.filter(
    (e) => e.name === "translation.suggested" && (e.callId === callId || pStr(payloadOf(e), ["call_id"]) === callId),
  );
  if (candidates.length === 0) return null;
  const latest = candidates.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[candidates.length - 1];
  const language = pStr(payloadOf(latest), ["caller_language", "language", "detected_language"]) ?? "unknown";
  return { language, at: latest.at };
}

/** Plain-text transcript for copy + Create-incident (originals, timestamped). */
export function buildTranscriptText(entries: TimelineEntry[]): string {
  return entries
    .filter((e) => e.kind === "utterance")
    .map((e) => `[${formatClock(e.at)}] ${e.speaker}${e.language ? ` (${e.language})` : ""}: ${e.original}`)
    .join("\n");
}

export function formatClock(at: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

export function formatDateTime(at: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString();
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** TTS voice code guard: backend voices are BCP-47 like mr-IN; fall back otherwise. */
export function toVoiceCode(lang: string | undefined, fallback: string): string {
  if (lang && /^[a-zA-Z]{2,3}-[a-zA-Z]{2}$/.test(lang.trim())) return lang.trim();
  return fallback;
}
