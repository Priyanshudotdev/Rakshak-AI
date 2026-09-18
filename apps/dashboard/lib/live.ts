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
