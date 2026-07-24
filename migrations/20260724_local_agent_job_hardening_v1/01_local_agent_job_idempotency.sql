DO $local_agent_idempotency_preflight$
BEGIN
  IF to_regclass('job_data') IS NULL THEN
    RAISE EXCEPTION 'local-agent hardening requires job_data';
  END IF;

  IF to_regclass('job_events') IS NULL THEN
    RAISE EXCEPTION 'local-agent hardening requires job_events';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id'),
        ('worker_id'),
        ('job_type'),
        ('status'),
        ('input'),
        ('request_fingerprint_hash'),
        ('idempotency_key_hash'),
        ('idempotency_scope_hash'),
        ('idempotency_origin'),
        ('idempotency_until')
    ) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = 'job_data'::regclass
        AND attname = required.column_name
        AND attnum > 0
        AND NOT attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'local-agent hardening requires the complete job_data idempotency envelope';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('job_id'),
        ('trace_id'),
        ('event_type'),
        ('worker_id'),
        ('metadata')
    ) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = 'job_events'::regclass
        AND attname = required.column_name
        AND attnum > 0
        AND NOT attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'local-agent hardening requires the complete job_events lifecycle envelope';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM job_data
    WHERE job_type = 'local-agent'
      AND (
        status IN ('pending', 'running')
        OR idempotency_until > NOW()
      )
      AND (
        COALESCE(input->'job'->>'principal', '') = ''
        OR COALESCE(input->'job'->>'workspace', '') = ''
        OR COALESCE(input->'job'->>'deviceId', '') = ''
        OR COALESCE(input->'job'->>'action', '') = ''
        OR COALESCE(request_fingerprint_hash, '') !~ '^[0-9a-f]{64}$'
        OR COALESCE(idempotency_key_hash, '') !~ '^[0-9a-f]{64}$'
        OR COALESCE(idempotency_scope_hash, '') !~ '^[0-9a-f]{64}$'
        OR COALESCE(idempotency_origin, '') NOT IN ('explicit', 'derived')
        OR idempotency_until IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'live local-agent jobs contain an incomplete idempotency binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM job_data
    WHERE job_type = 'local-agent'
      AND (
        status IN ('pending', 'running')
        OR idempotency_until > NOW()
      )
    GROUP BY
      input->'job'->>'principal',
      input->'job'->>'workspace',
      input->'job'->>'deviceId',
      input->'job'->>'action',
      idempotency_key_hash
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate live local-agent idempotency bindings require manual reconciliation';
  END IF;
END
$local_agent_idempotency_preflight$;

CREATE TABLE IF NOT EXISTS local_agent_job_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  idempotency_scope_hash TEXT NOT NULL,
  request_fingerprint_hash TEXT NOT NULL,
  idempotency_origin VARCHAR(32) NOT NULL,
  job_id UUID NOT NULL,
  idempotency_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_local_agent_job_idempotency_scope
    UNIQUE (
      principal_id,
      workspace_id,
      device_id,
      action,
      idempotency_key_hash
    ),
  CONSTRAINT uq_local_agent_job_idempotency_job
    UNIQUE (job_id),
  CONSTRAINT fk_local_agent_job_idempotency_job
    FOREIGN KEY (job_id)
    REFERENCES job_data(id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_local_agent_job_idempotency_principal
    CHECK (length(btrim(principal_id)) > 0),
  CONSTRAINT chk_local_agent_job_idempotency_workspace
    CHECK (length(btrim(workspace_id)) > 0),
  CONSTRAINT chk_local_agent_job_idempotency_device
    CHECK (length(btrim(device_id)) > 0),
  CONSTRAINT chk_local_agent_job_idempotency_action
    CHECK (length(btrim(action)) > 0),
  CONSTRAINT chk_local_agent_job_idempotency_key_hash
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_local_agent_job_idempotency_scope_hash
    CHECK (idempotency_scope_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_local_agent_job_idempotency_fingerprint_hash
    CHECK (request_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_local_agent_job_idempotency_origin
    CHECK (idempotency_origin IN ('explicit', 'derived')),
  CONSTRAINT chk_local_agent_job_idempotency_expiry
    CHECK (idempotency_until > created_at)
);

INSERT INTO local_agent_job_idempotency (
  principal_id,
  workspace_id,
  device_id,
  action,
  idempotency_key_hash,
  idempotency_scope_hash,
  request_fingerprint_hash,
  idempotency_origin,
  job_id,
  idempotency_until,
  created_at,
  updated_at
)
SELECT
  input->'job'->>'principal',
  input->'job'->>'workspace',
  input->'job'->>'deviceId',
  input->'job'->>'action',
  idempotency_key_hash,
  idempotency_scope_hash,
  request_fingerprint_hash,
  idempotency_origin,
  id,
  idempotency_until,
  LEAST(created_at, idempotency_until - INTERVAL '1 millisecond'),
  NOW()
FROM job_data
WHERE job_type = 'local-agent'
  AND (
    status IN ('pending', 'running')
    OR idempotency_until > NOW()
  )
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_local_agent_job_idempotency_expiry
  ON local_agent_job_idempotency(idempotency_until);
