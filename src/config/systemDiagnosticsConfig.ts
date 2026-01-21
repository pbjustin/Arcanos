export const DIAGNOSTIC_WORKER_MAPPING = {
  'audit.cron': 'audit-runner',
  'job.cleanup': 'cleanup-worker',
  'worker.queue': 'task-processor'
} as const;

export const DIAGNOSTIC_JOBS = [
  { name: 'nightly-audit', schedule: '0 2 * * *', route: 'audit.cron' },
  { name: 'hourly-cleanup', schedule: '0 * * * *', route: 'job.cleanup' },
  { name: 'async-processing', schedule: '*/5 * * * *', route: 'worker.queue' }
] as const;

export const DIAGNOSTIC_QUERIES = {
  WORKER_ACTIVITY_LAST_HOUR: `SELECT worker_id, COUNT(*) as activity_count,
              MAX(created_at) as last_activity
       FROM execution_log
       WHERE created_at > NOW() - INTERVAL '1 hour'
       GROUP BY worker_id`,
  JOB_EXECUTIONS_LAST_DAY: `SELECT worker_id, COUNT(*) as executions, MAX(created_at) as last_run
       FROM execution_log
       WHERE created_at > NOW() - INTERVAL '24 hours'
         AND worker_id IN ('audit-runner', 'cleanup-worker', 'task-processor')
       GROUP BY worker_id`,
  ROUTE_ACTIVITY_LAST_HOUR: `SELECT worker_id, COUNT(*) as requests
       FROM execution_log
       WHERE created_at > NOW() - INTERVAL '1 hour'
         AND worker_id IN ('audit-runner', 'cleanup-worker', 'task-processor')
       GROUP BY worker_id`
} as const;
