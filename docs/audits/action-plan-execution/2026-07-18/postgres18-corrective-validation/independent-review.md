# Independent database review

## Verdict

- Local verifier correction: **PASS** for deterministic unit, fixture, and
  mocked integration validation.
- Credential containment: **PENDING**.
- Real PostgreSQL 18 integration: **NOT RUN / PENDING**.
- Complete migration revalidation: **FAIL / PENDING**.
- Gate D: **NO-GO**.

The independent reviewer made no source changes and performed no Railway,
database, credential, deployment, or provider mutation.

## Resolved code findings

The reviewer found no remaining code-level blocker in the corrected verifier
paths:

1. Catalog arrays use query-side JSON with a strict existing `pg` array-parser
   fallback; malformed or unexpected forms fail closed.
2. CHECK comparison is quote-aware and normalizes only benign literal casts.
   Operators, constants, columns, boolean structure, and null behavior remain
   semantic. Required mutation categories are covered.
3. Partial indexes are verified by structured identity, keys, ordering,
   uniqueness, predicate, validity, readiness, opclass, collation, and
   expression state.
4. Same-checksum recovery and repeated invalid-index recovery are deterministic;
   `appliedAt` remains success-only and checksum conflicts fail before DDL.
5. Committed one-shot targets cover plan, apply, migration verification,
   runtime verification, drain, and a distinct real-PostgreSQL-18 suite. They
   include pre-Node containment, exact release/target/database identity checks,
   bounded output, timeouts, non-root execution, forced exit, and no restart.
6. The PostgreSQL 18 target emits a bounded server major/minor version only
   after verifying the connected database, public schema, and server version.
7. The final Phase 2D.1 harness at `87900e71` passed 42 local tests and adds
   exact identity and ledger checks, a database-enforced read-only transaction,
   bounded legacy reads, a pre-Node guard, and forced exit.
8. The canonical migration/checksum and lockfile are unchanged; dependency
   cycles remain 63 before and after.

## Remaining release blockers

1. The compromised preview PostgreSQL and Redis credential generations remain
   uncontained. No connection is permitted before approved containment.
2. Neither corrected image has been built locally, and no corrected verifier
   has run against an actual PostgreSQL 18 server.
3. Durable generic attempt/failure history is absent. The canonical ledger is
   one mutable current-state row. The historical incident is preserved here,
   but a generic durable history requires a separately approved additive
   artifact or an explicit acceptance-criterion waiver.
4. Gate R is not ready: Railway's default database templates create public TCP
   proxies. A proven private-only provisioning path is required.
5. The compatibility harness proves bounded legacy module import and direct
   Prisma reads, not full legacy repository initialization or full application
   startup.

The reviewer also identified stale evidence during review. The final evidence
pass corrected the counts and commits, removed obsolete target claims, marked
Gate R not ready, and ran JSON, disclosure, and diff checks before committing.

## Validation reviewed

- Corrective focused suites: 117 passed, 2 real-database cases skipped; three
  repeats passed with seed 271828.
- Phase 2D.1 compatibility: 42 passed at `87900e71`.
- Integration sweep: 84 passed, 3 unavailable real-database cases skipped.
- Type check, build, lint with 0 errors and 90 pre-existing warnings, migration
  plan, boundary checks, commit guard, and all six configs against Railway's
  official schema: pass.
- Full Jest retains one unrelated CRLF marker-portability failure. The final
  silent run recorded 3996 passing tests; an earlier coverage run reviewed by
  the independent agent recorded 3983. Both had exactly one failing test and
  six skipped tests, and the same blob passes its focused 8/8 cases in the LF
  worktree.

## Recommendations

- Pin validator base images by digest and preserve built-image digests at Gate
  V.
- Verify Docker entrypoint/start-command interaction during the first approved
  one-shot deployment.
- Preserve the exact PostgreSQL version, source commit, selected config,
  deployment/image identities, and bounded output in future Gate V evidence.
- Sequence future approvals: private containment design and Gate R; Gate C
  isolation recheck; Gate G when required; Gate V; resolve ledger history; Gate
  M; then consider Gate D separately.

Independent conclusion: the local correction is credible, but it is not a
completed migration-validation pass. Gate D remains **NO-GO**.
