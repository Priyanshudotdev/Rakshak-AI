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
  const { id } = req.params as { id: string };
  const ok = await store.deleteRecord(id);
  if (!ok) return reply.code(404).send({ status: "error", message: "Record not found" });
  await store.appendAudit({ actor: actorOf(req), action: "record.delete", entity: "record", entity_id: id });
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
  const { key } = req.params as { key: string };
  const parsed = sourceSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ status: "error", message: "report_id is required" });
  try {
    const data = await store.addIncidentSource(key, parsed.data);
    await store.appendAudit({ actor: actorOf(req), action: "source.attach", entity: "incident", entity_id: key, detail: parsed.data });
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

function actorOf(req: { headers: Record<string, string | string[] | undefined> }): string {
  const h = req.headers["x-operator"];
  const actor = Array.isArray(h) ? h[0] : h;
  return (actor ?? "operator").toString().slice(0, 100) || "operator";
}

app.get("/api/audit", async (req) => {
  const q = req.query as { limit?: string };
  const limit = Math.max(1, Math.min(Number(q.limit ?? 50) || 50, 500));
  return { status: "success", data: await store.getAuditLog(limit) };
});

app.post("/api/dispatch", async (req) => {
  const body = (req.body ?? {}) as Record<string, any>;
  const actor = actorOf(req);
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
