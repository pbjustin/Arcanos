-- Run this statement by itself, outside an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_data_stats_worker_updated
  ON job_data (stats_worker_id, updated_at)
  WHERE stats_worker_id IS NOT NULL;
