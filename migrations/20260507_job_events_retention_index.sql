CREATE INDEX IF NOT EXISTS idx_job_events_occurred_at
  ON job_events(occurred_at);
