import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RakshakEvents, type RakshakEvent, type RakshakEventName } from "@rakshak/types";
import { log } from "@rakshak/logger";
import { stores } from "./stores.js";

export const EVENT_VERSION = "v2";
const HISTORY_CAP = 200;

const history: RakshakEvent[] = [];
const sockets = new Set<{ send: (data: string) => void; readyState: number; terminate?: () => void }>();

function broadcast(line: string): void {
  for (const sock of [...sockets]) {
    try {
      // 1 = OPEN. Drop slow consumers instead of blocking the live path.
      if (sock.readyState === 1) sock.send(line);
    } catch {
      try {
        sock.terminate?.();
      } catch {
        /* ignore */
      }
      sockets.delete(sock);
    }
  }
}

export function publishEvent<T>(name: RakshakEventName, callId: string, payload: T): RakshakEvent<T> {
  if (!(RakshakEvents as readonly string[]).includes(name)) {
    throw new Error(`Unknown event: ${name}`);
  }
  const event: RakshakEvent<T> = { name, callId, at: new Date().toISOString(), payload };
  history.unshift(event as RakshakEvent);
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
  broadcast(JSON.stringify({ version: EVENT_VERSION, ...event }));
  return event;
}

export function recentEvents(limit = 20): RakshakEvent[] {
  return history.slice(0, Math.max(1, Math.min(limit, HISTORY_CAP)));
}

const publishSchema = z.object({
  name: z.string().min(1),
  callId: z.string().min(1),
  payload: z.unknown(),
});

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function registerEventRoutes(app: FastifyInstance): void {
  // WebSocket gateway — dashboards subscribe here for the live path.
  app.get("/api/stream", { websocket: true }, (socket) => {
    sockets.add(socket as never);
    log("debug", "stream subscriber connected", { subscribers: sockets.size });
    try {
      socket.send(JSON.stringify({ version: EVENT_VERSION, name: "gateway.hello", callId: "-", at: new Date().toISOString(), recent: recentEvents() }));
    } catch {
      /* ignore */
    }
    socket.on("close", () => {
      sockets.delete(socket as never);
    });
    socket.on("error", () => {
      sockets.delete(socket as never);
    });
  });

  // Internal ingest — media-gateway and background workers publish here.
  // Set EVENT_INGEST_KEY to require `x-ingest-key`; open in dev by default.
  app.post("/api/events/publish", async (req, reply) => {
    const required = process.env.EVENT_INGEST_KEY;
    if (required && req.headers["x-ingest-key"] !== required) {
      return reply.code(401).send({ status: "error", message: "Unauthorized" });
    }
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "name, callId and payload are required" });
    try {
      const event = publishEvent(parsed.data.name as RakshakEventName, parsed.data.callId, parsed.data.payload);
      return { status: "success", data: event };
    } catch (err) {
      return reply.code(400).send({ status: "error", message: err instanceof Error ? err.message : "Bad event" });
    }
  });

  app.get("/api/events/recent", async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(q.limit ?? 20) || 20, HISTORY_CAP));
    return { status: "success", data: recentEvents(limit) };
  });

  // Latency percentiles over persisted request timings (spec §26).
  app.get("/api/metrics/latency", async () => {
    const records = await (await stores()).getRecords({ limit: 500 });
    const keys = ["speech_ms", "language_ms", "translate_ms", "extract_ms", "priority_ms", "tts_ms", "total_ms"];
    const out: Record<string, { n: number; avg: number; p50: number; p95: number }> = {};
    for (const key of keys) {
      const vals = records
        .map((r) => Number(r.timings?.[key] ?? 0))
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      const n = vals.length;
      out[key] = {
        n,
        avg: n ? Math.round(vals.reduce((a, b) => a + b, 0) / n) : 0,
        p50: percentile(vals, 50),
        p95: percentile(vals, 95),
      };
    }
    return { status: "success", data: out, count: records.length };
  });
}
