# ActionPlan execution protocol v2 migration

Status: approved for local implementation and explicit local-ephemeral testing only.

This migration is additive. It leaves existing `ActionPlan`, `Action`, and
`ExecutionResult` rows unchanged, adds nullable provenance fields, and creates
authoritative command, one-action run, and append-only event tables. Existing
rows remain legacy evidence and are not adopted or backfilled.

The application startup schema bootstrap does not contain this DDL. Normal web
and worker startup may only call the read-only verifier in
`src/core/db/actionPlanExecutionSchema.ts`; protocol activation must fail closed
unless the fixed version and checksum verify.

## Artifact identity

- Migration version: `20260717_action_plan_execution_v2`
- Wire schema label: `action-plan-execution-v1`
- Persisted protocol version: `2`
- Snapshot schema version: `1`
- Reviewed SQL checksum: see `manifest.json`

The checksum covers the migration version plus every ordered forward SQL phase,
with CRLF normalized to LF. The compensating rollback is deliberately excluded
because it is never a forward migration phase.

## Forward phases

1. Transactionally create the narrow migration ledger, add nullable provenance
   columns, and add the legacy-or-v2 provenance check as `NOT VALID`.
2. Build the two existing-table unique indexes one at a time with
   `CREATE UNIQUE INDEX CONCURRENTLY` outside a transaction.
3. Transactionally create the command, run, and event tables and their database
   constraints.
4. Validate the existing-table provenance check.
5. Verify every required table, column, constraint, and index, then mark the
   matching ledger checksum `VALID`.

One pinned session-level advisory lock is held across all phases. A matching
completed rerun performs verification only. A checksum mismatch fails closed.
An interrupted concurrent index is reindexed only when its fixed allowlisted
name exists but PostgreSQL reports it invalid or not ready.

The apply result includes bounded preflight row counts for `ActionPlan`,
`Action`, and legacy `ExecutionResult`, plus JSON `EXPLAIN` plans for existing
identity lookups. Postflight includes the claim-next lookup plan. These records
contain no row values or credentials and should be retained with the later
preview Gate D evidence.

Public protocol validation enforces the reviewed 32 KiB snapshot/output and
4 KiB error limits. PostgreSQL `jsonb` text rendering inserts formatting bytes,
so database checks use conservative 64 KiB snapshot/output and 8 KiB error
ceilings as a second bounded-storage guard without rejecting a valid canonical
wire value at its exact limit.

## Local-ephemeral commands

Set `ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL` in the invoking process. The
tool accepts only a loopback PostgreSQL URL whose database name matches
`arcanos_phase2e_*`. Query parameters and fragments are forbidden so the
PostgreSQL client cannot override the validated host, port, socket, or database.
The tool never reads the ordinary application `DATABASE_URL`.

```text
npm run db:action-plan-execution:plan
npm run db:action-plan-execution:apply-local
npm run db:action-plan-execution:verify-local
npm run db:action-plan-execution:drain-status-local
```

The plan command opens no database connection. Apply and verify require the
dedicated environment variable and explicit local confirmation already embedded
in the package scripts. Output never contains the connection string.

Drain status is read-only. `canDisableAssignment` requires zero `REQUESTED`
runs. `canRevertApplication` additionally requires zero `CLAIMED` and `RUNNING`
runs. `canCompensateEmptySchema` is stricter: all command, run, and event tables
must be empty and no plan may contain Phase 2E provenance.

## Compatibility

- Old application + additive schema: storage-compatible; old code ignores the
  new nullable columns and tables. Old and new command semantics must not serve
  traffic concurrently.
- New application + missing, partial, or mismatched schema: Phase 2E protocol is
  disabled and fails closed.
- Existing rows: unchanged, with all four provenance columns null.
- Existing `ExecutionResult`: retained as legacy evidence; no projection or
  rewrite is performed.

## Compensating rollback

The compensating artifact is for a dedicated local ephemeral database only:

```text
npm run db:action-plan-execution:compensate-local
```

It requires the explicit local and empty confirmations embedded in the package
script. SQL guards require zero command, run, and event rows and require all
provenance fields to remain null. It then removes only the empty Phase 2E
objects. It does not delete or rewrite legacy rows.

For preview or any future production proposal, schema rollback leaves the
additive objects in place. Application rollback must first disable command
creation, drain `REQUESTED`, then disable assignment while drain endpoints stay
available until `CLAIMED` and `RUNNING` counts are zero. Any destructive
preview compensation requires a separate deployment gate and evidence-retention
review. No Railway or production migration is authorized by this artifact.
