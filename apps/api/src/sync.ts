import { embedText } from "@rakshak/ai-engine";
import type { PoolLike } from "./db.js";
import type { Doc } from "./store.js";

export interface SyncOptions {
  /** Override for tests; default calls Gemini (null-safe, never throws). */
  embed?: (text: string) => Promise<string | null>;
}

// Normalized backfill (§15): project the live `records` JSON blobs into the
// relational + PostGIS schema (001) so geo/vector queries have real data.
// Embeddings stay NULL until an embedding provider is wired (Gemini emits 768
// dims, the column is VECTOR(1536) — deliberately left for that decision).
// Idempotent: every write is keyed off the record's call id.

export interface NormalizedRows {
  callId: string;
  callStatus: string;
  startedAt: string;
  endedAt: string | null;
  transcriptOriginal: string;
  transcriptEnglish: string;
  transcriptMarathi: string;
  language: string;
  languageCode: string | null;
  confidence: number;
  incidentType: string;
  priority: string;
  priorityConfidence: number;
  reasoning: string;
  summary: string;
  locationRaw: string;
  lat: number | null;
  lon: number | null;
  model: string;
}

/** Pure mapping: record JSON in, normalized rows out. Unit-tested offline. */
export function buildNormalizedRows(record: Doc): NormalizedRows {
  const ext = record.extraction ?? {};
  const prio = record.priority ?? {};
  const geo = ext.geo ?? {};
  const lat = Number(geo.lat);
  const lon = Number(geo.lon);
  return {
    callId: String(record.call_id ?? record.id ?? "unknown"),
    callStatus: record.dispatched ? "dispatched" : "ended",
    startedAt: String(record.created_at ?? new Date().toISOString()),
    endedAt: String(record.created_at ?? new Date().toISOString()),
    transcriptOriginal: String(record.transcript_original ?? ""),
    transcriptEnglish: String(record.transcript_english ?? ""),
    transcriptMarathi: String(record.transcript_marathi ?? ""),
    language: String(record.original_language ?? "Unknown"),
    languageCode: (record.language_code as string | null) ?? null,
    confidence: Number(record.language_confidence ?? 0),
    incidentType: String(ext.incident_type ?? "Unknown"),
    priority: String(prio.level ?? "MEDIUM"),
    priorityConfidence: Number(prio.confidence ?? 0),
    reasoning: String(prio.reasoning ?? ""),
    summary: String(ext.summary ?? ""),
    locationRaw: String(ext.location ?? "Not identified"),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    model: String(record.llm_used ?? "rules"),
  };
}

/** Upsert one record's rows. Returns the incident UUID (or null when skipped). */
export async function syncRecord(
  pool: PoolLike,
  record: Doc,
  opts: SyncOptions = {},
): Promise<{ incidentId: string | null; skipped: boolean }> {
  const row = buildNormalizedRows(record);
  if (!row.callId || row.callId === "unknown") return { incidentId: null, skipped: true };

  await pool.query(
    `INSERT INTO calls (id, status, started_at, ended_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, ended_at = EXCLUDED.ended_at`,
    [row.callId, row.callStatus, row.startedAt, row.endedAt],
  );

  // Re-syncs replace per-call rows: the live record blob is the source of truth.
  await pool.query("DELETE FROM transcripts WHERE call_id = $1", [row.callId]);
  if (row.transcriptOriginal) {
    await pool.query(
      `INSERT INTO transcripts (call_id, speaker, original_text, translated_text, language, language_code, confidence)
       VALUES ($1, 'caller', $2, $3, $4, $5, $6)`,
      [row.callId, row.transcriptOriginal, row.transcriptEnglish || null, row.language, row.languageCode, row.confidence],
    );
  }

  const existing = await pool.query("SELECT id FROM incidents WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1", [
    row.callId,
  ]);
  let incidentId: string | null = existing.rows[0]?.id ? String(existing.rows[0].id) : null;
  if (incidentId) {
    await pool.query(
      `UPDATE incidents SET incident_type = $2, priority = $3, confidence = $4,
         geom = CASE WHEN $5::double precision IS NOT NULL AND $6::double precision IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint($6, $5), 4326) END,
         location_raw = $7, location_normalized = $7, updated_at = now()
       WHERE id = $1`,
      [incidentId, row.incidentType, row.priority, row.priorityConfidence, row.lat, row.lon, row.locationRaw],
    );
    await pool.query("DELETE FROM priority_assessments WHERE incident_id = $1", [incidentId]);
    await pool.query("DELETE FROM ai_explanations WHERE incident_id = $1", [incidentId]);
  } else {
    const inserted = await pool.query(
      `INSERT INTO incidents (call_id, incident_type, status, verification, priority, confidence, geom, location_raw, location_normalized)
       VALUES ($1, $2, 'reported', 'unverified', $3, $4,
         CASE WHEN $5::double precision IS NOT NULL AND $6::double precision IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint($6, $5), 4326) END,
         $7, $7)
       RETURNING id`,
      [row.callId, row.incidentType, row.priority, row.priorityConfidence, row.lat, row.lon, row.locationRaw],
    );
    incidentId = inserted.rows[0]?.id ? String(inserted.rows[0].id) : null;
  }
  if (!incidentId) return { incidentId: null, skipped: true };

  await pool.query(
    `INSERT INTO priority_assessments (incident_id, level, confidence, reasoning, decision_factors)
     VALUES ($1, $2, $3, $4, '[]')`,
    [incidentId, row.priority, row.priorityConfidence, row.reasoning],
  );
  if (row.summary) {
    await pool.query(`INSERT INTO ai_explanations (incident_id, content, model) VALUES ($1, $2, $3)`, [
      incidentId,
      row.summary,
      row.model,
    ]);
  }
  // Vector hook: best-effort, skipped silently when embeddings are unavailable.
  try {
    const vector = await (opts.embed ?? embedText)(
      `${row.incidentType} ${row.locationRaw} ${row.summary} ${row.transcriptEnglish}`.slice(0, 2000),
    );
    if (vector) {
      await pool.query("UPDATE incidents SET embedding = $2::vector WHERE id = $1", [incidentId, vector]);
    }
  } catch {
    /* similarity stays unavailable; relational data is already synced */
  }
  return { incidentId, skipped: false };
}

export interface StoreLike {
  getRecords(query?: { limit?: number }): Promise<Doc[]>;
}

/** Sync every stored record. Continues past single-record failures. */
export async function syncAll(
  pool: PoolLike,
  store: StoreLike,
  opts: SyncOptions = {},
): Promise<{ synced: number; skipped: number; errors: string[] }> {
  const records = await store.getRecords({ limit: 500 });
  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const record of records) {
    try {
      const r = await syncRecord(pool, record, opts);
      if (r.skipped) skipped += 1;
      else synced += 1;
    } catch (err) {
      errors.push(`${record.call_id ?? record.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { synced, skipped, errors: errors.slice(0, 20) };
}
