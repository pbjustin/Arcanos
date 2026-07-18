# Phase 2E PostgreSQL 18 corrective validation

This directory records the corrective work following the isolated Phase 2E
migration-validation failure on PostgreSQL 18.4.

The original failure remains historical evidence. Corrective tests may prove
that the same physical schema is valid under a representation-stable verifier,
but they must not rewrite the recorded first-apply failure or imply that a
Railway rerun occurred.

## Gate status

- Local verifier correction: pass for deterministic unit/fixture validation;
  real PostgreSQL 18 execution remains pending.
- Preview credential containment: pending Gate R approval.
- Railway validator deployment: pending Gate V approval.
- Primary preview migration rerun: pending Gate M approval.
- Gate D application deployment: unauthorized and no-go until a complete
  migration-validation pass.
- Committed one-shot targets now cover plan/apply/migration verification,
  runtime verification, drain, and the real disposable-schema PostgreSQL 18
  suite. Docker builds and live PostgreSQL 18 execution remain pending.
- Gate R is not ready to request: Railway's default database templates create
  TCP proxies, which conflicts with the no-public-exposure requirement. A
  proven private-only replacement procedure is required first.

## Safety boundary

Artifacts in this directory contain no credential values, connection strings,
raw Railway variable output, production logs, provider data, or developer-local
absolute paths. Railway evidence is limited to stable identifiers, names-only
variable metadata, counts, and non-sensitive status.
