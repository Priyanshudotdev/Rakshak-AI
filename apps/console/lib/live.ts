"use client";

/**
 * Realtime feed: WS /api/stream on the Fastify API + client-side call model.
 * Backend contracts (apps/api): broadcast envelope {version?, name, callId,
 * at, payload?}; gateway.hello carries recent[] on connect. Published names
 * are validated server-side (packages/types RakshakEvents) — only consume
 * names listed here that the gateway actually publishes.
 */

import { useEffect, useRef, useState } from "react";
import { API_URL } from "./api";

export interface LiveEvent {
  name: string;
  callId: string;
  at: string;
  payload?: Record<string, unknown>;
}

export type ConnectionStatus = "connecting" | "live" | "reconnecting";
export type CallStatus = "incoming" | "waiting" | "active" | "escalated" | "ended";

export interface LiveCall {
  callId: string;
  from: string;
  startedAt: string;
  lastAt: string;
  status: CallStatus;
  utterances: number;
  /** detected language -> count, for primary-language + confidence display */
  languages: Record<string, number>;
  lastText: string;
  lastLanguage: string;
  priority?: string;
  incidentType?: string;
  location?: string;
  operatorJoined: boolean;
  translationOn: boolean;
  escalated: boolean;
  endedReason?: string;
}

export function backoffDelay(retry: number): number {
  return Math.min(1000 * 2 ** retry, 15_000);
}

export function liveEventKey(e: LiveEvent): string {
  const text =
    typeof e.payload?.original_text === "string" ? (e.payload.original_text as string) : JSON.stringify(e.payload ?? "");
  return `${e.name}|${e.callId}|${e.at}|${text.slice(0, 80)}`;
}

/** Merge hello backfill with live events: union, deduped, newest-first, capped. */
export function mergeLiveEvents(live: LiveEvent[], recent: LiveEvent[], cap = 60): LiveEvent[] {
  const seen = new Set<string>();
  const out: LiveEvent[] = [];
  for (const e of [...live, ...recent]) {
    const k = liveEventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  return out.slice(0, cap);
}

function langOf(payload?: Record<string, unknown>): string {
  const l = payload?.language;
  return typeof l === "string" && l ? l : "Unknown";
}

function textOf(payload?: Record<string, unknown>): string {
  const t = payload?.original_text;
  return typeof t === "string" ? t : "";
}

/**
 * Derive per-call queue state from the event stream. Operator legs carry
 * their own callIds (ARI-OP-*), so operator.* events attach to the newest
 * active caller call — documented heuristic, good enough for live ops.
 */
export function deriveCalls(events: LiveEvent[]): { calls: LiveCall[]; waitingOperators: string[] } {
  const byId = new Map<string, LiveCall>();
  const waiting = new Set<string>();
  const asc = [...events].sort((a, b) => (a.at > b.at ? 1 : -1));

  const newestActiveCaller = (): LiveCall | undefined => {
    let best: LiveCall | undefined;
    for (const c of byId.values()) {
      if (c.status === "ended" || c.callId.startsWith("ARI-OP-")) continue;
      if (!best || c.lastAt > best.lastAt) best = c;
    }
    return best;
  };

  for (const e of asc) {
    const p = e.payload ?? {};
    const isOpLeg = e.callId.startsWith("ARI-OP-");
    if (e.name === "call.started" && !isOpLeg) {
      if (!byId.has(e.callId)) {
        const from =
          typeof p.caller === "string" ? (p.caller as string) : typeof p.from === "string" ? (p.from as string) : "Unknown caller";
        byId.set(e.callId, {
          callId: e.callId,
          from,
          startedAt: e.at,
          lastAt: e.at,
          status: "incoming",
          utterances: 0,
          languages: {},
          lastText: "",
          lastLanguage: "Unknown",
          operatorJoined: false,
          translationOn: false,
          escalated: false,
        });
      }
      continue;
    }
    if (e.name === "call.answered" && !isOpLeg) {
      const c = byId.get(e.callId);
      if (c && c.status !== "ended") {
        c.status = "active";
        c.lastAt = e.at;
      }
      continue;
    }
    if (e.name === "operator.waiting") {
      const id = typeof p.operator_id === "string" ? (p.operator_id as string) : e.callId;
      waiting.add(id);
      continue;
    }
    if (e.name === "operator.joined") {
      const target = byId.get(typeof p.call_id === "string" ? (p.call_id as string) : "") ?? newestActiveCaller();
      if (target) {
        target.operatorJoined = true;
        target.lastAt = e.at;
      }
      for (const id of [...waiting]) waiting.delete(id);
      continue;
    }
    if (e.name === "transcript.partial" || e.name === "transcript.final") {
      const target = isOpLeg ? newestActiveCaller() : (byId.get(e.callId) ?? newestActiveCaller());
      if (!target) continue;
      const lang = langOf(p);
      const text = textOf(p);
      target.lastAt = e.at;
      if (e.name === "transcript.final" && text) {
        target.utterances += 1;
        target.languages[lang] = (target.languages[lang] ?? 0) + 1;
        target.lastText = text;
        target.lastLanguage = lang;
      }
      continue;
    }
    if (e.name === "incident.created") {
      const target = byId.get(e.callId) ?? newestActiveCaller();
      if (target) {
        if (typeof p.incident_type === "string") target.incidentType = p.incident_type as string;
        if (typeof p.location === "string") target.location = p.location as string;
        target.lastAt = e.at;
      }
      continue;
    }
    if (e.name === "priority.updated") {
      const target = byId.get(e.callId) ?? newestActiveCaller();
      if (target) {
        if (typeof p.level === "string") target.priority = p.level as string;
        target.lastAt = e.at;
      }
      continue;
    }
    if (e.name === "translation.toggled") {
      const target = byId.get(typeof p.call_id === "string" ? (p.call_id as string) : e.callId);
      if (target) {
        target.translationOn = p.enabled === true;
        target.lastAt = e.at;
      }
      continue;
    }
    if (e.name === "call.ended") {
      const target = byId.get(e.callId) ?? (isOpLeg ? newestActiveCaller() : undefined);
      if (target && target.status !== "ended") {
        target.status = "ended";
        target.lastAt = e.at;
        if (typeof p.reason === "string") target.endedReason = p.reason as string;
      }
      continue;
    }
  }

  const calls = [...byId.values()].sort((a, b) => {
    const rank = (s: CallStatus) => (s === "active" ? 0 : s === "incoming" || s === "waiting" ? 1 : s === "escalated" ? 2 : 3);
    return rank(a.status) - rank(b.status) || (a.lastAt < b.lastAt ? 1 : -1);
  });
  return { calls, waitingOperators: [...waiting] };
}

/** Primary detected language + share, for badges. */
export function primaryLanguage(call: LiveCall): { language: string; confidence: number } {
  const entries = Object.entries(call.languages);
  if (!entries.length) return { language: "Unknown", confidence: 0 };
  const total = entries.reduce((n, [, c]) => n + c, 0);
  const [language, count] = entries.sort((a, b) => b[1] - a[1])[0];
  return { language, confidence: total ? count / total : 0 };
}

export interface LiveFeed {
  status: ConnectionStatus;
  events: LiveEvent[];
  retryCount: number;
  nextRetryMs: number | null;
}

export function useLiveEvents(): LiveFeed {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [retryCount, setRetryCount] = useState(0);
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const delay = backoffDelay(retry.current);
      retry.current += 1;
      setRetryCount(retry.current);
      setNextRetryMs(delay);
      setStatus("reconnecting");
      timer = setTimeout(connect, delay);
    };

    function connect() {
      if (closed) return;
      setStatus(retry.current === 0 ? "connecting" : "reconnecting");
      let socket: WebSocket;
      try {
        socket = new WebSocket(API_URL.replace(/^http/, "ws") + "/api/stream");
      } catch {
        schedule();
        return;
      }
      ws = socket;
      socket.onopen = () => {
        retry.current = 0;
        setRetryCount(0);
        setNextRetryMs(null);
        setStatus("live");
      };
      socket.onmessage = (msg) => {
        try {
          const evt = JSON.parse(String(msg.data)) as LiveEvent & { recent?: LiveEvent[] };
          if (!evt?.name) return;
          if (evt.name === "gateway.hello") {
            if (Array.isArray(evt.recent)) {
              setEvents((prev) => mergeLiveEvents(prev, evt.recent as LiveEvent[]));
            }
            return;
          }
          setEvents((prev) => mergeLiveEvents([evt], prev));
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
  }, []);

  return { status, events, retryCount, nextRetryMs };
}
