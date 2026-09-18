-- 006_operator_profiles.sql — operator language profiles + per-call translation toggle.
-- Operators (policemen) join live calls by dialing the public DID; the gateway
-- identifies them by caller ID (mobile_e164 lookup). Profiles store language
-- preferences; call_translation stores the per-call live-translation switch.
CREATE TABLE IF NOT EXISTS operator_profiles (
  operator_id TEXT PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  known_languages TEXT[] NOT NULL DEFAULT '{}',
  default_language TEXT NOT NULL DEFAULT 'hi-IN',
  mobile_e164 TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS call_translation (
  call_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
