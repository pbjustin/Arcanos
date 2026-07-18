# ActionPlan execution migration-attempt history

This separate additive migration installs append-oriented evidence for Phase 2E
schema migration attempts. It does not replace or reinterpret
`ActionPlanExecutionSchemaMigration`: that single row remains the operational
recovery cursor. Attempt headers and events are historical evidence and are
never used to resume a migration.

The installer uses the same reviewed advisory-lock key as
`20260717_action_plan_execution_v2`. On first installation it creates both
history tables and writes one `HISTORY_SCHEMA_INSTALL` attempt plus a completed
phase and terminal-success event in the same transaction. A matching repeat is
read-only. Partial, structurally different, or checksum-mismatched history
objects fail closed.

Every operational apply creates a new attempt before contending for the main
migration lock. Consequently an advisory-lock refusal is durable evidence.
Recovery, refusal, failure, and success are appended as events; no raw error
message, SQL, database URL, payload, path, or stack is accepted by the recorder.

Append-only behavior is enforced by the migration-history API, parameterized
inserts, foreign-key restrictions, sequence uniqueness, and the one-terminal
event index. The tables intentionally do not install owner-bypassing trigger
machinery in this bounded phase. A database owner can still issue direct
`UPDATE` or `DELETE` statements; limiting direct database-owner access remains
an operational control and is a documented residual risk.

There is one unavoidable bootstrap limitation: a failure before the two history
tables and their install marker commit cannot be written to those same tables.
The caller receives a stable failure code, but no durable history row exists.
Canonical artifact validation also occurs before history installation so an
invalid or tampered artifact preserves the existing no-database-mutation
guarantee. This ordering remains in force when valid history tables already
exist: unreviewed artifact bytes never authorize a database write. Such a
preflight refusal therefore has no durable database row and must be retained by
the invoking release evidence instead.

The operational migration verifier requires both the canonical schema and this
history schema. The ordinary application runtime verifier continues to verify
only protocol-activation schema: history is migration evidence, not a runtime
request-path dependency.

Compensation of the Phase 2E protocol schema deliberately leaves these history
tables intact. Removing historical evidence is outside the compensating
rollback contract.
