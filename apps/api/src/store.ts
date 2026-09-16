import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAnalytics } from "./analytics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src -> repo root = ../../..
const ROOT = path.resolve(here, "..", "..", "..");
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const DISPATCH_FILE = path.join(DATA_DIR, "dispatch_log.json");

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
