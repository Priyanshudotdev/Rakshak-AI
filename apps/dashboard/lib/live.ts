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
/** Subscribe to GET /api/stream with backoff reconnect. Falls back silently —
 *  every panel already polls, so a dropped socket never blanks the console. */
export function useLiveEvents(): { connected: boolean; events: LiveEvent[]; lastPartial: string | null } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [lastPartial, setLastPartial] = useState<string | null>(null);
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const backoff = Math.min(1000 * 2 ** retry.current, 15_000);
      retry.current += 1;
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
        setConnected(true);
        retry.current = 0;
      };
      socket.onmessage = (msg) => {
        try {
          const evt = JSON.parse(String(msg.data)) as LiveEvent;
          if (!evt?.name) return;
          if (evt.name === "gateway.hello") {
            if (evt.recent) setEvents(evt.recent.slice(0, 30));
            return;
          }
          setEvents((prev) => [evt, ...prev].slice(0, 30));
          if (evt.name === "transcript.partial") {
            const text = evt.payload?.original_text;
            if (typeof text === "string") setLastPartial(text);
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
        setConnected(false);
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

  return { connected, events, lastPartial };
}
