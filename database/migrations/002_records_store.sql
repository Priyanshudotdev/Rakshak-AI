-- 002_records_store.sql — file-store parity tables for the API (Phase: Postgres cutover).
-- Full record JSON is kept in `data`; scalar columns exist only for indexed
-- filtering. Analytics are computed in code over rows (same as the file
-- store) so behavior is identical in both backends. The normalized §15
-- schema from 001_core.sql is populated in a later phase (PostGIS/vector).

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  priority_level TEXT NOT NULL DEFAULT 'MEDIUM',
  original_language TEXT NOT NULL DEFAULT 'Unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_call ON records(call_id);
CREATE INDEX IF NOT EXISTS idx_records_priority ON records(priority_level);
CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_log (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL
);
