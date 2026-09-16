-- 005_operator_auth.sql — operator credentials + token sessions (spec §25).
-- Passwords are bcrypt hashes; tokens are random hex with expiry. Roles:
-- 'admin' (user management) and 'operator' (dispatch/record/source actions).
-- First registered operator becomes admin automatically.

-- Self-contained: the live API applies 002..005 (not 001), so the table is
-- created here if the normalized schema was never applied. id is TEXT with
-- app-supplied UUIDs (gen_random_uuid() would break the pg-mem test double);
-- where 001 already created the UUID-typed table this statement is skipped.
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  password_hash TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE operators ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- NOTE: expires_at has no DB default (the app supplies it) so the pg-mem
-- test double, which cannot parse INTERVAL defaults, applies this file as-is.
-- NOTE: no FOREIGN KEY on operator_id — operators.id is UUID where 001 was
-- applied but TEXT otherwise, and neither Postgres nor pg-mem accepts a
-- cross-type FK. Operators are never deleted (no route), so the app owns
-- this integrity; sessions self-clean via expires_at.
CREATE TABLE IF NOT EXISTS operator_sessions (
  token TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_expiry ON operator_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator ON operator_sessions(operator_id);
