# Job worker stats identity migration

This additive migration introduces the exact worker-group identity used by
hourly queue budgets. It is intentionally split because PostgreSQL requires
`CREATE INDEX CONCURRENTLY` to run outside a transaction.

Apply only during a separately authorized rollout, in this order:

1. `01_add_stats_worker_id.sql`
2. `02_precheck_stats_worker_index.sql`
3. `03_create_stats_worker_index.sql` as a standalone, non-transactional command
4. `04_verify_stats_worker_index.sql`

After a successful build, run the four phases again to prove idempotence. The
precheck and verifier fail closed if a same-name object has an unexpected
definition. If phase 3 is interrupted, its exact index can remain not-ready or
invalid and `IF NOT EXISTS` cannot repair it. Keep claims quiesced, run the
atomic guarded `recovery/01_drop_invalid_stats_worker_index.sql`, then rerun
phases 2-4. Recovery takes an access-exclusive table lock and refuses a healthy
index and every unexpected definition, so quiesce all `job_data` readers and
writers for that step. Run every phase with one reviewed, trusted schema/search
path; each guard binds the named object to the resolved `job_data` schema.

Do not enable the exact-identity reader while a legacy binary or any other
`job_data` mutator can still update legacy rows. Compatible-worker bootstrap
runs watchdog and global stale recovery plus GPT lifecycle cleanup before its
exact stats read. Those paths can refresh `updated_at` while
`stats_worker_id` remains null: recoverable running rows can be requeued or
terminalized, pending GPT rows can expire, and retained terminal GPT rows can
later become expired. A quiet-window-only transition is unsupported. Draining
old workers and waiting one hour alone is insufficient, and a one-shot query
cannot close a concurrent-writer race.

Establish one continuous freeze of all `job_data` mutators before inspecting or
changing legacy rows. This includes admission and cancellation paths,
GPT-access and self-healing recovery, workers and inspectors, maintenance
processes, and external database writers. Every transition, including an exact
backfill, must run under the same continuous freeze.

Under that freeze, choose one separately authorized transition:

- use a reviewed, bounded exact backfill based on confirmed deployment-specific
  slot-to-group evidence. It must account for every population in the common
  gate below. Fail closed if any affected row cannot be mapped or accounted for
  exactly.
- use the common gate as a no-backfill transition, without changing legacy
  identities.

For either path, prevent every legacy process from restarting and run the
following common post-transition gate immediately before activation in a
read-only transaction, using the same reviewed schema/search path as the
migration:

```sql
WITH gate AS MATERIALIZED (
  SELECT statement_timestamp() AS gate_at
)
SELECT
  gate.gate_at,
  COUNT(j.id) FILTER (
    WHERE j.job_type <> 'local-agent'
      AND j.status = 'running'
  ) AS all_generic_running_rows,
  COUNT(j.id) FILTER (
    WHERE j.stats_worker_id IS NULL
      AND j.job_type <> 'local-agent'
      AND j.updated_at >= gate.gate_at - INTERVAL '1 hour'
      AND j.status IN ('running', 'completed', 'failed', 'cancelled', 'expired')
  ) AS recent_null_budget_rows,
  COUNT(j.id) FILTER (
    WHERE j.stats_worker_id IS NULL
      AND j.job_type <> 'local-agent'
      AND j.status = 'running'
  ) AS null_recoverable_running_rows,
  COUNT(j.id) FILTER (
    WHERE j.stats_worker_id IS NULL
      AND j.job_type = 'gpt'
      AND j.status = 'pending'
  ) AS null_pending_gpt_rows,
  COUNT(j.id) FILTER (
    WHERE j.stats_worker_id IS NULL
      AND j.job_type = 'gpt'
      AND j.status IN ('completed', 'failed', 'cancelled')
      AND j.retention_until IS NOT NULL
  ) AS null_retained_terminal_gpt_rows,
  MAX(j.updated_at) FILTER (
    WHERE j.stats_worker_id IS NULL
      AND j.job_type <> 'local-agent'
      AND j.status IN ('running', 'completed', 'failed', 'cancelled', 'expired')
  ) AS last_legacy_budget_update
FROM gate
LEFT JOIN job_data j ON TRUE
GROUP BY gate.gate_at;
```

Every count must be zero while the mutator freeze remains active. A nonzero
`recent_null_budget_rows` alone can clear by continuing the frozen quiet period.
A nonzero running, pending-GPT, or retained-terminal-GPT count is a hard stop:
waiting one hour alone is insufficient because bootstrap or a later inspector
can refresh those rows after the check. Use the exact transition/backfill or
abort this attempt. Resuming the legacy cohort to resolve the population
invalidates every result above; stop it again, reestablish the complete mutator
freeze, and restart the full quiet-window proof. Recheck the resolved stats
identity and repeat the gate without lifting the freeze. The compatible worker
must be the first released mutator. Complete compatible worker activation and
verify bootstrap/readiness before releasing any other writer.

Prefix inference is unsupported because the configured stats identity can
differ from the lease-worker prefix.

For rollback, first drain every reader and writer that knows this contract.
Then run `rollback/01_drop_stats_worker_index.sql`, whose catalog guard,
access-exclusive table lock, and ordinary index drop are atomic, before
`rollback/02_drop_stats_worker_id.sql`. Both phases refuse unexpected objects;
column rollback also refuses non-null accounting history or remaining dependent
objects. Dropping the column is not routine recovery.
