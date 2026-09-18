import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { geocodeArea, processAudio, processText, sarvam } from "@rakshak/ai-engine";
import { config } from "@rakshak/config";
import { log } from "@rakshak/logger";
import { auditPublishedEvent, publishEvent, registerEventRoutes } from "./events.js";
import { backendNameSync } from "./stores.js";
import { probePool, queryTimeoutMs, queryWithTimeout, selectedPool } from "./db.js";
import { schemaStatus } from "./pgstore.js";
import type { Doc } from "./store.js";

// ---------------------------------------------------------------------------
// Testable app factory.
//
// index.ts historically built routes at import time and called listen()
// immediately, which made route-level tests impossible. All dashboard-
// consumed routes now live here behind createApp(store) so vitest can inject
// file / pg-mem / failing / hanging backends and assert envelope, auth and
// failure modes. index.ts is a thin bootstrap that calls createApp(await
// stores()) and listens.
// ---------------------------------------------------------------------------

export type StoreLike = {
  saveRecord(input: Doc): Promise<Doc>;
  getRecords(query?: { q?: string; priority?: string; language?: string; limit?: number; offset?: number }): Promise<Doc[]>;
  getRecord(id: string): Promise<Doc | null>;
  deleteRecord(id: string): Promise<boolean>;
  clearAll(): Promise<number>;
  countRecords(): Promise<number>;
  updateRecordDispatch(id: string, entry: Doc): Promise<boolean>;
  updateRecordGeo(id: string, geo: Doc): Promise<boolean>;
  getAnalytics(): Promise<Doc>;
  getDispatchLog(): Promise<Doc[]>;
  appendDispatchEntry(entry: Doc): Promise<Doc[]>;
  addIncidentSource(incidentKey: string, input: any): Promise<{ verification: string; reports: number; evidence: Doc[] }>;
  getIncidentVerification(incidentKey: string): Promise<{ verification: string; reports: number; evidence: Doc[] }>;
  appendAudit(input: { actor?: string; action: string; entity?: string; entity_id?: string; detail?: unknown }): Promise<Doc[]>;
  getAuditLog(limit?: number): Promise<Doc[]>;
  countOperators(): Promise<number>;
  findOperatorByName(name: string): Promise<Doc | null>;
  createOperator(input: { name: string; role?: string; passwordHash?: string | null }): Promise<Doc>;
  createSession(operatorId: string, token: string, expiresAt: string): Promise<void>;
  resolveSession(token: string): Promise<Doc | null>;
  revokeSession(token: string): Promise<void>;
  updatePasswordHash(operatorId: string, passwordHash: string): Promise<boolean>;
  revokeOtherSessions(operatorId: string, keepToken: string): Promise<void>;
  getOperatorProfile(operatorId: string): Promise<Doc | null>;
  upsertOperatorProfile(operatorId: string, patch: { known_languages?: string[]; default_language?: string; mobile_e164?: string | null }): Promise<Doc>;
  findOperatorProfileByMobile(mobile: string): Promise<Doc | null>;
  getCallTranslation(callId: string): Promise<{ call_id: string; enabled: boolean }>;
  setCallTranslation(callId: string, enabled: boolean): Promise<{ call_id: string; enabled: boolean }>;
};

const AUDIO_FIELDS = ["original_audio_base64", "translated_audio_base64"] as const;

function slim(record: Record<string, any>): Record<string, any> {
  const { ...rest } = record;
  for (const f of AUDIO_FIELDS) delete (rest as any)[f];
  return {
    ...rest,
    has_original_audio: Boolean(record.original_audio_base64),
    has_translated_audio: Boolean(record.translated_audio_base64),
  };
}

function serverError(err: unknown) {
  if (err instanceof Error && err.message.includes("records.json")) {
    return { code: 500, body: { status: "error", message: err.message } };
  }
  const detail = (err instanceof Error ? err.message : String(err ?? "")).slice(0, 300);
  return { code: 500, body: { status: "error", message: "Processing failed on the server", detail } };
}

/** DB-backed failures: clear "Database unavailable" message, fast 500, never hang. */
function dbError(err: unknown) {
  const detail = (err instanceof Error ? err.message : String(err ?? "")).slice(0, 300);
  return { code: 500, body: { status: "error", message: "Database unavailable", detail } };
}

/** Race any store promise against the statement timeout so a hung backend
 *  (Neon blip, TCP hang, stuck file lock) becomes a fast 500, never a hang.
 *  Timeout defaults to DB_STATEMENT_TIMEOUT_MS (8000ms prod, tiny in tests). */
async function storeCall<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const ms = timeoutMs ?? queryTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Database query timed out after ${ms}ms`)), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createApp(store: StoreLike): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  // Demo-open CORS: the operator dashboard runs in browsers anywhere and talks
  // to this API directly. TODO hardening: origin: ["https://console…"],
  // credentials, plus AUTH_REQUIRED=1 with gateway-safe exemptions.
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  await app.register(websocket);
  registerEventRoutes(app);

  /** Best-effort geo enrichment: resolves the extracted area to coordinates and
   *  patches the saved record. Never blocks or fails the call path. */
  function attachGeo(id: string, location?: string, landmark?: string): void {
    if (!location || location === "Not identified") return;
    void (async () => {
      try {
        const geo = await geocodeArea(location, landmark);
        if (geo) await storeCall(() => store.updateRecordGeo(id, geo));
      } catch {
        /* text location remains the source of truth */
      }
    })();
  }

  /** Fan out to live subscribers. Never throws — the batch response must not depend on WS. */
  function emitIncidentEvents(result: any): void {
    try {
      const callId = String(result.call_id ?? result.id ?? "unknown");
      publishEvent("transcript.final", callId, {
        original_text: result.transcript_original ?? "",
        language: result.original_language ?? "Unknown",
      });
      publishEvent("incident.created", callId, {
        id: result.id ?? callId,
        incident_type: result.extraction?.incident_type ?? "Unknown",
        location: result.extraction?.location ?? "Not identified",
      });
      publishEvent("priority.updated", callId, {
        level: result.priority?.level ?? "MEDIUM",
        reasoning: result.priority?.reasoning ?? "",
      });
    } catch (err) {
      log("warn", "event emit failed", { err: String(err) });
    }
  }

  async function actorOf(req: { headers: Record<string, string | string[] | undefined> }): Promise<string> {
    const { authenticate, actorFrom } = await import("./auth.js");
    try {
      return actorFrom(req.headers, await storeCall(() => authenticate(store, req.headers)));
    } catch {
      // DB down between requireAuth and here: fall back to the callsign header
      // so the audit trail still records who acted; the outer try/catch will
      // already have turned the main op into a 500.
      return actorFrom(req.headers, null);
    }
  }

  /** Hard gate for mutating routes. Returns true to proceed; sends 401 and
   *  returns false when AUTH_REQUIRED=1 without a valid Bearer session.
   *  DB failures become a fast 500 (not 401) so "API up, DB down" is visible. */
  async function requireAuth(
    req: { headers: Record<string, string | string[] | undefined> },
    reply: { code(n: number): { send(b: unknown): unknown } },
  ): Promise<boolean> {
    const { authenticate, authRequired } = await import("./auth.js");
    if (!authRequired()) return true;
    let op: Doc | null;
    try {
      op = await storeCall(() => authenticate(store, req.headers));
    } catch (err) {
      const e = dbError(err);
      reply.code(e.code).send(e.body);
      return false;
    }
    if (op) return true;
    reply.code(401).send({ status: "error", message: "Operator sign-in required" });
    return false;
  }

  // Operator language profiles + per-call translation need a session
  // operator_id, so they stay strictly gated (401 when signed out) even when
  // AUTH_REQUIRED is off for demo-open reads/writes.
  async function requireOperator(
    req: { headers: Record<string, string | string[] | undefined> },
    reply: { code(n: number): { send(b: unknown): unknown } },
  ): Promise<{ id: string; name?: string } | null> {
    if (!(await requireAuth(req, reply))) return null;
    const { authenticate } = await import("./auth.js");
    let op: Doc | null;
    try {
      op = await storeCall(() => authenticate(store, req.headers));
    } catch (err) {
      const e = dbError(err);
      reply.code(e.code).send(e.body);
      return null;
    }
    if (!op) {
      reply.code(401).send({ status: "error", message: "Operator sign-in required" });
      return null;
    }
    return op as { id: string; name?: string };
  }

  // -- Readiness ------------------------------------------------------------
  // Dashboard header polls /api/health every 10s and shows API ok vs bad plus
  // STT/LLM badges. Extended (backward compatible): existing
  // {status, sarvam, gemini, store} fields are kept; new {db, migrations}
  // let the header distinguish "API up, DB down" from fully healthy.
  // GET /api/ready is the lightweight variant for load-balancers / header
  // preflight: {api, db, migrations} with no AI-key fields.
  //   db: "postgres" | "file" | "down"
  //   migrations: "ok" | "pending" (pending = schema not yet applied or failed)
  // Health never hangs: the postgres probe is capped at 2s.
  async function readiness(): Promise<{ db: "postgres" | "file" | "down"; migrations: "ok" | "pending" }> {
    const name = backendNameSync();
    if (name !== "postgres") return { db: "file", migrations: "ok" };
    const alive = await probePool(selectedPool(), 2000);
    if (!alive) return { db: "down", migrations: schemaStatus().ready ? "ok" : "pending" };
    return { db: "postgres", migrations: schemaStatus().ready ? "ok" : "pending" };
  }

  app.get("/", async () => ({ service: "rakshak-api", version: "2.0.0", docs: "/api/health" }));

  app.get("/api/health", async () => {
    const r = await readiness();
    const healthy = r.db !== "down" && r.migrations === "ok";
    return {
      status: healthy ? "ok" : "degraded",
      sarvam: Boolean(config.sarvamApiKey),
      gemini: Boolean(config.geminiApiKey),
      store: backendNameSync(),
      db: r.db,
      migrations: r.migrations,
    };
  });

  app.get("/api/ready", async () => {
    const r = await readiness();
    return { api: "up", db: r.db, migrations: r.migrations };
  });

  const processCallSchema = z.object({
    transcript: z.string().min(1, "Transcript is required"),
    language: z.string().optional(),
  });

  // Intake (dashboard sends no auth): open for demo. Writes a record, so in
  // hardened deploys put this behind the gateway / AUTH_REQUIRED exemptions.
  app.post("/api/process-call", async (req, reply) => {
    const parsed = processCallSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "Transcript is required" });
    try {
      const result: any = await processText(parsed.data.transcript.trim(), parsed.data.language);
      result.call_id = `LIVE-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      result.scenario = "Manual Transcript Incident";
      const saved = await storeCall(() => store.saveRecord(result));
      result.id = saved.id;
      emitIncidentEvents(result);
      attachGeo(saved.id, result.extraction?.location, result.extraction?.landmark);
      return { status: "success", data: result };
    } catch (err) {
      log("error", "process-call failed", { err: String(err), stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined });
      const e = serverError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.post("/api/process-audio", async (req, reply) => {
    const file = await req.file().catch(() => null);
    if (!file) return reply.code(400).send({ status: "error", message: "Audio file is required" });
    const bytes = await file.toBuffer();
    if (!bytes.length) return reply.code(400).send({ status: "error", message: "Audio file was empty" });
    try {
      const result: any = await processAudio(new Uint8Array(bytes), file.filename || "call.webm");
      const linked = (req.query as Record<string, string | undefined>)?.callId;
      result.call_id = linked || `AUDIO-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      result.scenario = `Voice Recording (${file.filename || "call.webm"})`;
      const saved = await storeCall(() => store.saveRecord(result));
      result.id = saved.id;
      emitIncidentEvents(result);
      attachGeo(saved.id, result.extraction?.location, result.extraction?.landmark);
      return { status: "success", data: result };
    } catch (err) {
      log("error", "process-audio failed", { err: String(err), stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined });
      const e = serverError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Reads: open for demo (dashboard polls with no auth, cache:no-store).
  app.get("/api/records", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limitRaw = Number(q.limit ?? 100);
    const offsetRaw = Number(q.offset ?? 0);
    if (!Number.isInteger(limitRaw) || !Number.isInteger(offsetRaw)) {
      return reply.code(400).send({ status: "error", message: "limit and offset must be integers" });
    }
    const limit = Math.max(1, Math.min(limitRaw, 500));
    const offset = Math.max(0, offsetRaw);
    try {
      let items = await storeCall(() => store.getRecords({ q: q.q, priority: q.priority, language: q.language, limit, offset }));
      if (q.audio !== "1") items = items.map(slim);
      return { status: "success", data: items, count: items.length };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Destructive clear: dashboard gates the button to admins client-side and
  // sends Bearer when signed in. Server gate mirrors other mutating routes
  // (open when AUTH_REQUIRED is off for demo, 401 otherwise) + audit trail.
  app.delete("/api/records", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    try {
      const count = await storeCall(() => store.clearAll());
      try {
        const actor = await actorOf(req);
        await storeCall(() => store.appendAudit({ actor, action: "records.clear", entity: "record", detail: { count } }));
      } catch (auditErr) {
        log("warn", "records.clear audit failed", { err: String(auditErr) });
      }
      return { status: "success", message: `Cleared ${count} records` };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.get("/api/records/count", async (req, reply) => {
    try {
      return { status: "success", data: { count: await storeCall(() => store.countRecords()) } };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Audio bytes: open (an <audio> tag cannot send Authorization headers).
  app.get("/api/records/:id/audio", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { which } = req.query as { which?: string };
    let item: Doc | null;
    try {
      item = await storeCall(() => store.getRecord(id));
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
    if (!item) return reply.code(404).send({ status: "error", message: "Record not found" });
    const field = which === "translated" ? "translated_audio_base64" : "original_audio_base64";
    const uri: string = item[field] ?? "";
    if (!uri.startsWith("data:")) return reply.code(404).send({ status: "error", message: "Audio not available" });
    const [header, b64] = uri.split(",", 2);
    const mime = header.slice(5).split(";")[0] || "audio/wav";
    try {
      return reply.type(mime).send(Buffer.from(b64 ?? "", "base64"));
    } catch {
      return reply.code(500).send({ status: "error", message: "Audio data is corrupt" });
    }
  });

  app.get("/api/records/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const item = await storeCall(() => store.getRecord(id));
      if (!item) return reply.code(404).send({ status: "error", message: "Record not found" });
      return { status: "success", data: item };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.delete("/api/records/:id", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    try {
      const { id } = req.params as { id: string };
      const ok = await storeCall(() => store.deleteRecord(id));
      if (!ok) return reply.code(404).send({ status: "error", message: "Record not found" });
      const actor = await actorOf(req);
      await storeCall(() => store.appendAudit({ actor, action: "record.delete", entity: "record", entity_id: id }));
      return { status: "success", message: "Record deleted" };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Short TTL cache: the dashboard polls this on an interval from several
  // panels at once, and getAnalytics scans hundreds of records per call.
  // Without it a slow scan overlaps the next poll and the UI flaps between
  // data and skeletons. 8s staleness is invisible on a dashboard.
  // On DB failure the last good value is served stale (resilient) when
  // available; otherwise a fast 500 envelope.
  let analyticsCache: { at: number; body: unknown } | null = null;
  app.get("/api/analytics", async (req, reply) => {
    const now = Date.now();
    if (analyticsCache && now - analyticsCache.at < 8000) {
      return { status: "success", data: analyticsCache.body };
    }
    try {
      const data = await storeCall(() => store.getAnalytics());
      analyticsCache = { at: now, body: data };
      return { status: "success", data };
    } catch (err) {
      if (analyticsCache) return { status: "success", data: analyticsCache.body };
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  const ttsSchema = z.object({
    text: z.string().min(1, "Text is required"),
    language_code: z.string().default("mr-IN"),
    speaker: z.string().default("shubh"),
    record_id: z.string().optional(),
    call_id: z.string().optional(),
  });

  // TTS (dashboard sends no auth): open for demo, same as intake.
  app.post("/api/tts", async (req, reply) => {
    const parsed = ttsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "Text is required" });
    try {
      const audioB64 = await sarvam.synthesizeSpeech(parsed.data.text.trim(), parsed.data.language_code, parsed.data.speaker);
      if (!audioB64) return reply.code(500).send({ status: "error", message: "Speech synthesis returned no audio" });
      const rid = parsed.data.record_id ?? parsed.data.call_id;
      if (rid) {
        const rec = await storeCall(() => store.getRecord(rid));
        if (rec) {
          rec.translated_audio_base64 = audioB64;
          rec.speaker_used = parsed.data.speaker;
          await storeCall(() => store.saveRecord(rec));
        }
      }
      return { status: "success", data: { audio_base64: audioB64, speaker: parsed.data.speaker, language_code: parsed.data.language_code } };
    } catch (err) {
      log("error", "tts failed", { err: String(err), stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined });
      const e = serverError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Operator listen path: translate one utterance for private playback.
  // Costs an API call per use, so it shares the mutating-route auth gate
  // (open when AUTH_REQUIRED is off for demo, 401 otherwise).
  app.post("/api/translate", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const parsed = z
      .object({
        text: z.string().min(1).max(2000),
        target_language_code: z.string().default("en-IN"),
        source_language_code: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "text is required" });
    try {
      const translated = await sarvam.translateText(parsed.data.text, parsed.data.target_language_code, parsed.data.source_language_code);
      return { status: "success", data: { translated_text: translated, target: parsed.data.target_language_code } };
    } catch (err) {
      const e = serverError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  const sourceSchema = z.object({
    report_id: z.string().min(1, "report_id is required"),
    source: z.string().max(100).optional(),
    title: z.string().max(500).optional(),
    correlation_score: z.number().min(0).max(1).optional(),
    signals: z.array(z.string()).max(20).optional(),
  });

  // Durable corroboration ledger (§19): idempotent per report; the worker posts
  // here instead of counting in memory, so verification survives restarts.
  app.post("/api/incidents/:key/sources", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const { key } = req.params as { key: string };
    const parsed = sourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "report_id is required" });
    try {
      const data = await storeCall(() => store.addIncidentSource(key, parsed.data));
      const actor = await actorOf(req);
      await storeCall(() => store.appendAudit({ actor, action: "source.attach", entity: "incident", entity_id: key, detail: parsed.data }));
      return { status: "success", data };
    } catch (err) {
      log("error", "add-source failed", { err: String(err) });
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.get("/api/incidents/:key/verification", async (req, reply) => {
    const { key } = req.params as { key: string };
    try {
      return { status: "success", data: await storeCall(() => store.getIncidentVerification(key)) };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Dispatch log read: open (dashboard polls with no auth). Envelope
  // {status, data} — the dashboard accepts both the envelope and a bare array
  // for backward compatibility with the pre-envelope shape.
  app.get("/api/dispatch", async (req, reply) => {
    try {
      const logRows = await storeCall(() => store.getDispatchLog());
      return { status: "success", data: logRows };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Geo search (§18, Phase 6): incidents with coordinates near a point.
  // Postgres-only (PostGIS); file backend answers 400.
  app.get("/api/incidents/nearby", async (req, reply) => {
    const pool = selectedPool();
    if (!pool) return reply.code(400).send({ status: "error", message: "Postgres backend required for geo search" });
    const q = req.query as { lat?: string; lon?: string; radiusKm?: string; limit?: string };
    const lat = Number(q.lat);
    const lon = Number(q.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return reply.code(400).send({ status: "error", message: "lat and lon are required" });
    }
    const radiusM = Math.max(100, Math.min(Number(q.radiusKm ?? 25) || 25, 500)) * 1000;
    const limit = Math.max(1, Math.min(Number(q.limit ?? 20) || 20, 100));
    try {
      const res = await queryWithTimeout(
        pool,
        `SELECT id, call_id, incident_type, priority, verification, location_raw,
                ST_Y(geom) AS lat, ST_X(geom) AS lon,
                ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m
         FROM incidents
         WHERE geom IS NOT NULL
           AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
         ORDER BY distance_m ASC LIMIT $4`,
        [lat, lon, radiusM, limit],
      );
      return { status: "success", data: res.rows, count: res.rows.length };
    } catch (err) {
      if (/timed out/i.test(String(err))) {
        const e = dbError(err);
        return reply.code(e.code).send(e.body);
      }
      // Compose postgres is record-store only (no 001/PostGIS) — say so plainly.
      if (/st_dwithin|does not exist|extension/i.test(String(err))) {
        return reply.code(400).send({ status: "error", message: "Geo search needs the PostGIS schema (001_core.sql) on this database" });
      }
      const e = serverError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Semantic search (§18, Phase 6): pgvector cosine over incident embeddings.
  // Postgres-only; 502 when the embedding provider is unavailable.
  app.post("/api/incidents/similar", async (req, reply) => {
    const pool = selectedPool();
    if (!pool) return reply.code(400).send({ status: "error", message: "Postgres backend required for similarity search" });
    const parsed = z.object({ text: z.string().min(1).max(2000), limit: z.number().int().min(1).max(50).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "text is required" });
    try {
      const { embedText } = await import("@rakshak/ai-engine");
      const vector = await embedText(parsed.data.text);
      if (!vector) return reply.code(502).send({ status: "error", message: "Embedding provider unavailable" });
      const res = await queryWithTimeout(
        pool,
        `SELECT id, call_id, incident_type, priority, verification, location_raw,
                (embedding <=> $1::vector) AS distance
         FROM incidents
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector ASC LIMIT $2`,
        [vector, parsed.data.limit ?? 10],
      );
      return {
        status: "success",
        data: res.rows.map((r) => ({ ...r, score: 1 - Number(r.distance ?? 1) })),
        count: res.rows.length,
      };
    } catch (err) {
      if (/timed out/i.test(String(err))) {
        const e = dbError(err);
        return reply.code(e.code).send(e.body);
      }
      if (/does not exist|extension|operator does not exist/i.test(String(err))) {
        return reply.code(400).send({ status: "error", message: "Similarity search needs the pgvector schema (001_core.sql) on this database" });
      }
      const e = serverError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // One-shot backfill (§15): project stored records into the normalized +
  // PostGIS schema. Postgres-only; safe to re-run (per-call rows replaced).
  app.post("/api/admin/sync-normalized", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const pool = selectedPool();
    const { syncAll } = await import("./sync.js");
    if (!pool) return reply.code(400).send({ status: "error", message: "Postgres backend required for normalized sync" });
    try {
      const result = await storeCall(() => syncAll(pool, store));
      const actor = await actorOf(req);
      await storeCall(() => store.appendAudit({ actor, action: "admin.sync-normalized", entity: "database", detail: result }));
      return { status: "success", data: result };
    } catch (err) {
      log("error", "sync-normalized failed", { err: String(err) });
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  const credentialsSchema = z.object({
    name: z.string().min(1).max(100),
    password: z.string().min(4).max(200),
  });

  // First registered operator becomes admin; afterwards only admins may register.
  // Public for bootstrap (dashboard tries login then register on first run).
  app.post("/api/operators/register", async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "name and password (min 4 chars) are required" });
    const { hashPassword } = await import("./auth.js");
    try {
      if ((await storeCall(() => store.countOperators())) > 0) {
        const { authenticate } = await import("./auth.js");
        const me = await storeCall(() => authenticate(store, req.headers));
        if (!me) return reply.code(401).send({ status: "error", message: "Admin sign-in required" });
        if ((me as { role?: string }).role !== "admin") {
          return reply.code(403).send({ status: "error", message: "Admin role required" });
        }
      }
      if (await storeCall(() => store.findOperatorByName(parsed.data.name))) {
        return reply.code(409).send({ status: "error", message: "Operator name is taken" });
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const op = await storeCall(() => store.createOperator({ name: parsed.data.name.trim(), passwordHash }));
      await storeCall(() => store.appendAudit({ actor: op.name, action: "operator.register", entity: "operator", entity_id: String(op.id) }));
      return { status: "success", data: op };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Public (dashboard login form). DB down -> fast 500, never hang.
  app.post("/api/operators/login", async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "name and password are required" });
    try {
      const { verifyPassword, newToken, tokenExpiry } = await import("./auth.js");
      const op = await storeCall(() => store.findOperatorByName(parsed.data.name));
      if (!op || op.active === false) return reply.code(401).send({ status: "error", message: "Invalid credentials" });
      if (!op.password_hash || !(await verifyPassword(parsed.data.password, String(op.password_hash)))) {
        return reply.code(401).send({ status: "error", message: "Invalid credentials" });
      }
      const token = newToken();
      await storeCall(() => store.createSession(String(op.id), token, tokenExpiry()));
      await storeCall(() => store.appendAudit({ actor: op.name, action: "operator.login", entity: "operator", entity_id: String(op.id) }));
      return { status: "success", data: { token, operator: { id: op.id, name: op.name, role: op.role } } };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.get("/api/operators/me", async (req, reply) => {
    try {
      const { authenticate } = await import("./auth.js");
      const op = await storeCall(() => authenticate(store, req.headers));
      if (!op) return reply.code(401).send({ status: "error", message: "Operator sign-in required" });
      return { status: "success", data: { id: op.id, name: op.name, role: op.role } };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  const passwordChangeSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(4).max(200),
  });

  app.post("/api/operators/change-password", async (req, reply) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "error", message: "current and new (min 4 chars) passwords are required" });
    }
    try {
      const { authenticate, verifyPassword, hashPassword } = await import("./auth.js");
      const me = await storeCall(() => authenticate(store, req.headers));
      if (!me) return reply.code(401).send({ status: "error", message: "Operator sign-in required" });
      const full = await storeCall(() => store.findOperatorByName(String(me.name)));
      if (!full?.password_hash || !(await verifyPassword(parsed.data.currentPassword, String(full.password_hash)))) {
        return reply.code(401).send({ status: "error", message: "Current password is incorrect" });
      }
      const newHash = await hashPassword(parsed.data.newPassword);
      await storeCall(() => store.updatePasswordHash(String(full.id), newHash));
      const raw = (req.headers.authorization ?? "").toString();
      const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
      await storeCall(() => store.revokeOtherSessions(String(full.id), token));
      await storeCall(() => store.appendAudit({ actor: String(me.name), action: "operator.change-password", entity: "operator", entity_id: String(full.id) }));
      return { status: "success", message: "Password changed; other sessions signed out" };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Idempotent sign-out: always succeeds (best-effort revoke) so a dead DB
  // never traps the dashboard in a signed-in state.
  app.post("/api/operators/logout", async (req) => {
    const raw = (req.headers.authorization ?? "").toString();
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
    if (token) {
      try {
        await storeCall(() => store.revokeSession(token));
      } catch (err) {
        log("warn", "logout revoke failed (best-effort)", { err: String(err) });
      }
    }
    return { status: "success", message: "Signed out" };
  });

  // Operator language profiles (gateway DID join identifies by caller ID) +
  // per-call live-translation toggle. Operator routes share the Bearer session
  // gate used by /api/translate and /api/dispatch (requireAuth), plus a strict
  // session check — the profile/translation actions need a session operator_id,
  // so unauthenticated callers always get 401 even when AUTH_REQUIRED is off.
  function normalizeMobileE164(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let digits = s.replace(/\D/g, "");
    if (!digits) return null;
    while (digits.length > 10 && digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 10) return `+91${digits}`;
    return `+${digits}`;
  }

  const profilePutSchema = z.object({
    known_languages: z.array(z.string().min(1).max(30)).max(20).optional(),
    default_language: z.string().min(1).max(30).optional(),
    mobile_e164: z.string().max(30).nullable().optional(),
  });

  const translationSetSchema = z.object({ enabled: z.boolean() });

  // NOTE: profile/translation success bodies are intentionally bare
  // {operator_id,...} / {call_id,enabled} (no {status,data} envelope) — the
  // dashboard's getProfile/putProfile/getTranslation/setTranslation parse the
  // JSON directly as the profile object. Errors always use the
  // {status:"error",message} envelope.
  app.get("/api/operators/profile", async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    try {
      const profile = await storeCall(() => store.getOperatorProfile(String(op.id)));
      if (!profile) {
        // Defaults, not an error: every operator starts without a profile and the
        // dashboard prefill must not throw on first sign-in.
        return {
          operator_id: String(op.id),
          known_languages: [],
          default_language: "hi-IN",
          mobile_e164: null,
          active: true,
        };
      }
      return profile;
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.put("/api/operators/profile", async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const parsed = profilePutSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "Invalid profile body" });
    const patch: { known_languages?: string[]; default_language?: string; mobile_e164?: string | null } = {};
    if (parsed.data.known_languages !== undefined) patch.known_languages = parsed.data.known_languages;
    if (parsed.data.default_language !== undefined) patch.default_language = parsed.data.default_language;
    if (parsed.data.mobile_e164 !== undefined) patch.mobile_e164 = normalizeMobileE164(parsed.data.mobile_e164);
    try {
      return await storeCall(() => store.upsertOperatorProfile(String(op.id), patch));
    } catch (err) {
      if (/mobile_taken|duplicate|unique/i.test(String(err))) {
        return reply.code(409).send({ status: "error", message: "mobile already in use" });
      }
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  // Gateway DID join lookup: shared-secret gate mirroring POST /api/events/publish
  // (open in dev when EVENT_INGEST_KEY is unset).
  app.get("/api/operators/lookup", async (req, reply) => {
    const required = process.env.EVENT_INGEST_KEY;
    if (required && req.headers["x-ingest-key"] !== required) {
      return reply.code(401).send({ status: "error", message: "Unauthorized" });
    }
    const q = req.query as { mobile?: string };
    const norm = normalizeMobileE164(q.mobile ?? "");
    if (!norm) return reply.code(400).send({ status: "error", message: "mobile is required" });
    try {
      const hit = await storeCall(() => store.findOperatorProfileByMobile(norm));
      if (!hit) return reply.code(404).send({ status: "error", message: "Operator not found" });
      return {
        operator_id: hit.operator_id,
        default_language: hit.default_language,
        known_languages: hit.known_languages,
      };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.get("/api/calls/:id/translation", async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    try {
      const { id } = req.params as { id: string };
      return await storeCall(() => store.getCallTranslation(id));
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.post("/api/calls/:id/translation", async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const parsed = translationSetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ status: "error", message: "enabled is required" });
    let result: { call_id: string; enabled: boolean };
    try {
      result = await storeCall(() => store.setCallTranslation(id, parsed.data.enabled));
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
    try {
      publishEvent("translation.toggled", id, {
        call_id: id,
        enabled: result.enabled,
        by: String(op.id),
      });
    } catch (err) {
      log("warn", "translation.toggled emit failed", { err: String(err) });
    }
    try {
      await auditPublishedEvent("translation.toggled", id, {
        call_id: id,
        enabled: result.enabled,
        by: String(op.id),
      });
    } catch {
      /* audit is best-effort; never fail the toggle */
    }
    return result;
  });

  app.get("/api/audit", async (req, reply) => {
    const q = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(q.limit ?? 50) || 50, 500));
    try {
      return { status: "success", data: await storeCall(() => store.getAuditLog(limit)) };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  app.post("/api/dispatch", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    try {
      const body = (req.body ?? {}) as Record<string, any>;
      const actor = await actorOf(req);
      const entry = {
        time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        call_id: body.call_id ?? "LIVE",
        location: body.location ?? "Not identified",
        incident_type: body.incident_type ?? "Unknown",
        priority: body.priority ?? "MEDIUM",
        units: body.units ?? "Patrol unit assigned",
        operator: actor,
      };
      const entryLog = await storeCall(() => store.appendDispatchEntry(entry));
      await storeCall(() => store.updateRecordDispatch(entry.call_id, entry));
      const audit = await storeCall(() => store.appendAudit({ actor, action: "dispatch", entity: "incident", entity_id: entry.call_id, detail: entry }));
      return { status: "success", data: entry, log: entryLog, audit: audit.slice(0, 5) };
    } catch (err) {
      const e = dbError(err);
      return reply.code(e.code).send(e.body);
    }
  });

  return app;
}
