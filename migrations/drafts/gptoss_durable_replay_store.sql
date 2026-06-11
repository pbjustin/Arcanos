-- DESIGN DRAFT ONLY
-- DO NOT APPLY
-- NO LIVE DB EXECUTION
-- Phase 5.6 draft for future GPT-OSS private serving durable replay storage.
-- This file is not wired to startup, deployment, CI migration, or any live DB path.

CREATE TABLE IF NOT EXISTS gptoss_private_serving_replay_nonces (
  id UUID PRIMARY KEY,
  key_id TEXT NOT NULL,
  nonce_hash CHAR(64) NOT NULL,
  request_id TEXT NOT NULL,
  body_hash CHAR(64) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  replay_window_seconds INTEGER NOT NULL CHECK (replay_window_seconds > 0),
  audience TEXT NOT NULL,
  subject TEXT,
  source TEXT NOT NULL DEFAULT 'gptoss_private_serving',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gptoss_private_serving_replay_nonces_key_nonce_hash_unique
    UNIQUE (key_id, nonce_hash),
  CONSTRAINT gptoss_private_serving_replay_nonces_nonce_hash_hex
    CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT gptoss_private_serving_replay_nonces_body_hash_hex
    CHECK (body_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS gptoss_private_serving_replay_nonces_expires_at_idx
  ON gptoss_private_serving_replay_nonces (expires_at);

-- No raw nonce column is allowed.
-- No raw request body column is allowed.
-- No signature, signing key, bearer token, cookie, password, or secret column is allowed.
-- Rollback draft, still design-only: DROP TABLE IF EXISTS gptoss_private_serving_replay_nonces;

