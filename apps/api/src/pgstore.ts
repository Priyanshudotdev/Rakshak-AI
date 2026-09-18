import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { selectedPool } from "./db.js";
import { computeAnalytics, verificationStatus } from "./analytics.js";
import type { Doc } from "./store.js";

// Postgres backend with file-store-identical semantics (see pgstore.test.ts
// equivalence coverage). DDL comes from database/migrations/002_* and 003_*
// — the same files applied in production — so tests and prod cannot drift.

let schemaReady = false;

const MIGRATIONS = [
  "002_records_store.sql",
  "003_verification_sources.sql",
  "004_audit_log.sql",
  "005_operator_auth.sql",
  "006_operator_profiles.sql",
];

function pool() {
  const p = selectedPool();
  if (!p) throw new Error("Postgres backend selected but no pool is configured");
  return p;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = MIGRATIONS.map((f) =>
    readFileSync(new URL(`../../../database/migrations/${f}`, import.meta.url), "utf-8"),
  ).join("\n")
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

export async function updateRecordGeo(id: string, geo: Doc): Promise<boolean> {
  await ensureSchema();
  const current = await getRecord(id);
  if (!current) return false;
  current.extraction = { ...(current.extraction ?? {}), geo };
  await pool().query("UPDATE records SET data = $2 WHERE id = $1 OR call_id = $1", [id, JSON.stringify(current)]);
  return true;
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

export interface SourceInput {
  report_id: string;
  source?: string;
  title?: string;
  correlation_score?: number;
  signals?: string[];
}

/** Durable corroboration ledger (§19): idempotent per report, status derives
 *  from distinct-report counts + 1 for the original call. */
export async function addIncidentSource(incidentKey: string, input: SourceInput): Promise<{ verification: string; reports: number; evidence: Doc[] }> {
  await ensureSchema();
  await pool().query(
    `INSERT INTO incident_sources (id, incident_key, report_id, source, title, correlation_score, signals)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (incident_key, report_id) DO UPDATE SET
       source = EXCLUDED.source, title = EXCLUDED.title,
       correlation_score = EXCLUDED.correlation_score, signals = EXCLUDED.signals`,
    [
      randomUUID(),
      incidentKey,
      input.report_id,
      String(input.source ?? "unknown").slice(0, 100),
      String(input.title ?? "").slice(0, 500),
      Number(input.correlation_score ?? 0),
      JSON.stringify(input.signals ?? []),
    ],
  );
  return getIncidentVerification(incidentKey);
}

export interface AuditInput {
  actor?: string;
  action: string;
  entity?: string;
  entity_id?: string;
  detail?: unknown;
}

export async function appendAudit(input: AuditInput): Promise<Doc[]> {
  await ensureSchema();
  await pool().query(
    "INSERT INTO api_audit_log (id, actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      `AUD-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`,
      String(input.actor ?? "operator").slice(0, 100),
      String(input.action).slice(0, 100),
      String(input.entity ?? "").slice(0, 100),
      String(input.entity_id ?? "").slice(0, 200),
      JSON.stringify(input.detail ?? {}),
    ],
  );
  return getAuditLog(50);
}

export async function getAuditLog(limit = 50): Promise<Doc[]> {
  await ensureSchema();
  const res = await pool().query(
    "SELECT id, created_at, actor, action, entity, entity_id, detail FROM api_audit_log ORDER BY created_at DESC, id DESC LIMIT $1",
    [Math.max(1, Math.min(limit, 500))],
  );
  return res.rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    entity_id: r.entity_id,
    detail: typeof r.detail === "string" ? JSON.parse(r.detail) : (r.detail ?? {}),
  }));
}

export interface OperatorInput {
  name: string;
  role?: string;
  passwordHash?: string | null;
}

/** Operator accounts (§25). First registered operator becomes admin. */
export async function countOperators(): Promise<number> {
  await ensureSchema();
  const res = await pool().query("SELECT COUNT(*) AS n FROM operators");
  return Number(res.rows[0]?.n ?? 0);
}

export async function findOperatorByName(name: string): Promise<Doc | null> {
  await ensureSchema();
  const res = await pool().query("SELECT id, name, role, password_hash, active, created_at FROM operators WHERE lower(name) = lower($1) LIMIT 1", [name]);
  return res.rows[0] ?? null;
}

export async function createOperator(input: OperatorInput): Promise<Doc> {
  await ensureSchema();
  const role = (await countOperators()) === 0 ? "admin" : String(input.role ?? "operator").slice(0, 20);
  const res = await pool().query(
    // id is app-supplied: fresh 005 tables use TEXT with no default, while
    // 001-created UUID tables accept the same uuid string. Never return hash.
    "INSERT INTO operators (id, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, role, active, created_at",
    [randomUUID(), String(input.name).slice(0, 100), role, input.passwordHash ?? null],
  );
  return res.rows[0];
}

export async function createSession(operatorId: string, token: string, expiresAt: string): Promise<void> {
  await ensureSchema();
  await pool().query("INSERT INTO operator_sessions (token, operator_id, expires_at) VALUES ($1, $2, $3)", [
    token,
    operatorId,
    expiresAt,
  ]);
}

export async function resolveSession(token: string): Promise<Doc | null> {
  await ensureSchema();
  const res = await pool().query(
    // o.id::text — operators.id is UUID where 001 was applied, TEXT otherwise.
    `SELECT o.id, o.name, o.role, o.active
     FROM operator_sessions s JOIN operators o ON o.id::text = s.operator_id
     WHERE s.token = $1 AND s.expires_at > now() AND o.active = true LIMIT 1`,
    [token],
  );
  if (!res.rows.length) {
    await pool().query("DELETE FROM operator_sessions WHERE token = $1 OR expires_at <= now()", [token]);
    return null;
  }
  return res.rows[0];
}

export async function revokeSession(token: string): Promise<void> {
  await ensureSchema();
  await pool().query("DELETE FROM operator_sessions WHERE token = $1", [token]);
}

export async function updatePasswordHash(operatorId: string, passwordHash: string): Promise<boolean> {
  await ensureSchema();
  const res = await pool().query("UPDATE operators SET password_hash = $2 WHERE id = $1", [operatorId, passwordHash]);
  return (res.rowCount ?? 0) > 0;
}

export async function revokeOtherSessions(operatorId: string, keepToken: string): Promise<void> {
  await ensureSchema();
  // operator_id may be TEXT or UUID depending on which migration created it.
  await pool().query("DELETE FROM operator_sessions WHERE operator_id::text = $1 AND token <> $2", [
    String(operatorId),
    keepToken,
  ]);
}

export async function getIncidentVerification(incidentKey: string): Promise<{ verification: string; reports: number; evidence: Doc[] }> {
  await ensureSchema();
  const res = await pool().query(
    "SELECT report_id, source, title, correlation_score, signals FROM incident_sources WHERE incident_key = $1 ORDER BY correlation_score DESC",
    [incidentKey],
  );
  const evidence = res.rows.map((r) => ({
    report_id: r.report_id,
    report_source: r.source,
    report_title: r.title,
    correlation_score: Number(r.correlation_score ?? 0),
    signals: typeof r.signals === "string" ? JSON.parse(r.signals) : (r.signals ?? []),
  }));
  const reports = evidence.length + 1; // +1 for the original call report
  return { verification: verificationStatus(reports), reports, evidence };
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

/** Normalize to E.164-ish form: strip all whitespace, ensure leading +. */
export function normalizeMobileE164(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, "").trim();
  if (!s) return null;
  return s.startsWith("+") ? s : `+${s}`;
}

function toPublicProfile(r: Doc): Doc {
  let langs: unknown = r.known_languages;
  if (typeof langs === "string") {
    try {
      langs = JSON.parse(langs);
    } catch {
      langs = [];
    }
  }
  return {
    operator_id: String(r.operator_id),
    known_languages: Array.isArray(langs) ? langs : [],
    default_language: String(r.default_language ?? "hi-IN"),
    mobile_e164: r.mobile_e164 ?? null,
    active: r.active !== false,
  };
}

export async function getOperatorProfile(operatorId: string): Promise<Doc | null> {
  await ensureSchema();
  const res = await pool().query(
    "SELECT operator_id, known_languages, default_language, mobile_e164, active FROM operator_profiles WHERE operator_id = $1 LIMIT 1",
    [String(operatorId)],
  );
  return res.rows.length ? toPublicProfile(res.rows[0]) : null;
}

export interface OperatorProfilePatch {
  known_languages?: string[];
  default_language?: string;
  mobile_e164?: string | null;
}

export async function upsertOperatorProfile(operatorId: string, patch: OperatorProfilePatch): Promise<Doc> {
  await ensureSchema();
  const oid = String(operatorId);
  const existing = await getOperatorProfile(oid);
  const known = patch.known_languages !== undefined ? [...patch.known_languages] : (existing?.known_languages ?? []);
  const defLang =
    patch.default_language !== undefined ? patch.default_language : (existing?.default_language ?? "hi-IN");
  const mobile =
    patch.mobile_e164 !== undefined ? normalizeMobileE164(patch.mobile_e164) : (existing?.mobile_e164 ?? null);
  try {
    const res = await pool().query(
      `INSERT INTO operator_profiles (operator_id, known_languages, default_language, mobile_e164)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operator_id) DO UPDATE SET
         known_languages = EXCLUDED.known_languages,
         default_language = EXCLUDED.default_language,
         mobile_e164 = EXCLUDED.mobile_e164,
         updated_at = now()
       RETURNING operator_id, known_languages, default_language, mobile_e164, active`,
      [oid, known, defLang, mobile],
    );
    return toPublicProfile(res.rows[0]);
  } catch (err) {
    if (/duplicate|unique/i.test(String(err))) throw new Error("mobile_taken");
    throw err;
  }
}

export async function findOperatorProfileByMobile(mobile: string): Promise<Doc | null> {
  await ensureSchema();
  const norm = normalizeMobileE164(mobile);
  if (!norm) return null;
  const res = await pool().query(
    "SELECT operator_id, known_languages, default_language, mobile_e164, active FROM operator_profiles WHERE mobile_e164 = $1 LIMIT 1",
    [norm],
  );
  return res.rows.length ? toPublicProfile(res.rows[0]) : null;
}

export async function getCallTranslation(callId: string): Promise<{ call_id: string; enabled: boolean }> {
  await ensureSchema();
  const res = await pool().query("SELECT call_id, enabled FROM call_translation WHERE call_id = $1 LIMIT 1", [
    String(callId),
  ]);
  if (!res.rows.length) return { call_id: String(callId), enabled: false };
  return { call_id: String(res.rows[0].call_id), enabled: Boolean(res.rows[0].enabled) };
}

export async function setCallTranslation(
  callId: string,
  enabled: boolean,
): Promise<{ call_id: string; enabled: boolean }> {
  await ensureSchema();
  const cid = String(callId);
  const flag = Boolean(enabled);
  const res = await pool().query(
    `INSERT INTO call_translation (call_id, enabled) VALUES ($1, $2)
     ON CONFLICT (call_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING call_id, enabled`,
    [cid, flag],
  );
  return { call_id: String(res.rows[0].call_id), enabled: Boolean(res.rows[0].enabled) };
}
