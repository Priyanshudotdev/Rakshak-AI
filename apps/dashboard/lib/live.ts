"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "./api";

export interface LiveEvent {
  version?: string;
  name: string;
  callId: string;
  at: string;
  payload?: Record<string, unknown>;
  recent?: LiveEvent[];
}

export interface TranslationSuggestion {
  callId: string;
  callerLanguage: string;
  operatorId?: string;
}

/** Latest live call, derived the same way OperatorListen does: the newest
 *  `transcript.final` event in the feed (feed is newest-first). Single source
 *  for the "active live callId" used by the live-translation UI. */
export function activeLiveCallId(events: LiveEvent[]): string | null {
  return events.find((e) => e.name === "transcript.final")?.callId ?? null;
}

/** Client-side filter for the `translation.suggested` nudge: the newest
 *  suggestion for the active call, if any. Payload shape per contract is
 *  {caller_language, operator_id} (call id lives on the envelope). */
export function translationSuggestionForCall(
  events: LiveEvent[],
  callId: string | null,
): TranslationSuggestion | null {
  if (!callId) return null;
  const evt = events.find(
    (e) =>
      e.name === "translation.suggested" &&
      (e.callId === callId ||
        (e.payload != null &&
          typeof (e.payload as Record<string, unknown>).call_id === "string" &&
          ((e.payload as Record<string, unknown>).call_id as string) === callId)),
  );
  if (!evt) return null;
  const p = (evt.payload ?? {}) as Record<string, unknown>;
  const raw =
    (typeof p.caller_language === "string" && p.caller_language) ||
    (typeof p.language === "string" && p.language) ||
    (typeof p.callerLanguage === "string" && p.callerLanguage) ||
    "unknown";
  return {
    callId,
    callerLanguage: raw,
    operatorId: typeof p.operator_id === "string" ? p.operator_id : undefined,
  };
}

/** Nudge is visible only while translation is OFF and a suggestion exists. */
export function shouldShowTranslationNudge(
  events: LiveEvent[],
  callId: string | null,
  enabled: boolean,
): boolean {
  if (enabled) return false;
  return translationSuggestionForCall(events, callId) != null;
}

/* ---------------- Bilingual transcript (transcript.final by role) ---------------- */

export interface TranscriptUtterance {
  callId: string;
  text: string;
  language: string;
  role: "caller" | "operator";
  at: string;
}

/** Newest-first `transcript.final` utterances, capped for perf. Payload per
 *  contract is {original_text, language, role} with role caller|operator. */
export function bilingualTranscripts(events: LiveEvent[], limit = 30): TranscriptUtterance[] {
  const out: TranscriptUtterance[] = [];
  for (const e of events) {
    if (e.name !== "transcript.final") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const rawLang = typeof p.language === "string" ? p.language.trim() : "";
    out.push({
      callId: e.callId,
      text: typeof p.original_text === "string" ? p.original_text : "",
      language: rawLang || "Unknown",
      role: p.role === "operator" ? "operator" : "caller",
      at: e.at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface TranscriptGroup {
  callId: string;
  utterances: TranscriptUtterance[];
}

/** Group newest-first utterances by call, preserving first-seen call order. */
export function groupTranscriptsByCall(utterances: TranscriptUtterance[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  const index = new Map<string, TranscriptGroup>();
  for (const u of utterances) {
    const g = index.get(u.callId);
    if (g) g.utterances.push(u);
    else {
      const next: TranscriptGroup = { callId: u.callId, utterances: [u] };
      index.set(u.callId, next);
      groups.push(next);
    }
  }
  return groups;
}

/* ---------------- Waiting room (operator.waiting / operator.joined) ---------------- */

export interface OperatorWaiting {
  waiting: boolean;
  operatorId?: string;
}

/** Waiting-room state from the live feed (newest-first). The banner shows when
 *  the newest lifecycle event is `operator.waiting` ({operator_id}, no live
 *  caller) and clears on `operator.joined` ({call_id, operator_id}),
 *  `call.ended`, or any fresh live-caller activity. */
export function operatorWaitingState(events: LiveEvent[]): OperatorWaiting {
  for (const e of events) {
    if (e.name === "operator.waiting") {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const operatorId = typeof p.operator_id === "string" ? p.operator_id : undefined;
      return operatorId ? { waiting: true, operatorId } : { waiting: true };
    }
    if (
      e.name === "operator.joined" ||
      e.name === "call.ended" ||
      e.name === "call.started" ||
      e.name === "call.answered" ||
      e.name === "transcript.final"
    ) {
      return { waiting: false };
    }
  }
  return { waiting: false };
}

/** Boolean convenience for `operatorWaitingState(events).waiting`. */
export function isOperatorWaiting(events: LiveEvent[]): boolean {
  return operatorWaitingState(events).waiting;
}

/* ---------------- Translation history (translation.toggled, live-only) ---------------- */

export interface TranslationToggleEvent {
  callId: string;
  enabled: boolean;
  by?: string;
  at: string;
}

/** `translation.toggled` events ({call_id, enabled, by} payload, already
 *  broadcast) for one call, newest-first. Live feed only — no backfill. */
export function translationToggleHistory(
  events: LiveEvent[],
  callId?: string | null,
  limit = 20,
): TranslationToggleEvent[] {
  const out: TranslationToggleEvent[] = [];
  for (const e of events) {
    if (e.name !== "translation.toggled") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const pid = typeof p.call_id === "string" ? p.call_id : e.callId;
    if (callId && pid !== callId && e.callId !== callId) continue;
    out.push({
      callId: pid,
      enabled: p.enabled === true,
      by: typeof p.by === "string" ? p.by : undefined,
      at: e.at,
    });
    if (out.length >= limit) break;
  }
  return out;
}
/* ---------------- Live stream helpers (gateway -> API -> dashboard) ---------------- */

/** Honest socket state: first dial is "connecting", drops are "reconnecting". */
export type LiveStatus = "connecting" | "live" | "reconnecting";

/** Cap for the in-memory live feed (newest-first). */
export const LIVE_EVENT_CAP = 30;

/** Backoff for reconnect attempts: 1s, 2s, 4s … capped at 15s. */
export function backoffDelay(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(1000 * 2 ** n, 15_000);
}

/** Stable dedupe key: same call + same instant + same text = same utterance. */
export function liveEventKey(e: LiveEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const text =
    (typeof p.original_text === "string" && p.original_text) ||
    (typeof p.text === "string" && p.text) ||
    "";
  return `${e.name}|${e.callId}|${e.at}|${text}`;
}

/** Drop duplicates (keep first occurrence), preserving order. */
export function dedupeLiveEvents(events: LiveEvent[]): LiveEvent[] {
  const seen = new Set<string>();
  const out: LiveEvent[] = [];
  for (const e of events) {
    if (!e || typeof e.name !== "string") continue;
    const key = liveEventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function byNewestFirst(a: LiveEvent, b: LiveEvent): number {
  if (a.at === b.at) return 0;
  return a.at < b.at ? 1 : -1;
}

/** Prepend live frame(s), dedupe, cap — newest-first. */
export function mergeLiveEvents(
  prev: LiveEvent[],
  incoming: LiveEvent | LiveEvent[],
  limit: number = LIVE_EVENT_CAP,
): LiveEvent[] {
  const list = Array.isArray(incoming) ? incoming : [incoming];
  const clean = list.filter((e) => e && typeof e.name === "string");
  if (!clean.length) return prev.slice(0, limit);
  return dedupeLiveEvents([...clean, ...prev]).slice(0, limit);
}

/** Merge a `gateway.hello` recent[] backfill without duplicating live-appended
 *  events. Union + dedupe + newest-first sort + cap, so missed frames slot
 *  into place and replays never double-render. */
export function applyHelloBackfill(
  prev: LiveEvent[],
  recent: LiveEvent[] | undefined,
  limit: number = LIVE_EVENT_CAP,
): LiveEvent[] {
  if (!recent || !recent.length) return prev.slice(0, limit);
  const merged = dedupeLiveEvents([...prev, ...recent]);
  merged.sort(byNewestFirst);
  return merged.slice(0, limit);
}

/** Latest partial text from a frame, or null when it carries none. */
export function partialTextOf(evt: LiveEvent): string | null {
  if (evt.name !== "transcript.partial") return null;
  const text = (evt.payload ?? {}) as Record<string, unknown>;
  const raw = text.original_text;
  return typeof raw === "string" && raw ? raw : null;
}

export interface LiveFeedState {
  connected: boolean;
  /** Honest socket state for the LivePanel badge. */
  status: LiveStatus;
  events: LiveEvent[];
  lastPartial: string | null;
  /** Reconnect attempts since the last open (0 while live). */
  retryCount: number;
  /** Ms until the next dial while reconnecting (null while live). */
  nextRetryMs: number | null;
}

/** Subscribe to GET /api/stream with backoff reconnect. Falls back silently —
 *  every panel already polls, so a dropped socket never blanks the console. */
export function useLiveEvents(): LiveFeedState {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [lastPartial, setLastPartial] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const backoff = backoffDelay(retry.current);
      retry.current += 1;
      setRetryCount(retry.current);
      setNextRetryMs(backoff);
      // First dial shows "connecting"; every retry after a drop is honest.
      setStatus("reconnecting");
      timer = setTimeout(connect, backoff);
    };

    function connect() {
      if (closed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(API_URL.replace(/^http/, "ws") + "/api/stream");
      } catch {
        schedule();
        return;
      }
      ws = socket;
      socket.onopen = () => {
        setStatus("live");
        setRetryCount(0);
        setNextRetryMs(null);
        retry.current = 0;
      };
      socket.onmessage = (msg) => {
        try {
          const evt = JSON.parse(String(msg.data)) as LiveEvent;
          if (!evt?.name) return;
          if (evt.name === "gateway.hello") {
            // Backfill recent history without duplicating live-appended events.
            if (evt.recent) setEvents((prev) => applyHelloBackfill(prev, evt.recent));
            return;
          }
          setEvents((prev) => mergeLiveEvents(prev, evt));
          if (evt.name === "transcript.partial") {
            const text = partialTextOf(evt);
            if (text) setLastPartial(text);
          }
          if (evt.name === "incident.created" || evt.name === "priority.updated") {
            void qc.invalidateQueries({ queryKey: ["records"] });
            void qc.invalidateQueries({ queryKey: ["count"] });
            void qc.invalidateQueries({ queryKey: ["analytics"] });
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        setStatus("reconnecting");
        if (!closed) schedule();
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };
    }

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [qc]);

  return { connected: status === "live", status, events, lastPartial, retryCount, nextRetryMs };
}
