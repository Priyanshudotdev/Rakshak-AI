import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { selectedPool } from "./db.js";
import { computeAnalytics } from "./analytics.js";
import type { Doc } from "./store.js";

// Postgres backend with file-store-identical semantics (see pgstore.test.ts
// equivalence coverage). DDL comes from database/migrations/002_records_store.sql
// — the same file applied in production — so tests and prod cannot drift.

let schemaReady = false;

function pool() {
  const p = selectedPool();
  if (!p) throw new Error("Postgres backend selected but no pool is configured");
  return p;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = readFileSync(new URL("../../../database/migrations/002_records_store.sql", import.meta.url), "utf-8")
    // Strip -- comments: the test double (pg-mem) cannot parse leading or
    // trailing comment text; real Postgres is unaffected by their absence.
    .replace(/--[^\n]*/g, "");
  // One statement at a time: in-memory Postgres (pg-mem, tests) cannot
  // prepare multi-statement batches, and it cannot parse IF NOT EXISTS —
  // so the phrase is stripped and "already exists" is tolerated instead.
  // Real Postgres accepts both forms, keeping the migration file canonical.
  for (const stmt of sql.split(";")) {
    const trimmed = stmt.replace(/IF NOT EXISTS/gi, " ").trim();
    if (!trimmed) continue;
    try {
      await pool().query(trimmed);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    }
  }
  schemaReady = true;
}

function asDoc(value: unknown): Doc {
  if (typeof value === "string") return JSON.parse(value) as Doc;
  return value as Doc;
}

function newId(prefix: string): string {
  const now = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
  return `${prefix}-${now}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function buildEntry(input: Doc): Doc {
  let recordId: string = input.id ?? input.call_id;
  if (!recordId || String(recordId).startsWith("CALL_")) recordId = newId("REC");
  const nowIso = new Date().toISOString();
  return {
    id: recordId,
    call_id: input.call_id ?? recordId,
    scenario: input.scenario ?? "Emergency Call",
    source: input.source ?? "text",
    created_at: input.created_at ?? nowIso,
    timestamp_formatted: input.timestamp_formatted ?? nowIso,
    original_language: input.original_language ?? "Unknown",
    language_code: input.language_code ?? null,
    language_confidence: Number(input.language_confidence ?? 0),
    transcript_original: input.transcript_original ?? "",
    transcript_english: input.transcript_english ?? "",
    transcript_marathi: input.transcript_marathi ?? "",
    speaker_gender: input.speaker_gender ?? "Male",
    speaker_used: input.speaker_used ?? "shubh",
    original_audio_base64: input.original_audio_base64 ?? "",
    translated_audio_base64: input.translated_audio_base64 ?? "",
    extraction: input.extraction ?? {},
    priority: input.priority ?? {},
    timings: input.timings ?? {},
    llm_used: input.llm_used ?? "rules",
    dispatched: Boolean(input.dispatched ?? false),
    dispatch_info: input.dispatch_info ?? null,
  };
}

async function latest(): Promise<Doc | null> {
  const res = await pool().query("SELECT data FROM records ORDER BY created_at DESC, id DESC LIMIT 1");
  return res.rows.length ? asDoc(res.rows[0].data) : null;
}

export async function saveRecord(input: Doc): Promise<Doc> {
  await ensureSchema();
  const entry = buildEntry(input);
  const prev = await latest();
  if (prev && entry.transcript_original && String(prev.transcript_original ?? "").trim() === String(entry.transcript_original).trim()) {
    entry.id = prev.id;
    entry.call_id = prev.call_id;
    entry.created_at = prev.created_at;
    entry.timestamp_formatted = prev.timestamp_formatted;
  }
  await pool().query(
    `INSERT INTO records (id, call_id, priority_level, original_language, created_at, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       call_id = EXCLUDED.call_id,
       priority_level = EXCLUDED.priority_level,
       original_language = EXCLUDED.original_language,
       created_at = EXCLUDED.created_at,
       data = EXCLUDED.data`,
    [
      entry.id,
      entry.call_id,
      String(entry.priority?.level ?? "MEDIUM"),
      String(entry.original_language ?? "Unknown"),
      entry.created_at,
      JSON.stringify(entry),
    ],
  );
  return entry;
}

export async function getRecords(query?: {
  q?: string;
  priority?: string;
  language?: string;
  limit?: number;
  offset?: number;
}): Promise<Doc[]> {
  await ensureSchema();
  const res = await pool().query("SELECT data FROM records ORDER BY created_at DESC, id DESC");
  let filtered = res.rows.map((r) => asDoc(r.data));
  if (query?.q) {
    const q = query.q.toLowerCase().trim();
    filtered = filtered.filter(
      (r) =>
        String(r.id ?? "").toLowerCase().includes(q) ||
        String(r.scenario ?? "").toLowerCase().includes(q) ||
        String(r.transcript_original ?? "").toLowerCase().includes(q) ||
        String(r.transcript_english ?? "").toLowerCase().includes(q) ||
        String(r.extraction?.location ?? "").toLowerCase().includes(q) ||
        String(r.extraction?.incident_type ?? "").toLowerCase().includes(q),
    );
  }
  if (query?.priority && query.priority.toUpperCase() !== "ALL") {
    const p = query.priority.toUpperCase();
    filtered = filtered.filter((r) => String(r.priority?.level ?? "").toUpperCase() === p);
  }
  if (query?.language && query.language.toUpperCase() !== "ALL") {
    const lang = query.language.toLowerCase();
    filtered = filtered.filter((r) => String(r.original_language ?? "").toLowerCase().includes(lang));
  }
  const limit = query?.limit ?? 100;
  const offset = query?.offset ?? 0;
  return filtered.slice(offset, offset + limit);
}

export async function getRecord(id: string): Promise<Doc | null> {
  await ensureSchema();
  const res = await pool().query("SELECT data FROM records WHERE id = $1 OR call_id = $1 LIMIT 1", [id]);
  return res.rows.length ? asDoc(res.rows[0].data) : null;
}

export async function deleteRecord(id: string): Promise<boolean> {
  await ensureSchema();
  const res = await pool().query("DELETE FROM records WHERE id = $1 OR call_id = $1 RETURNING id", [id]);
  return res.rows.length > 0;
}

export async function clearAll(): Promise<number> {
  await ensureSchema();
  const res = await pool().query("DELETE FROM records RETURNING id");
  return res.rows.length;
}

export async function countRecords(): Promise<number> {
  await ensureSchema();
  const res = await pool().query("SELECT COUNT(*) AS n FROM records");
  return Number(res.rows[0]?.n ?? 0);
}

export async function updateRecordDispatch(id: string, entry: Doc): Promise<boolean> {
  await ensureSchema();
  const current = await getRecord(id);
  if (!current) return false;
  current.dispatched = true;
  current.dispatch_info = entry;
  await pool().query("UPDATE records SET data = $2 WHERE id = $1 OR call_id = $1", [id, JSON.stringify(current)]);
  return true;
}

export async function getAnalytics(): Promise<Doc> {
  await ensureSchema();
  const res = await pool().query("SELECT data FROM records");
  return computeAnalytics(res.rows.map((r) => asDoc(r.data)));
}

export async function getDispatchLog(): Promise<Doc[]> {
  await ensureSchema();
  const res = await pool().query("SELECT data FROM dispatch_log ORDER BY created_at DESC, id DESC");
  return res.rows.map((r) => asDoc(r.data));
}

/** Max-suffix dispatch ids — count-based ids collide after the 200-cap trim. */
function nextId(log: Doc[]): string {
  let max = 0;
  for (const e of log) {
    const m = String(e.id ?? "").match(/^DSP-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `DSP-${String(max + 1).padStart(3, "0")}`;
}

export async function appendDispatchEntry(entry: Doc): Promise<Doc[]> {
  await ensureSchema();
  const log = await getDispatchLog();
  entry.id = nextId(log);
  const row = { ...entry };
  await pool().query("INSERT INTO dispatch_log (id, created_at, data) VALUES ($1, now(), $2)", [
    row.id,
    JSON.stringify(row),
  ]);
  // Trim only past the cap — the NOT IN sweep is the most expensive query here.
  if (log.length + 1 > 200) {
    await pool().query(
      "DELETE FROM dispatch_log WHERE id NOT IN (SELECT id FROM dispatch_log ORDER BY created_at DESC, id DESC LIMIT 200)",
    );
  }
  return getDispatchLog();
}
