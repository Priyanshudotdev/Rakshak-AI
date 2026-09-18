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
