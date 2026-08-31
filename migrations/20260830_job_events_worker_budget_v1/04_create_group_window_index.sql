-- Run by itself outside an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_events_worker_budget_group_window
  ON job_events (stats_worker_id, event_type, occurred_at, id)
  WHERE event_type IN (
    'worker.budget.job_claim',
    'worker.budget.ai_provider_attempt'
  );
