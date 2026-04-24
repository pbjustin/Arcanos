CREATE TABLE IF NOT EXISTS worker_liveness (
  worker_id TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL,
  health_status VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_runtime_state (
  worker_id TEXT PRIMARY KEY,
  worker_type VARCHAR(100) NOT NULL,
  health_status VARCHAR(50) NOT NULL,
  current_job_id TEXT,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_inspector_run_at TIMESTAMPTZ,
  state_hash TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS worker_runtime_history (
  id BIGSERIAL PRIMARY KEY,
  worker_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  source VARCHAR(100) NOT NULL,
  health_status VARCHAR(50) NOT NULL,
  current_job_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_worker_runtime_state_health_changed
  ON worker_runtime_state(health_status, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_runtime_history_worker_changed
  ON worker_runtime_history(worker_id, changed_at DESC);
