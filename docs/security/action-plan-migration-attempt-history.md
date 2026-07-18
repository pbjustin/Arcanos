# ActionPlan migration-attempt history contract

Status: local implementation complete; no Railway migration or deployment is
authorized by this document.

## Purpose and authority

The Phase 2E migration has two deliberately separate persistence roles:

| Record | Authority | Use |
| --- | --- | --- |
| `ActionPlanExecutionSchemaMigration` | Mutable recovery cursor | Resume and verify the canonical `20260717_action_plan_execution_v2` phases. |
| `ActionPlanExecutionSchemaMigrationAttempt` | Append-oriented attempt header | Identify one install, apply, or compensation invocation. |
| `ActionPlanExecutionSchemaMigrationAttemptEvent` | Append-oriented evidence | Preserve recovery, refusal, failure, and success facts for that invocation. |

History never decides where a migration resumes. The canonical ledger remains
the only recovery cursor. Conversely, overwriting the canonical ledger cannot
erase prior attempt events.

The canonical migration artifacts and reviewed checksum remain byte-identical:

- Version: `20260717_action_plan_execution_v2`
- Checksum: `cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533`

History is a separate additive migration:

- Version: `20260718_action_plan_execution_migration_history_v1`
- Checksum: `1e08d934d28546a9b3ae642b6bd0c85baecbe797c2c4f5bc19cc1131208c2f8a`
- Advisory lock: the canonical migration's reviewed lock key

## Schema and bounded fields

An attempt header contains only an opaque attempt ID, migration version,
migration checksum, operation, and database timestamp. Allowed operations are
`HISTORY_SCHEMA_INSTALL`, `APPLY`, and `COMPENSATE`.
`HISTORY_SCHEMA_INSTALL` is reserved to the transactional installer; the
exported attempt-recorder API accepts only `APPLY` and `COMPENSATE`, so callers
cannot fabricate the install-success marker used by verification.

An event contains only an opaque event ID, attempt ID, monotonically allocated
sequence, event type, optional phase identifier, stable reason code, and
database timestamp. Allowed events are:

- `PHASE_COMPLETED`
- `RECOVERY_STARTED`
- `ATTEMPT_REFUSED`
- `ATTEMPT_FAILED`
- `ATTEMPT_SUCCEEDED`

IDs, phases, and reason codes have database-enforced length and character
bounds. Checksums are lowercase SHA-256 hex. No JSON, raw exception, SQL,
database URL, request payload, stack, filesystem path, or credential field
exists in either table.

The event foreign key restricts both update and delete of its attempt identity.
`(attemptId, eventSequence)` is unique. A partial unique index permits at most
one terminal event per attempt. Both reviewed indexes must be valid, ready,
expression-free B-tree indexes with the expected key columns and predicate.
The recorder locks the attempt header and refuses every append after a terminal
event, including later non-terminal events; history cannot continue after its
recorded outcome.

## Attempt and event transitions

Creating a header starts an attempt. An operational apply may append one
`RECOVERY_STARTED` event when the canonical ledger is partial, failed, or not
valid. It then appends exactly one terminal event:

| Outcome | Terminal event | Reason |
| --- | --- | --- |
| Migration accepted | `ATTEMPT_SUCCEEDED` | Applied, equivalent rerun, or recovered final verification. |
| Stable policy/precondition refusal | `ATTEMPT_REFUSED` | Advisory lock, checksum conflict, unknown phase, invalid recovery cursor, or history-schema refusal. |
| Operational/dependency failure | `ATTEMPT_FAILED` | Stable migration code or `MIGRATION_OPERATION_FAILED`. |

An apply can append success only for a `ready: true` result with exactly one of
`applied` or `equivalentRerun` true; recovered final verification must be an
equivalent rerun. Compensation can append success only when both `ok` and
`compensated` are true. Malformed or negative results are terminal failures,
never successful evidence.

The history installer writes `PHASE_COMPLETED` for its one DDL phase followed by
`ATTEMPT_SUCCEEDED`. Canonical per-phase progress remains in the recovery
cursor; this bounded change does not duplicate every canonical phase into
history.

## Atomicity and failure semantics

- First installation holds the canonical advisory lock and commits both DDL,
  the install header, both install events, and exact schema verification in one
  transaction.
- A matching installed schema is verified and reused without reacquiring the
  installation lock. This allows a competing canonical apply to create its
  attempt before it contends for the canonical lock, so lock refusal is durable.
- An attempt header is committed before canonical lock contention.
- Event append locks the attempt header, allocates the next sequence, inserts
  the event, and commits in one transaction.
- The one-terminal partial index resolves concurrent terminal appends at the
  database boundary.
- The canonical migration contains required non-transactional concurrent-index
  phases. Therefore canonical schema mutation and its final history event cannot
  be one database transaction. A process loss between them leaves an attempt
  with no terminal event. That means “outcome unknown; inspect the recovery
  cursor and schema,” not success or failure.
- If terminal-history persistence fails after canonical work, the operation
  fails closed with `MIGRATION_HISTORY_TERMINAL_WRITE_FAILED`; it does not invent
  a terminal event.
- Error annotation is best-effort and cannot replace a frozen authoritative
  dependency error.

Database mutation reporting distinguishes canonical schema mutation from an
appended history record. An equivalent rerun reports no canonical schema
mutation but does report database mutation because it creates a new attempt. A
recovered final verification reports canonical ledger mutation even when the
underlying apply result uses `applied: false`.

## Bootstrap and preflight limits

The database cannot record a failure that occurs before the history tables and
install marker commit. This includes a first-install lock refusal or DDL
failure.

Canonical artifact validation runs before any history lookup or write, even
when history is already installed. Invalid bytes therefore retain the prior
no-database-mutation guarantee but have no history row. The release runner must
retain that stable preflight refusal in its external evidence.

## Append-only boundary and residual risk

Production code exposes parameterized inserts only; it contains no history
update or delete operation. Foreign keys and unique indexes prevent identity
rewrite, duplicate sequence, and duplicate terminal outcomes.

No trigger is installed to block a database owner from issuing direct `UPDATE`
or `DELETE`. Owner access can also alter any trigger, so the current contract
treats restricted direct database access as the operational control. Stronger
database-role separation or protected archival replication is a later-phase
option, not part of this bounded migration.

## Compensation and compatibility

Protocol compensation removes only empty Phase 2E protocol objects. It leaves
both history tables and their evidence intact. Old application code ignores the
two additive tables. No historical execution row or canonical migration row is
backfilled or rewritten by the history installer.

## Verification policy

The local operational migration command and inert migration validator require:

1. both artifact checksums;
2. the canonical schema verifier; and
3. the exact history schema plus install-success marker.

The ordinary application runtime verifier deliberately remains scoped to the
protocol activation schema. Request handling must fail closed when protocol
schema is absent, but migration evidence is not a runtime request-path
dependency. This avoids turning audit-history availability into application
execution authority.

## Future private-preview sequence

A separately approved Railway migration gate should:

1. prove the exact clean source commit and both checksums before connecting;
2. target only the isolated private PostgreSQL service;
3. run the one-shot operational apply, which installs history before applying
   or recovering the canonical migration;
4. run the operational verifier for both schemas and the install marker;
5. retain only stable codes, counts, versions, and checksums in release
   evidence;
6. leave history in place during application rollback or empty-schema
   compensation; and
7. stop on any partial schema, missing marker, terminal-write failure, or
   checksum mismatch.

This repository change performs none of those Railway operations and grants no
preview, staging, or production migration authority.
