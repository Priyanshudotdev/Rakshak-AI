-- 003_verification_sources.sql — durable corroboration ledger (spec §19).
-- Live incidents are keyed by call/record id text (LIVE-*, REC-*, ...), not by
-- the normalized incidents UUID (populated in a later phase), so incident_key
-- is TEXT. Status is derived from distinct-report counts, same ladder as the
-- original in-memory worker map: 1 -> unverified, 2-3 -> multiple_reports,
-- >=4 -> corroborated. officially_confirmed stays operator-only via dispatch.

-- NOTE: id is app-generated (randomUUID) TEXT, not gen_random_uuid(), so the
-- pg-mem test double — which lacks that function — can apply this file as-is.
CREATE TABLE IF NOT EXISTS incident_sources (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL,
  report_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  title TEXT NOT NULL DEFAULT '',
  correlation_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  signals JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_key, report_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_sources_key ON incident_sources(incident_key);
