DROP INDEX IF EXISTS idx_worker_runtime_history_worker_changed;
DROP INDEX IF EXISTS idx_worker_runtime_state_health_changed;

DROP TABLE IF EXISTS worker_runtime_history;
DROP TABLE IF EXISTS worker_runtime_state;
DROP TABLE IF EXISTS worker_liveness;
