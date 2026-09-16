-- 004_audit_log.sql — operator action trail (spec §25).
-- Every mutating operator action (dispatch, delete, source attach) appends a
-- row with the actor from the `x-operator` header. The §15 `audit_logs` table
-- (001) serves the normalized phase; this lean table serves the live API in
-- both backends (file mirror: data/audit_log.json, capped at 500).

CREATE TABLE IF NOT EXISTS api_audit_log (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL DEFAULT 'operator',
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  detail JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_api_audit_created ON api_audit_log(created_at DESC);
