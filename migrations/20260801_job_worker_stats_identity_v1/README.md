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

Do not enable the exact-identity reader while old workers are claiming jobs:
old binaries do not stamp `stats_worker_id`. Draining old workers alone is not
a safe cutover because their terminal rows can remain inside the trailing
one-hour accounting window as unattributed nulls. Choose one separately
authorized transition:

- drain old workers and keep every generic claim quiesced until one full hour
  after the last legacy row's final update, verify that no budget-eligible
  running/terminal row in that hour has a null identity, then start compatible
  writers and readers together; or
- use a reviewed, bounded exact backfill or transition reader based on confirmed
  deployment-specific slot-to-group evidence.

Prefix inference is unsupported because the configured stats identity can
differ from the lease-worker prefix.

For rollback, first drain every reader and writer that knows this contract.
Then run `rollback/01_drop_stats_worker_index.sql`, whose catalog guard,
access-exclusive table lock, and ordinary index drop are atomic, before
`rollback/02_drop_stats_worker_id.sql`. Both phases refuse unexpected objects;
column rollback also refuses non-null accounting history or remaining dependent
objects. Dropping the column is not routine recovery.
