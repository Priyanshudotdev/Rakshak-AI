import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { geocodeArea, processAudio, processText, sarvam } from "@rakshak/ai-engine";
import { config } from "@rakshak/config";
import { log } from "@rakshak/logger";
import { publishEvent, registerEventRoutes } from "./events.js";
import { backendNameSync, stores } from "./stores.js";

const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
await app.register(websocket);
registerEventRoutes(app);
// Resolve once at startup: postgres when DATABASE_URL works, else file store.
const store = await stores();

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
  // Keep the generic message contract, but surface a truncated upstream
  // detail so the next Neon/LLM blip is debuggable without log access.
  const detail = (err instanceof Error ? err.message : String(err ?? "")).slice(0, 300);
  return { code: 500, body: { status: "error", message: "Processing failed on the server", detail } };
}

/** Best-effort geo enrichment: resolves the extracted area to coordinates and
 *  patches the saved record. Never blocks or fails the call path. */
function attachGeo(id: string, location?: string, landmark?: string): void {
  if (!location || location === "Not identified") return;
  void (async () => {
    try {
      const geo = await geocodeArea(location, landmark);
      if (geo) await store.updateRecordGeo(id, geo);
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

app.get("/", async () => ({ service: "rakshak-api", version: "2.0.0", docs: "/api/health" }));

app.get("/api/health", async () => ({
  status: "ok",
  sarvam: Boolean(config.sarvamApiKey),
  gemini: Boolean(config.geminiApiKey),
  store: backendNameSync(),
}));

const processCallSchema = z.object({
  transcript: z.string().min(1, "Transcript is required"),
  language: z.string().optional(),
});

app.post("/api/process-call", async (req, reply) => {
  const parsed = processCallSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ status: "error", message: "Transcript is required" });
  try {
    const result: any = await processText(parsed.data.transcript.trim(), parsed.data.language);
    result.call_id = `LIVE-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    result.scenario = "Manual Transcript Incident";
    const saved = await store.saveRecord(result);
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
    // Gateway sessions pass ?callId= so live legs correlate with stored incidents.
    const linked = (req.query as Record<string, string | undefined>)?.callId;
    result.call_id = linked || `AUDIO-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    result.scenario = `Voice Recording (${file.filename || "call.webm"})`;
    const saved = await store.saveRecord(result);
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
    let items = await store.getRecords({ q: q.q, priority: q.priority, language: q.language, limit, offset });
    if (q.audio !== "1") items = items.map(slim);
    return { status: "success", data: items, count: items.length };
  } catch (err) {
    const e = serverError(err);
    return reply.code(e.code).send(e.body);
  }
});

app.delete("/api/records", async () => {
  const count = await store.clearAll();
  return { status: "success", message: `Cleared ${count} records` };
});

app.get("/api/records/count", async (req, reply) => {
  try {
    return { status: "success", data: { count: await store.countRecords() } };
  } catch (err) {
    const e = serverError(err);
    return reply.code(e.code).send(e.body);
  }
});

app.get("/api/records/:id/audio", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { which } = req.query as { which?: string };
  const item = await store.getRecord(id);
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
  const item = await store.getRecord(id);
  if (!item) return reply.code(404).send({ status: "error", message: "Record not found" });
  return { status: "success", data: item };
});

app.delete("/api/records/:id", async (req, reply) => {
  if (!(await requireAuth(req, reply))) return;
  const { id } = req.params as { id: string };
  const ok = await store.deleteRecord(id);
  if (!ok) return reply.code(404).send({ status: "error", message: "Record not found" });
  await store.appendAudit({ actor: await actorOf(req), action: "record.delete", entity: "record", entity_id: id });
  return { status: "success", message: "Record deleted" };
});

app.get("/api/analytics", async () => ({ status: "success", data: await store.getAnalytics() }));

const ttsSchema = z.object({
  text: z.string().min(1, "Text is required"),
  language_code: z.string().default("mr-IN"),
  speaker: z.string().default("shubh"),
  record_id: z.string().optional(),
  call_id: z.string().optional(),
});

app.post("/api/tts", async (req, reply) => {
  const parsed = ttsSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ status: "error", message: "Text is required" });
  try {
    const audioB64 = await sarvam.synthesizeSpeech(parsed.data.text.trim(), parsed.data.language_code, parsed.data.speaker);
    if (!audioB64) return reply.code(500).send({ status: "error", message: "Speech synthesis returned no audio" });
    const rid = parsed.data.record_id ?? parsed.data.call_id;
    if (rid) {
      const rec = await store.getRecord(rid);
      if (rec) {
        rec.translated_audio_base64 = audioB64;
        rec.speaker_used = parsed.data.speaker;
        await store.saveRecord(rec);
      }
    }
    return { status: "success", data: { audio_base64: audioB64, speaker: parsed.data.speaker, language_code: parsed.data.language_code } };
  } catch (err) {
    log("error", "tts failed", { err: String(err), stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined });
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
    const data = await store.addIncidentSource(key, parsed.data);
    await store.appendAudit({ actor: await actorOf(req), action: "source.attach", entity: "incident", entity_id: key, detail: parsed.data });
    return { status: "success", data };
  } catch (err) {
    log("error", "add-source failed", { err: String(err) });
    const e = serverError(err);
    return reply.code(e.code).send(e.body);
  }
});

app.get("/api/incidents/:key/verification", async (req, reply) => {
  const { key } = req.params as { key: string };
  try {
    return { status: "success", data: await store.getIncidentVerification(key) };
  } catch (err) {
    const e = serverError(err);
    return reply.code(e.code).send(e.body);
  }
});

app.get("/api/dispatch", async () => store.getDispatchLog());

async function actorOf(req: { headers: Record<string, string | string[] | undefined> }): Promise<string> {
  const { authenticate, actorFrom } = await import("./auth.js");
  return actorFrom(req.headers, await authenticate(store, req.headers));
}

/** Hard gate for mutating routes. Returns true to proceed; sends 401 and
 *  returns false when AUTH_REQUIRED=1 without a valid Bearer session. */
async function requireAuth(
  req: { headers: Record<string, string | string[] | undefined> },
  reply: { code(n: number): { send(b: unknown): unknown } },
): Promise<boolean> {
  const { authenticate, authRequired } = await import("./auth.js");
  if (!authRequired()) return true;
  const op = await authenticate(store, req.headers);
  if (op) return true;
  reply.code(401).send({ status: "error", message: "Operator sign-in required" });
  return false;
}

// Geo search (§18, Phase 6): incidents with coordinates near a point.
// Postgres-only (PostGIS); file backend answers 400.
app.get("/api/incidents/nearby", async (req, reply) => {
  const { selectedPool } = await import("./db.js");
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
    const res = await pool.query(
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
  const { selectedPool } = await import("./db.js");
  const { embedText } = await import("@rakshak/ai-engine");
  const pool = selectedPool();
  if (!pool) return reply.code(400).send({ status: "error", message: "Postgres backend required for similarity search" });
  const parsed = z.object({ text: z.string().min(1).max(2000), limit: z.number().int().min(1).max(50).optional() }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ status: "error", message: "text is required" });
  try {
    const vector = await embedText(parsed.data.text);
    if (!vector) return reply.code(502).send({ status: "error", message: "Embedding provider unavailable" });
    const res = await pool.query(
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
  const { selectedPool } = await import("./db.js");
  const { syncAll } = await import("./sync.js");
  const pool = selectedPool();
  if (!pool) return reply.code(400).send({ status: "error", message: "Postgres backend required for normalized sync" });
  try {
    const result = await syncAll(pool, store);
    await store.appendAudit({ actor: await actorOf(req), action: "admin.sync-normalized", entity: "database", detail: result });
    return { status: "success", data: result };
  } catch (err) {
    log("error", "sync-normalized failed", { err: String(err) });
    const e = serverError(err);
    return reply.code(e.code).send(e.body);
  }
});

const credentialsSchema = z.object({
  name: z.string().min(1).max(100),
  password: z.string().min(4).max(200),
});

// First registered operator becomes admin; afterwards only admins may register.
app.post("/api/operators/register", async (req, reply) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ status: "error", message: "name and password (min 4 chars) are required" });
  const { hashPassword } = await import("./auth.js");
  try {
    if ((await store.countOperators()) > 0) {
      const { authenticate } = await import("./auth.js");
      const me = await authenticate(store, req.headers);
      if (!me) return reply.code(401).send({ status: "error", message: "Admin sign-in required" });
      if ((me as { role?: string }).role !== "admin") {
        return reply.code(403).send({ status: "error", message: "Admin role required" });
      }
    }
    if (await store.findOperatorByName(parsed.data.name)) {
      return reply.code(409).send({ status: "error", message: "Operator name is taken" });
    }
    const op = await store.createOperator({ name: parsed.data.name.trim(), passwordHash: await hashPassword(parsed.data.password) });
    await store.appendAudit({ actor: op.name, action: "operator.register", entity: "operator", entity_id: String(op.id) });
    return { status: "success", data: op };
  } catch (err) {
    const e = serverError(err);
    return reply.code(e.code).send(e.body);
  }
});

app.post("/api/operators/login", async (req, reply) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ status: "error", message: "name and password are required" });
  const { verifyPassword, newToken, tokenExpiry } = await import("./auth.js");
  const op = await store.findOperatorByName(parsed.data.name);
  if (!op || op.active === false) return reply.code(401).send({ status: "error", message: "Invalid credentials" });
  if (!op.password_hash || !(await verifyPassword(parsed.data.password, String(op.password_hash)))) {
    return reply.code(401).send({ status: "error", message: "Invalid credentials" });
  }
  const token = newToken();
  await store.createSession(String(op.id), token, tokenExpiry());
  await store.appendAudit({ actor: op.name, action: "operator.login", entity: "operator", entity_id: String(op.id) });
  return { status: "success", data: { token, operator: { id: op.id, name: op.name, role: op.role } } };
});

app.get("/api/operators/me", async (req, reply) => {
  const { authenticate } = await import("./auth.js");
  const op = await authenticate(store, req.headers);
  if (!op) return reply.code(401).send({ status: "error", message: "Operator sign-in required" });
  return { status: "success", data: { id: op.id, name: op.name, role: op.role } };
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
  const { authenticate, verifyPassword, hashPassword } = await import("./auth.js");
  const me = await authenticate(store, req.headers);
  if (!me) return reply.code(401).send({ status: "error", message: "Operator sign-in required" });
  const full = await store.findOperatorByName(String(me.name));
  if (!full?.password_hash || !(await verifyPassword(parsed.data.currentPassword, String(full.password_hash)))) {
    return reply.code(401).send({ status: "error", message: "Current password is incorrect" });
  }
  await store.updatePasswordHash(String(full.id), await hashPassword(parsed.data.newPassword));
  const raw = (req.headers.authorization ?? "").toString();
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  await store.revokeOtherSessions(String(full.id), token);
  await store.appendAudit({ actor: String(me.name), action: "operator.change-password", entity: "operator", entity_id: String(full.id) });
  return { status: "success", message: "Password changed; other sessions signed out" };
});

app.post("/api/operators/logout", async (req) => {
  const raw = (req.headers.authorization ?? "").toString();
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (token) await store.revokeSession(token);
  return { status: "success", message: "Signed out" };
});

app.get("/api/audit", async (req) => {
  const q = req.query as { limit?: string };
  const limit = Math.max(1, Math.min(Number(q.limit ?? 50) || 50, 500));
  return { status: "success", data: await store.getAuditLog(limit) };
});

app.post("/api/dispatch", async (req, reply) => {
  if (!(await requireAuth(req, reply))) return;
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
  const entryLog = await store.appendDispatchEntry(entry);
  await store.updateRecordDispatch(entry.call_id, entry);
  const audit = await store.appendAudit({ actor, action: "dispatch", entity: "incident", entity_id: entry.call_id, detail: entry });
  return { status: "success", data: entry, log: entryLog, audit: audit.slice(0, 5) };
});

const port = config.port;
try {
  await app.listen({ port, host: "0.0.0.0" });
  log("info", `rakshak-api listening on :${port}`);
} catch (err) {
  log("error", "api failed to start", { err: String(err) });
  process.exit(1);
}

