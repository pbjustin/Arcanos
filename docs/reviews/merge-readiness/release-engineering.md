# Release Engineering Review — PR 1408

## Review identity

- Review round: final production-readiness review
- Reviewer: independent Release Engineering reviewer
- Pull request: `#1408` — `feat: add hardened productivity and local-agent capabilities`
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Exact runtime candidate: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Diff inspected: 125 files, 35,999 insertions, 312 deletions
- Verdict: **APPROVE WITH CONDITIONS**
- Reviewer confidence: **high (0.96)**
- Open Critical findings: **0**
- Open High findings: **0**

This approval is conditional on the exact-head CI and review-artifact gates
listed below completing successfully. A failed required check, or any runtime
change after `f7f3a2ca`, automatically returns this review to
**REQUEST CHANGES** until the new candidate is revalidated.

This review does not authorize merging or production deployment.

## Independent scope and method

I independently inspected the complete pull-request diff rather than relying
on another reviewer's coverage. The review included:

- all changed TypeScript gateway, route, module, service, repository,
  middleware, worker-control, diagnostics, confirmation, and protocol code;
- all changed Python daemon, polling, journal, handler, filesystem, Git,
  patch, process, and sandbox code;
- generated TypeScript and Python capability contracts;
- all changed Jest, `node:test`, and pytest suites;
- productivity and local-agent migrations, manifests, checksum guards,
  compensation behavior, indexes, runtime schema mirrors, and database tests;
- maintained architecture, security, preview, setup, configuration, migration,
  API, OpenAPI, and operator documentation;
- GitHub Actions changes, package scripts, the preview verifier, Railway
  compatibility logic, and the unchanged executable Railway contract used by
  this branch (`railway.json`, `Dockerfile`, and
  `scripts/start-railway-service.mjs`).

No product code was modified by this reviewer. No production or Phase 2E
resource, database, variable, credential, deployment, Custom GPT, or daemon
registration was changed.

## Executive release assessment

The candidate preserves the intended release architecture:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript authentication, authorization, confirmation, tenancy,
     auditing, tracing, persistence, and job creation
  -> existing PostgreSQL job lifecycle
  -> private outbound Python daemon
  -> fixed typed handler
  -> correlated structured result
```

The PR does not add:

- a public Python API;
- a second queue or workflow engine;
- direct Python PostgreSQL access;
- a generic shell capability;
- a parallel authentication or confirmation system;
- legacy route exposure; or
- control-plane execution through `/gpt/:gptId`.

The Railway API and worker retain the existing
`ARCANOS_PROCESS_KIND=web|worker` startup contract. The local-agent migration
is explicit and fail-closed. Missing executor or sandbox configuration does
not silently enable the feature.

## Findings

### REL-FINAL-001 — Timing-sensitive local-agent expiry test

- Original severity: **High**
- Confidence: high
- Status: **resolved**
- Runtime impact: none identified

The CI run for commit `a3d2251f` failed one changed unit test:

```text
tests/local-agent-job-repository.test.ts
  rejects a result submitted after the server-controlled job expiry
```

The mocked repository held a fixed database clock while the test constructed
its expiry with `Date.now() - 1`. At a millisecond boundary, the nominally
expired timestamp could be newer than the mocked database clock. Runtime code
correctly compares against PostgreSQL `NOW()`.

Commit `0808eb1f` changed only this test to derive the lease and expiry from the
same mocked database clock. The focused repository suite then passed 14/14,
and the formerly failing case passed 20 consecutive repetitions. No runtime
behavior was weakened and no failure was waived.

The exact `f7f3a2ca` unit shard was still running when this review artifact was
frozen. Its successful completion is a mandatory approval condition below.

### REL-FINAL-002 — Preview safety harness was not required by CI

- Original severity: **Medium**
- Confidence: high
- Status: **resolved**

The 18-test preview verifier covers production and Phase 2E rejection,
shell-free Railway invocation, explicit service ownership, dependency
isolation, deployment/commit binding, secret redaction, read-only behavior,
and fail-closed confirmation behavior. It was previously callable through
`npm run test:preview-e2e` but not required by GitHub Actions.

Commit `f7f3a2ca` adds that command to the existing required Deployment
Readiness job. The suite passed 18/18 locally on the exact candidate. The
corresponding required CI job must also finish successfully before the PR
leaves Draft.

### REL-FINAL-003 — Maintained preview and security documentation was stale

- Original severity: **Medium**
- Confidence: high
- Status: **resolved in the review-artifact working tree**

The implementation and security guides previously said that no preview
deployment or migration had occurred, while the preview report documented a
completed isolated deployment. The working-tree documentation fixes now:

- identify the exact `f7f3a2ca` runtime candidate;
- identify the exact final API and worker deployments;
- distinguish historical one-time approvals from exact-candidate evidence;
- state that the final `patch.apply` check was challenge-only and
  non-mutating;
- record the test-only `0808eb1f` fix;
- record the newly required preview harness; and
- distinguish preview validation from production enablement.

These documentation-only changes must be committed, pass `docs:check`, and
remain consistent with `docs/MERGE_READINESS.md` before the PR leaves Draft.

### REL-FINAL-004 — Production local-agent migration path remains intentionally absent

- Severity: **Medium operational condition**
- Confidence: high
- Status: open for production enablement; not a merge blocker

The local-agent migration guard intentionally accepts only explicitly
identified preview targets. Runtime startup intentionally does not create the
idempotency binding table, so the feature remains fail-closed in production.

Before production enablement, prepare and separately approve a production
migration/promotion runbook covering:

- exact project, environment, service, and database identity;
- backup or snapshot;
- lock and statement timeouts;
- apply and schema verification;
- failure handling;
- forward-fix or rollback decision; and
- executor credential issuance and revocation.

Do not weaken the preview target guard to create that production path.

### REL-FINAL-005 — Productivity startup DDL is additive but forward-only

- Severity: **Medium operational condition**
- Confidence: high
- Status: open for production promotion; not a merge blocker

The productivity migration is additive and mirrored by the existing startup
schema initializer. That preserves compatibility, but a production deploy with
database permissions may create the tables as a startup side effect. There is
no safe destructive rollback for canonical non-empty productivity data.

Production promotion therefore requires explicit target confirmation,
database backup, permission review, and a forward-fix plan. Preview teardown
is an adequate rollback boundary for the isolated synthetic preview.

### REL-FINAL-006 — Some CI supply-chain inputs remain mutable

- Severity: **Low**
- Confidence: medium-high
- Status: accepted follow-up

The sandbox base image is digest-pinned and the application uses the lockfile.
The new CI coverage still uses a mutable `postgres:18-alpine` service tag and
some package/system bootstrap inputs that resolve at execution time.

Pin the PostgreSQL CI image by digest and retain sandbox image provenance/SBOM
for production promotion. This does not justify replacing the current
sandbox architecture and does not block Ready for Review.

### REL-FINAL-007 — Temporary preview resources remain live

- Severity: **Low operational**
- Confidence: high
- Status: explicitly retained

The isolated API, worker, PostgreSQL, Redis, domain, preview credentials,
device registration, disposable workspace, and temporary private test GPT are
retained for review and continue to consume resources. They must not be reused
as production. Follow the exact-target teardown and credential-revocation plan
after review.

## Exact preview evidence

The exact runtime candidate is deployed only to the isolated preview:

| Resource | Name | ID / deployment |
|---|---|---|
| Railway project | `Arcanos` | `7faf44e5-519c-4e73-8d7a-da9f389e6187` |
| Environment | `arcanos-preview-bf8ac3bd` | `99d9eeae-c618-4a77-8498-85dd0d7444cc` |
| API service | `arcanos-api-preview-bf8ac3bd` | `7a34bd3b-5087-4c9e-b732-a5a00a9dae8e` |
| API deployment | exact `f7f3a2ca` candidate | `ce5a974e-a087-4634-9e74-992b4c44144e` |
| Worker service | `arcanos-worker-preview-bf8ac3bd` | `ad02d44b-d488-4e8d-b003-92223d02d1b8` |
| Worker deployment | exact `f7f3a2ca` candidate | `87baaf0a-ac51-42a0-abdc-5044cd71f122` |
| PostgreSQL | `postgres-preview-bf8ac3bd` | `c044dc1c-fcf5-4457-ac74-163e2a55132e` |
| PostgreSQL deployment | preview-owned | `c1103750-d6ab-4242-8026-80076d4bd98b` |
| Redis | `redis-preview-bf8ac3bd` | `83109a22-246b-4853-9346-d7179238e0bf` |
| Redis deployment | preview-owned | `5b3e456f-944d-4265-96c6-c768b760e281` |

Preview URL:

```text
https://arcanos-api-bf8ac3bd-arcanos-preview-bf8ac3bd.up.railway.app
```

Verified on `f7f3a2ca`:

- API and worker deployments report `SUCCESS`;
- API server-controlled metadata binds the exact worker deployment and full
  commit;
- health and startup state are ready;
- authenticated discovery exposes both `ARCANOS:PRODUCTIVITY` and
  `ARCANOS:LOCAL_AGENT`;
- the read-only verifier passed with tenant-bound six-event timelines,
  idempotent replay/conflict, and non-mutating `patch.preview`;
- the preview PostgreSQL concurrency and tenant-isolation suite passed 6/6;
- `patch.apply` returned `CONFIRMATION_REQUIRED` in challenge-only validation,
  with no approval, retry, job creation, or fixture mutation;
- 241 API and 38 worker log records contained no fatal condition and no actual
  credential disclosure; one broad match was harmless Railway help text.

Historical, explicitly approved `patch.apply` and sandboxed `tests.run`
executions remain evidence for their exact historical commits. Their one-time
approvals were not reused for `f7f3a2ca`.

Production and the Phase 2E Redis validation service were not modified.

## Build, startup, and CI assessment

At review freeze, the exact `f7f3a2ca` GitHub run had already passed:

- Lint & Type Check;
- Build with Node 20.19.0;
- Convergence Gate;
- Security Audit;
- integration tests;
- Python CLI on Windows;
- Local Agent Sandbox on Linux;
- Local Agent PostgreSQL Concurrency;
- Railway Compatibility, including the Docker build;
- API endpoint checks;
- documentation checks;
- approval-policy checks; and
- both Railway deployment contexts.

Still in progress at review freeze:

- the exact-head unit shard;
- the independent `build-test` workflow;
- dependent Deployment Readiness, including the newly required 18-test
  preview harness; and
- the aggregate final gate.

Pending checks are not treated as passed. Every required check must complete
successfully before the PR leaves Draft.

The normal Railway web/worker startup path remains
`node scripts/start-railway-service.mjs` with explicit process kind. The
preview uses the repository's passive PR-preview-safe validation and exact
service selection; it does not rely on the ambient Railway link.

## Migration and rollback assessment

### Local-agent hardening

- Migration is additive, transactional, idempotent, and guarded by an advisory
  migration lock.
- Database uniqueness is authoritative for the canonical
  principal/workspace/device/action/idempotency-key scope; the advisory lock
  is only an optimization.
- The normalized SHA-256 manifest checksum is
  `75cf9f3a914fafbd8d1ad453a2f47c5f930e8f2bdf45ac6e61f672c74f775bed`.
- `npm run db:local-agent-hardening:plan` passed against the artifact and
  checksum.
- The runner requires explicit preview project, environment, and PostgreSQL
  service identities and rejects production and Phase 2E markers.
- It uses finite lock and statement timeouts and verifies the resulting schema.
- Compensation fails closed when bindings or active jobs exist. The retained
  preview is non-empty, so forward-fix or complete isolated-preview teardown
  is the correct rollback strategy.

### Productivity

- Migration is additive and idempotent.
- Runtime startup definitions mirror the table and index contract.
- Foreign-key and lifecycle constraints are explicit.
- Preview rollback is complete preview teardown.
- Production removal is not a safe routine rollback; use a separately reviewed
  forward migration if production changes later require correction.

## Commands actually executed by this reviewer

The reviewer executed read-only inspection and local validation commands,
including:

```text
git status --short
git rev-parse HEAD
git diff --name-status 59989445b6bf206c0f73bc9fb11f6d47f3494214
git diff --stat 59989445b6bf206c0f73bc9fb11f6d47f3494214
git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214..f7f3a2ca
git show / git diff for 0808eb1f and f7f3a2ca
gh pr view 1408
gh pr checks 1408
gh run view 30142220520
gh run view 30142220513
railway --version
railway status --json
railway deployment list --service <explicit-preview-service> --environment <explicit-preview-environment> --json
railway logs <explicit-preview-deployment> --service <explicit-preview-service> --environment <explicit-preview-environment> --json
railway variable list --service <explicit-preview-api> --environment <explicit-preview-environment>
GET /health
npm run test:preview-e2e
npm run db:local-agent-hardening:plan
npm run validate:railway
npm run docs:check
```

The reviewer parsed only non-secret identity and deployment metadata from
Railway variables. Credentials were not printed.

## Validation accounting

### Passed directly by this reviewer

- Preview verifier: 18 passed, 0 failed.
- Local-agent migration plan and checksum verification: passed.
- Railway compatibility validation: passed.
- Documentation audit: 272 passed, 0 failed, 0 warnings.
- Diff whitespace validation: passed.
- Exact preview API and worker health/deployment inspection: passed.
- Bounded log safety scan: 0 fatal and 0 actual credential findings.

### Passed through exact-candidate CI or preview evidence

- Type check and lint.
- Node build and Docker build.
- Convergence and boundary checks.
- Security audit.
- Integration tests.
- Windows Python tests.
- Linux sandbox, symlink, and link-race tests.
- PostgreSQL concurrency and tenant-isolation tests.
- Railway API and worker deployments.
- Exact-deployment authenticated read-only E2E verification.
- Exact-deployment challenge-only `patch.apply` fail-closed verification.

### Failed and remediated

- Commit `a3d2251f`: one timing-sensitive unit test failed; all other reported
  tests in that shard passed or were skipped as configured.
- Commit `0808eb1f`: test-only clock stabilization; focused suite 14/14 and
  expiry case 20 consecutive passes.

### Pending at review freeze

- Exact `f7f3a2ca` unit shard.
- Exact `f7f3a2ca` `build-test` workflow.
- Dependent Deployment Readiness and aggregate checks.

### Not executed by this reviewer

- Full root build, lint, type check, unit, integration, and Python suites
  locally; exact CI and the responsible reviewers provide that evidence.
- Production migration, deployment, restart, variable mutation, smoke test,
  or Custom GPT configuration change.
- A new approval/retry for `patch.apply` or `tests.run` on `f7f3a2ca`.
- Preview teardown.

## Conditions for approval

1. Every required check on `f7f3a2ca` must complete successfully, including
   unit, `build-test`, Deployment Readiness with `test:preview-e2e`, and the
   aggregate gate. Any failure restores **REQUEST CHANGES**.
2. Commit the documentation and review artifacts, including
   `docs/PREVIEW_E2E_REPORT.md`, the maintained bridge/security guides, all
   independent review reports, and `docs/MERGE_READINESS.md`.
3. The artifact-only head must pass documentation, policy, and required CI
   gates. It must contain no runtime, migration, dependency, generated
   contract, or deployment-config change.
4. Any runtime or deployment-affecting change after `f7f3a2ca` requires a new
   exact-commit CI run, explicit preview deployment, E2E verification, and
   independent review.
5. Keep local-agent production enablement off until a separately reviewed
   production migration and credential-promotion runbook is approved.
6. Require explicit operator target, backup, permissions, and forward-fix
   review before production productivity DDL is allowed to run.
7. Retain exact-target preview teardown and credential-revocation
   instructions. Do not reuse preview resources or credentials as production.
8. Do not merge or deploy production under this review.

## Merge recommendation

**APPROVE WITH CONDITIONS**

There are no unresolved Critical or High findings. The previous High release
failure was a deterministic test-clock defect and was fixed without changing
runtime behavior. The exact runtime candidate is deployed to an isolated
preview and has the required authenticated runtime evidence.

The PR may leave Draft only after the pending exact-candidate CI gates are
green and the review-artifact-only commit is complete and validated. This
review recommends Ready for Review at that point; it does not recommend or
authorize merging.
