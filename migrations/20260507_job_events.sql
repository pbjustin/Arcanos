CREATE TABLE IF NOT EXISTS job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  trace_id TEXT,
  event_type TEXT NOT NULL,
  worker_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_occurred
  ON job_events(job_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_job_events_trace_id
  ON job_events(trace_id);

CREATE INDEX IF NOT EXISTS idx_job_events_event_type_occurred
  ON job_events(event_type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_job_events_worker_occurred
  ON job_events(worker_id, occurred_at);
