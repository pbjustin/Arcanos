-- Additive requester-device authentication. No existing credentials or jobs are changed.
CREATE TABLE IF NOT EXISTS gpt_access_device_pairings (
    pairing_hash TEXT PRIMARY KEY CHECK (pairing_hash ~ '^[0-9a-f]{64}$'),
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin LIKE 'https://%'),
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['jobs.create','jobs.result','capabilities.read','capabilities.run']::text[]),
    capability_actions TEXT[] NOT NULL CHECK (cardinality(capability_actions) <= 4 AND capability_actions <@ ARRAY['git.status','tests.run','patch.preview','patch.apply']::text[]),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '5 minutes'),
    consumed_at TIMESTAMPTZ
  );

CREATE INDEX IF NOT EXISTS idx_gpt_access_device_pairings_expiry ON gpt_access_device_pairings (expires_at);

CREATE TABLE IF NOT EXISTS gpt_access_devices (
    device_id UUID PRIMARY KEY,
    local_identity_hash TEXT NOT NULL CHECK (local_identity_hash ~ '^[0-9a-f]{64}$'),
    credential_hash TEXT NOT NULL UNIQUE CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    principal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin LIKE 'https://%'),
    audience TEXT NOT NULL CHECK (audience = 'gpt-access-device-v1'),
    paired_at TIMESTAMPTZ NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL CHECK (issued_at >= paired_at),
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '1 hour'),
    renewal_expires_at TIMESTAMPTZ NOT NULL CHECK (renewal_expires_at > paired_at AND renewal_expires_at <= paired_at + INTERVAL '720 hours' AND expires_at <= renewal_expires_at),
    revoked_at TIMESTAMPTZ,
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['jobs.create','jobs.result','capabilities.read','capabilities.run']::text[]),
    capability_actions TEXT[] NOT NULL CHECK (cardinality(capability_actions) <= 4 AND capability_actions <@ ARRAY['git.status','tests.run','patch.preview','patch.apply']::text[]),
    gpt_ids TEXT[] NOT NULL CHECK (gpt_ids = ARRAY['arcanos-core']::text[])
  );

CREATE INDEX IF NOT EXISTS idx_gpt_access_devices_owner ON gpt_access_devices (principal_id, workspace_id);
