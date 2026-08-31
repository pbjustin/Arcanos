# Worker hard-budget evidence migration

This additive migration introduces the append-only `job_events` evidence used
to atomically enforce rolling worker job-claim and provider-attempt budgets.
It is split because PostgreSQL requires `CREATE INDEX CONCURRENTLY` outside an
explicit transaction.

Apply only during a separately authorized rollout, in this order, with one
reviewed schema/search path:

1. `01_add_budget_evidence_contract.sql`
2. `02_validate_budget_evidence_contract.sql`
3. `03_precheck_budget_indexes.sql`
4. `04_create_group_window_index.sql` as a standalone command
5. `05_create_claim_generation_index.sql` as a standalone command
6. `06_verify_budget_indexes.sql`

Then run all six phases again to prove idempotence. The guards fail closed on
same-name column, constraint, or index drift. An interrupted concurrent build
can leave an exact index invalid; do not drop it casually. Keep all writers
quiesced and use a separately reviewed recovery before rerunning phases 3-6.

Do not activate a compatible worker while any legacy queue claimer or
worker-originated provider path remains able to act without writing this
evidence. Drain all old web/worker claimers, allow existing legacy work to
finish, and keep every legacy claim/provider path quiesced for one complete
one-hour budget window. There is no exact provider-attempt backfill because
legacy retries and multi-stage transports were not recorded centrally. After
that continuous quiet interval, complete and verify the migration, then
activate only compatible binaries. Every replica sharing a `stats_worker_id`
must use the same hard limits.

Rollback is destructive and is not routine recovery. Drain every reader and
writer that knows this contract. Apply `rollback/01_drop_budget_indexes.sql`
and then `rollback/02_drop_budget_evidence_contract.sql`. Rollback refuses any
strict budget evidence or unexpected same-name object.
