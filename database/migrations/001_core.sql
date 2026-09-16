-- 001_core.sql — Rakshak V2 core schema (spec §15).
-- Postgres + PostGIS + pgvector. Audio blobs live in S3-compatible store; DB keeps metadata.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  asterisk_channel_id TEXT,
  caller_id TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  audio_s3_key TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL DEFAULT 'caller',
  original_text TEXT NOT NULL,
  translated_text TEXT,
  language TEXT,
  language_code TEXT,
  confidence DOUBLE PRECISION,
  is_partial BOOLEAN NOT NULL DEFAULT false,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  incident_type TEXT NOT NULL DEFAULT 'Unknown',
  status TEXT NOT NULL DEFAULT 'reported',
  verification TEXT NOT NULL DEFAULT 'unverified',
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  geom GEOMETRY(Point, 4326),
  location_raw TEXT,
  location_normalized TEXT,
  city TEXT,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS priority_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  reasoning TEXT NOT NULL DEFAULT '',
  decision_factors JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_explanations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id);
CREATE INDEX IF NOT EXISTS idx_incidents_call ON incidents(call_id);
CREATE INDEX IF NOT EXISTS idx_incidents_geom ON incidents USING GIST (geom);
