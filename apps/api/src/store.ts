import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAnalytics, verificationStatus } from "./analytics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src -> repo root = ../../..
const ROOT = path.resolve(here, "..", "..", "..");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const DISPATCH_FILE = path.join(DATA_DIR, "dispatch_log.json");
const SOURCES_FILE = path.join(DATA_DIR, "incident_sources.json");

export type Doc = { [key: string]: any };

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(RECORDS_FILE);
  } catch {
    await fs.writeFile(RECORDS_FILE, "[]", "utf-8");
  }
}

async function loadRaw(): Promise<Doc[]> {
  await ensureDataDir();
  try {
    const content = await fs.readFile(RECORDS_FILE, "utf-8");
    if (!content.trim()) return [];
    const data: unknown = JSON.parse(content);
    return Array.isArray(data) ? (data as Doc[]) : [];
  } catch (err) {
    // Mirror legacy safeguard: move corrupt file aside, refuse silent overwrite.
    try {
      await fs.rename(RECORDS_FILE, `${RECORDS_FILE}.corrupt`);
    } catch { /* ignore */ }
    throw new Error(`records.json is unreadable and was moved aside; refusing to overwrite existing incident data (${err})`);
  }
}

async function saveRaw(records: Doc[]): Promise<void> {
  await ensureDataDir();
  const tmp = `${RECORDS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), "utf-8");
  await fs.rename(tmp, RECORDS_FILE);
}

function newId(prefix: string): string {
  const now = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
  return `${prefix}-${now}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function saveRecord(input: Doc): Promise<Doc> {
  const records = await loadRaw();
  let recordId: string = input.id ?? input.call_id;
  if (!recordId || String(recordId).startsWith("CALL_")) recordId = newId("REC");
  const nowIso = new Date().toISOString();
  const entry: Doc = {
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
  let idx = records.findIndex((r) => r.id === recordId);
  if (idx < 0 && records.length && entry.transcript_original) {
    const latest = records[0];
    if (String(latest.transcript_original ?? "").trim() === String(entry.transcript_original).trim()) {
      idx = 0;
      entry.id = latest.id; entry.call_id = latest.call_id;
      entry.created_at = latest.created_at; entry.timestamp_formatted = latest.timestamp_formatted;
    }
  }
  if (idx >= 0) records[idx] = entry; else records.unshift(entry);
  await saveRaw(records);
  return entry;
}

export async function getRecords(query?: { q?: string; priority?: string; language?: string; limit?: number; offset?: number }): Promise<Doc[]> {
  const records = await loadRaw();
  let filtered = records;
  if (query?.q) {
    const q = query.q.toLowerCase().trim();
    filtered = filtered.filter((r) =>
      String(r.id ?? "").toLowerCase().includes(q) ||
      String(r.scenario ?? "").toLowerCase().includes(q) ||
      String(r.transcript_original ?? "").toLowerCase().includes(q) ||
      String(r.transcript_english ?? "").toLowerCase().includes(q) ||
      String(r.extraction?.location ?? "").toLowerCase().includes(q) ||
      String(r.extraction?.incident_type ?? "").toLowerCase().includes(q));
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
  const records = await loadRaw();
  return records.find((r) => r.id === id || r.call_id === id) ?? null;
}

export async function deleteRecord(id: string): Promise<boolean> {
  const records = await loadRaw();
  const kept = records.filter((r) => r.id !== id && r.call_id !== id);
  if (kept.length === records.length) return false;
  await saveRaw(kept);
  return true;
}

export async function clearAll(): Promise<number> {
  const records = await loadRaw();
  await saveRaw([]);
  return records.length;
}

export async function countRecords(): Promise<number> {
  return (await loadRaw()).length;
}

export async function updateRecordDispatch(id: string, entry: Doc): Promise<boolean> {
  const records = await loadRaw();
  let hit = false;
  for (const r of records) {
    if (r.id === id || r.call_id === id) { r.dispatched = true; r.dispatch_info = entry; hit = true; }
  }
  if (hit) await saveRaw(records);
  return hit;
}

export async function updateRecordGeo(id: string, geo: Doc): Promise<boolean> {
  const records = await loadRaw();
  let hit = false;
  for (const r of records) {
    if (r.id === id || r.call_id === id) {
      r.extraction = { ...(r.extraction ?? {}), geo };
      hit = true;
    }
  }
  if (hit) await saveRaw(records);
  return hit;
}

export async function getAnalytics(): Promise<Doc> {
  return computeAnalytics(await loadRaw());
}

export async function getDispatchLog(): Promise<Doc[]> {
  try {
    const content = await fs.readFile(DISPATCH_FILE, "utf-8");
    const data: unknown = JSON.parse(content);
    return Array.isArray(data) ? (data as Doc[]) : [];
  } catch {
    return [];
  }
}

export interface SourceInput {
  report_id: string;
  source?: string;
  title?: string;
  correlation_score?: number;
  signals?: string[];
}

async function loadSources(): Promise<Doc[]> {
  try {
    const content = await fs.readFile(SOURCES_FILE, "utf-8");
    const data: unknown = JSON.parse(content);
    return Array.isArray(data) ? (data as Doc[]) : [];
  } catch {
    return [];
  }
}

async function saveSources(rows: Doc[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SOURCES_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf-8");
  await fs.rename(tmp, SOURCES_FILE);
}

function toEvidence(row: Doc): Doc {
  return {
    report_id: row.report_id,
    report_source: row.source,
    report_title: row.title,
    correlation_score: Number(row.correlation_score ?? 0),
    signals: row.signals ?? [],
  };
}

/** File mirror of the pg incident_sources ledger: same idempotency + ladder. */
export async function addIncidentSource(incidentKey: string, input: SourceInput): Promise<{ verification: string; reports: number; evidence: Doc[] }> {
  const rows = await loadSources();
  const row: Doc = {
    id: randomUUID(),
    incident_key: incidentKey,
    report_id: input.report_id,
    source: String(input.source ?? "unknown").slice(0, 100),
    title: String(input.title ?? "").slice(0, 500),
    correlation_score: Number(input.correlation_score ?? 0),
    signals: input.signals ?? [],
    created_at: new Date().toISOString(),
  };
  const idx = rows.findIndex((r) => r.incident_key === incidentKey && r.report_id === row.report_id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...row, id: rows[idx].id, created_at: rows[idx].created_at };
  else rows.push(row);
  await saveSources(rows);
  return getIncidentVerification(incidentKey);
}

export async function getIncidentVerification(incidentKey: string): Promise<{ verification: string; reports: number; evidence: Doc[] }> {
  const rows = await loadSources();
  const evidence = rows
    .filter((r) => r.incident_key === incidentKey)
    .sort((a, b) => Number(b.correlation_score ?? 0) - Number(a.correlation_score ?? 0))
    .map(toEvidence);
  const reports = evidence.length + 1;
  return { verification: verificationStatus(reports), reports, evidence };
}

export interface AuditInput {
  actor?: string;
  action: string;
  entity?: string;
  entity_id?: string;
  detail?: unknown;
}

const AUDIT_FILE = path.join(DATA_DIR, "audit_log.json");
const AUDIT_CAP = 500;

async function loadAudit(): Promise<Doc[]> {
  try {
    const content = await fs.readFile(AUDIT_FILE, "utf-8");
    const data: unknown = JSON.parse(content);
    return Array.isArray(data) ? (data as Doc[]) : [];
  } catch {
    return [];
  }
}

/** File mirror of api_audit_log: newest-first, capped. */
export async function appendAudit(input: AuditInput): Promise<Doc[]> {
  const rows = await loadAudit();
  rows.unshift({
    id: `AUD-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`,
    created_at: new Date().toISOString(),
    actor: String(input.actor ?? "operator").slice(0, 100),
    action: String(input.action).slice(0, 100),
    entity: String(input.entity ?? "").slice(0, 100),
    entity_id: String(input.entity_id ?? "").slice(0, 200),
    detail: input.detail ?? {},
  });
  const next = rows.slice(0, AUDIT_CAP);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${AUDIT_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
  await fs.rename(tmp, AUDIT_FILE);
  return getAuditLog(50);
}

export async function getAuditLog(limit = 50): Promise<Doc[]> {
  return (await loadAudit()).slice(0, Math.max(1, Math.min(limit, AUDIT_CAP)));
}

const OPERATORS_FILE = path.join(DATA_DIR, "operators.json");
const SESSIONS_FILE = path.join(DATA_DIR, "operator_sessions.json");

async function loadJson(file: string): Promise<Doc[]> {
  try {
    const content = await fs.readFile(file, "utf-8");
    const data: unknown = JSON.parse(content);
    return Array.isArray(data) ? (data as Doc[]) : [];
  } catch {
    return [];
  }
}

async function saveJson(file: string, rows: Doc[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

export interface OperatorInput {
  name: string;
  role?: string;
  passwordHash?: string | null;
}

/** File mirror of the operators/sessions tables: same first-is-admin rule. */
export async function countOperators(): Promise<number> {
  return (await loadJson(OPERATORS_FILE)).length;
}

export async function findOperatorByName(name: string): Promise<Doc | null> {
  const rows = await loadJson(OPERATORS_FILE);
  return rows.find((r) => String(r.name ?? "").toLowerCase() === String(name).toLowerCase()) ?? null;
}

export async function createOperator(input: OperatorInput): Promise<Doc> {
  const rows = await loadJson(OPERATORS_FILE);
  const entry: Doc = {
    id: randomUUID(),
    name: String(input.name).slice(0, 100),
    role: rows.length === 0 ? "admin" : String(input.role ?? "operator").slice(0, 20),
    password_hash: input.passwordHash ?? null,
    active: true,
    created_at: new Date().toISOString(),
  };
  rows.push(entry);
  await saveJson(OPERATORS_FILE, rows);
  const { password_hash: _ph, ...safe } = entry;
  return safe;
}

export async function createSession(operatorId: string, token: string, expiresAt: string): Promise<void> {
  const rows = await loadJson(SESSIONS_FILE);
  rows.push({ token, operator_id: operatorId, created_at: new Date().toISOString(), expires_at: expiresAt });
  await saveJson(SESSIONS_FILE, rows);
}

export async function resolveSession(token: string): Promise<Doc | null> {
  const now = new Date().toISOString();
  const rows = await loadJson(SESSIONS_FILE);
  const live = rows.filter((r) => String(r.expires_at ?? "") > now);
  if (live.length !== rows.length) await saveJson(SESSIONS_FILE, live);
  const hit = live.find((r) => r.token === token);
  if (!hit) return null;
  const op = (await loadJson(OPERATORS_FILE)).find((r) => r.id === hit.operator_id && r.active !== false);
  return op ? { id: op.id, name: op.name, role: op.role, active: true } : null;
}

export async function revokeSession(token: string): Promise<void> {
  await saveJson(SESSIONS_FILE, (await loadJson(SESSIONS_FILE)).filter((r) => r.token !== token));
}

export async function updatePasswordHash(operatorId: string, passwordHash: string): Promise<boolean> {
  const rows = await loadJson(OPERATORS_FILE);
  const hit = rows.find((r) => r.id === operatorId);
  if (!hit) return false;
  hit.password_hash = passwordHash;
  await saveJson(OPERATORS_FILE, rows);
  return true;
}

export async function revokeOtherSessions(operatorId: string, keepToken: string): Promise<void> {
  await saveJson(
    SESSIONS_FILE,
    (await loadJson(SESSIONS_FILE)).filter((r) => !(r.operator_id === operatorId && r.token !== keepToken)),
  );
}

/** Next dispatch id from the max existing suffix — count-based ids collide after the 200-cap trim. */
export function nextDispatchId(log: Doc[]): string {
  let max = 0;
  for (const e of log) {
    const m = String(e.id ?? "").match(/^DSP-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `DSP-${String(max + 1).padStart(3, "0")}`;
}

export async function appendDispatchEntry(entry: Doc): Promise<Doc[]> {
  const log = await getDispatchLog();
  entry.id = nextDispatchId(log);
  const next = [entry, ...log].slice(0, 200);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DISPATCH_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
  await fs.rename(tmp, DISPATCH_FILE);
  return next;
}

const OPERATOR_PROFILES_FILE = path.join(DATA_DIR, "operator_profiles.json");
const CALL_TRANSLATION_FILE = path.join(DATA_DIR, "call_translation.json");

/** Normalize to E.164-ish form: strip all whitespace, ensure leading +. */
export function normalizeMobileE164(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, "").trim();
  if (!s) return null;
  return s.startsWith("+") ? s : `+${s}`;
}

function toPublicProfile(row: Doc): Doc {
  return {
    operator_id: String(row.operator_id),
    known_languages: Array.isArray(row.known_languages) ? row.known_languages : [],
    default_language: String(row.default_language ?? "hi-IN"),
    mobile_e164: row.mobile_e164 ?? null,
    active: row.active !== false,
  };
}

export async function getOperatorProfile(operatorId: string): Promise<Doc | null> {
  const rows = await loadJson(OPERATOR_PROFILES_FILE);
  const hit = rows.find((r) => String(r.operator_id) === String(operatorId));
  return hit ? toPublicProfile(hit) : null;
}

export interface OperatorProfilePatch {
  known_languages?: string[];
  default_language?: string;
  mobile_e164?: string | null;
}

export async function upsertOperatorProfile(operatorId: string, patch: OperatorProfilePatch): Promise<Doc> {
  const rows = await loadJson(OPERATOR_PROFILES_FILE);
  const oid = String(operatorId);
  const normalizedMobile =
    patch.mobile_e164 === undefined ? undefined : normalizeMobileE164(patch.mobile_e164);
  if (normalizedMobile) {
    const clash = rows.find(
      (r) => String(r.operator_id) !== oid && r.mobile_e164 && String(r.mobile_e164) === normalizedMobile,
    );
    if (clash) throw new Error("mobile_taken");
  }
  let existing = rows.find((r) => String(r.operator_id) === oid);
  if (!existing) {
    existing = {
      operator_id: oid,
      known_languages: [],
      default_language: "hi-IN",
      mobile_e164: null,
      active: true,
      updated_at: new Date().toISOString(),
    };
    rows.push(existing);
  }
  if (patch.known_languages !== undefined) existing.known_languages = [...patch.known_languages];
  if (patch.default_language !== undefined) existing.default_language = patch.default_language;
  if (patch.mobile_e164 !== undefined) existing.mobile_e164 = normalizedMobile;
  if (existing.active === undefined) existing.active = true;
  existing.updated_at = new Date().toISOString();
  await saveJson(OPERATOR_PROFILES_FILE, rows);
  return toPublicProfile(existing);
}

export async function findOperatorProfileByMobile(mobile: string): Promise<Doc | null> {
  const norm = normalizeMobileE164(mobile);
  if (!norm) return null;
  const rows = await loadJson(OPERATOR_PROFILES_FILE);
  const hit = rows.find((r) => r.mobile_e164 && String(r.mobile_e164) === norm);
  return hit ? toPublicProfile(hit) : null;
}

export async function getCallTranslation(callId: string): Promise<{ call_id: string; enabled: boolean }> {
  const rows = await loadJson(CALL_TRANSLATION_FILE);
  const hit = rows.find((r) => String(r.call_id) === String(callId));
  if (!hit) return { call_id: String(callId), enabled: false };
  return { call_id: String(hit.call_id), enabled: Boolean(hit.enabled) };
}

export async function setCallTranslation(
  callId: string,
  enabled: boolean,
): Promise<{ call_id: string; enabled: boolean }> {
  const rows = await loadJson(CALL_TRANSLATION_FILE);
  const cid = String(callId);
  const flag = Boolean(enabled);
  const hit = rows.find((r) => String(r.call_id) === cid);
  if (hit) {
    hit.enabled = flag;
    hit.updated_at = new Date().toISOString();
  } else {
    rows.push({ call_id: cid, enabled: flag, updated_at: new Date().toISOString() });
  }
  await saveJson(CALL_TRANSLATION_FILE, rows);
  return { call_id: cid, enabled: flag };
}
