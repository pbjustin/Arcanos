# Temporary GPT-OSS migration-guard test waiver

Status: **TEMPORARY PUBLICATION-READINESS WAIVER — FULL JEST IS NOT GREEN**

Decision date: `2026-07-21`

Validated source state: `653c995a30c8098fe87b2c92bb34a62a1cca2d34`

Upstream integrated through: `7f2a85c1c7c2338f8e472482d1b43bf9d0cf3f41`

## Decision

Temporarily accept the single failure in
`tests/gptoss-private-serving-durable-replay-migration-guard.test.ts` for the
purpose of preparing and publishing the cumulative Phase 2A–2E draft pull
request. This waiver records a reviewed exception; it does not convert the
failed `npm test` result into a passing result.

The waived assertion is:

```text
gptoss durable replay migration guard
  detects missing required draft markers
```

The direct suite rerun produced seven passing tests and this one failure. The
failure expected `ok=false` and `migrationDraftReady=false` after removing the
`DO NOT APPLY` marker, but received `ok=true` and
`migrationDraftReady=true`.

## Basis

The test, guard, and migration draft are owned by this cumulative branch and
were introduced before the native PR-preview hardening. The failure is
unrelated to the subsequent `origin/main` refresh and preview-hardening edits:

- neither the failing test nor its guard implementation changed between
  `93db90ccb8ecee3d9a7059ce925900d537f2fb5a` and the validated source state;
- the Windows checkout has `core.autocrlf=true`, and the migration draft uses
  CRLF line endings;
- the test attempts to remove each required marker with an LF-only string, so
  the mutation does not remove the CRLF-terminated marker in this checkout;
- the guard remains fail-closed for apply: `applyAllowed=false` and
  `liveDbWrite=false`; and
- the native PR preview path does not apply this or any other migration.

Current validation evidence remains otherwise positive: the focused
PR-preview, GPT-access, opaque-secret, and job-hardening suites passed; guard,
boundary, type, lint, build, Railway compatibility, backend-CLI, and sync
checks passed; and the Python suite passed 450 tests. Lint retained existing
warnings and reported no errors.

## Scope and limits

This waiver applies only to the one named assertion and only to draft PR
publication readiness for the cumulative passive preview candidate. It does
not waive:

- any other test failure;
- migration execution or migration-readiness requirements;
- active preview, provider, database, Redis, worker, or executor gates;
- Railway isolation, secret, domain, or TCP-proxy requirements;
- pull-request merge or release readiness; or
- production deployment.

Before merge, release, any active preview gate, or any migration action, rerun
the full suite and either correct the line-ending-sensitive test or record a
new, explicitly scoped decision.
