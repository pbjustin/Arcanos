-- Run by itself outside an explicit transaction.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_job_events_worker_budget_claim_generation
  ON job_events (job_id, claim_generation)
  WHERE event_type = 'worker.budget.job_claim';
