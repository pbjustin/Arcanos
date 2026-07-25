# Release Engineering Review — PR 1408

## Review identity

- Review round: 2
- Reviewer: independent Release Engineering reviewer
- Pull request: `#1408` — `feat: add hardened productivity and local-agent capabilities`
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Committed head inspected: `87788342f862d59c60fa3ea830da47c39950dabf`
- Candidate scope: the complete PR plus the shared Round-2 working-tree
  remediations
- Verdict: **REQUEST CHANGES**
- Reviewer confidence: **high (0.94)**
- Critical findings: **0**
- High findings: **1 open**

This is a release-gate verdict, not an architectural objection. The committed
head has green CI and healthy isolated Railway API/worker deployments. The
candidate that would be marked Ready is newer than that evidence and is still
changing in an uncommitted working tree, so it is not yet a reproducible
release candidate.

## Independent scope and method

I independently inventoried and inspected the full diff rather than relying on
another review. The current candidate contains 117 changed or newly added
files relative to the base, spanning:

- TypeScript gateway, module, service, repository, middleware, worker-control,
  diagnostics, and protocol code;
- the private Python daemon, handler registry, local journal, filesystem/Git
  controls, patch handling, process runner, and test sandbox;
- generated TypeScript and Python capability catalogs;
- all new or changed Jest, `node:test`, and pytest coverage;
- the productivity and local-agent SQL migrations, compensation artifact,
  manifest, checksum guard, and PostgreSQL integration suite;
- environment templates, CI workflow changes, package scripts, Railway
  compatibility, preview verifier, deployment report, security review, and
  operator documentation.

I also inspected the unchanged executable Railway contract used by this PR
(`railway.json`, `Dockerfile`, and
`scripts/start-railway-service.mjs`) because the preview deployments use those
files even though this branch does not modify them.

No production, Phase 2E, database, variable, credential, deployment, or
Custom-GPT mutation was performed by this reviewer.

## Release architecture assessment

The release shape preserves the intended architecture:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript auth, policy, confirmation, tenancy, audit, and tracing
  -> existing PostgreSQL job lifecycle
  -> private outbound Python daemon
  -> fixed typed handler
  -> correlated structured result
```

The PR does not add a public Python API, second queue, second workflow engine,
generic shell capability, direct Python PostgreSQL access, legacy module
exposure, or `/gpt/:gptId` control-plane execution. The Railway API and worker
continue to use the existing explicit `ARCANOS_PROCESS_KIND` launcher. The new
Linux sandbox and PostgreSQL concurrency jobs are required by the aggregate
CI gate.

## Findings

### REL-R2-001 — The final candidate has not been validated or deployed as one exact immutable commit

- Severity: **High**
- Confidence: high
- Status: open
- Merge impact: blocks Ready for Review

GitHub CI and Railway deployment contexts are green for committed head
`87788342f862d59c60fa3ea830da47c39950dabf`. Railway currently reports:

- API deployment `8a68fe85-bb2b-4572-9924-686c423eebd4` at `87788342`;
- worker deployment `53bd1717-4ae7-4c3a-833b-c76199d99e06` at `87788342`.

The public `/health` endpoint was healthy, and a bounded scan of 300 API log
records and 162 worker log records found no fatal-like or credential-like
matches.

Those deployments do not contain the current Round-2 fixes. During this
review, the working tree included uncommitted changes to confirmation
fingerprinting, protected job visibility, diagnostics, Windows ADS handling,
workspace validation, productivity behavior, generated contracts, and their
tests. The candidate diff hash changed while independent reviewers were still
applying those fixes, confirming that no stable final artifact existed yet.

The checked-in preview report is older still: it names
`b2821e8053610fd983c024d81b82e9b781a828f4` and now-removed API/worker
deployments as its exact final runtime evidence. Its allowance for a later
report-only commit does not cover the runtime and security changes after that
commit.

An authenticated discovery attempt against the current preview did not
complete because the bearer available to this shell was rejected by the
preview. The attempt stopped without a mutation. This reviewer therefore does
not claim new exact-head discovery or E2E evidence.

Required disposition:

1. Finish and commit all approved Round-2 fixes.
2. Re-run the complete build, lint, type check, root tests, Python tests,
   catalog/schema parity, migration plan/database tests, preview-verifier unit
   tests, and Railway compatibility checks on that exact commit.
3. Require every GitHub check for that commit to pass.
4. Deploy that same commit explicitly to the isolated preview API and worker.
5. Refresh the preview API's server-controlled worker deployment ID and commit
   metadata to the exact selected worker deployment.
6. Re-run authenticated discovery and the full non-destructive preview matrix,
   plus the already-authorized bounded confirmation scenarios where applicable.
7. Update `docs/PREVIEW_E2E_REPORT.md` with the exact commit, deployments,
   migration verification, audit/trace evidence, passed/failed/skipped counts,
   and retained-resource state.
8. Repeat this gate if any runtime code changes afterward.

### REL-R2-002 — Maintained deployment/security documentation is internally stale

- Severity: **Medium**
- Confidence: high
- Status: open

`docs/PREVIEW_E2E_REPORT.md` records historical preview deployment,
migration, sandbox, and E2E completion. In contrast,
`docs/LOCAL_AGENT_CAPABILITY_BRIDGE.md` and
`docs/security/LOCAL_AGENT_CAPABILITY_BRIDGE_SECURITY_REVIEW.md` still contain
statements that no Railway deployment or migration occurred and that several
controls remain pending environment verification.

The conservative statements are not unsafe by themselves, but the conflicting
canonical guidance makes promotion decisions ambiguous. After exact-final
preview validation, update the maintained documents to distinguish:

- implemented code controls;
- historical preview evidence;
- exact-final-candidate preview evidence;
- production enablement steps that remain intentionally unexecuted.

### REL-R2-003 — The safety-critical preview verifier unit suite is not a required CI step

- Severity: **Medium**
- Confidence: high
- Status: open

`scripts/preview-e2e.test.mjs` verifies production/Phase-2E rejection,
shell-free Railway invocation, service ownership, dependency isolation,
deployment/commit identity, secret redaction, read-only behavior, and
confirmation fail-closed behavior. It is outside the root Jest discovery
tree. The package exposes `npm run test:preview-e2e`, but no GitHub workflow
runs it.

The suite passed all 18 tests locally during this review. Add this command to a
required CI job (or a small dedicated required job) so future changes cannot
silently weaken the preview release guard. This is a small,
architecture-preserving workflow change.

### REL-R2-004 — Production enablement has no approved local-agent migration path

- Severity: **Medium operational condition**
- Confidence: high
- Status: open for production enablement; not a preview blocker

The local-agent migration guard intentionally supports only explicitly
identified preview targets. The runtime startup schema intentionally does not
create `local_agent_job_idempotency`, and the repository's generic `db:init`
and `db:patch` scripts are documented as unavailable. Therefore the local
agent must remain disabled in production until a separate reviewed production
migration/promotion procedure exists.

This is safe for merge only because executor credentials are not part of the
production Railway contract and missing configuration fails closed. Before a
production rollout, provide a guarded, auditable production apply/verify
runbook or approved migration mechanism, including backup, lock-duration,
failure, and rollback/forward-fix decisions. Do not weaken the preview target
guard to create that path.

The productivity tables are additive and are also present in startup DDL, so
they are created by the existing startup initializer. Operators should still
document that automatic DDL side effect and its required database permissions
before production promotion.

### REL-R2-005 — New CI supply-chain inputs are only partially immutable

- Severity: **Low**
- Confidence: medium-high
- Status: accepted follow-up

The sandbox base image is digest-pinned and the application lockfile is used,
which is good. The new jobs still use a mutable `postgres:18-alpine` service
tag, unpinned package-manager bootstrap installs, and system packages resolved
at build time. This can make a previously passing release gate drift without a
source change.

Pin the PostgreSQL CI image by digest and preserve sandbox image
digest/SBOM/provenance when promoting beyond the private preview. Tighter
Python/system dependency pinning can be handled as a follow-up; it does not
justify replacing the current sandbox architecture.

### REL-R2-006 — Temporary preview resources remain live

- Severity: **Low operational**
- Confidence: high
- Status: explicitly retained

The isolated API, worker, PostgreSQL, Redis, volume, domain, local daemon, and
private test GPT are intentionally retained for final review and continue to
consume resources. This is acceptable until the Ready gate is completed.
Retain the documented exact-target teardown plan, revoke preview credentials
if deletion is delayed, and do not reuse these resources as production.

## Migrations and rollback

### Local-agent hardening

- The migration is additive, transactional, idempotent, and protected by an
  advisory migration lock.
- The normalized SHA-256 checksum in the manifest and executable guard is
  `75cf9f3a914fafbd8d1ad453a2f47c5f930e8f2bdf45ac6e61f672c74f775bed`.
- `npm run db:local-agent-hardening:plan` passed and verified that checksum.
- Database uniqueness, foreign keys, constraints, and index shape are covered
  by the dedicated PostgreSQL CI job.
- Compensation fails closed when bindings or active local-agent jobs exist.
  The retained preview is non-empty, so forward-fix or full isolated preview
  teardown is the correct rollback strategy there.

### Productivity

- The migration is additive and mirrored in runtime startup definitions.
- Preview teardown is an adequate preview rollback boundary.
- There is no non-destructive production rollback artifact. Treat production
  schema removal as a separate reviewed migration; never infer that dropping
  non-empty tables is safe.

## CI and preview evidence

At committed head `87788342`, GitHub reported all required checks successful,
including:

- lint and type check;
- Node build;
- unit and integration suites;
- convergence;
- security audit;
- Windows Python;
- Linux local-agent sandbox/link tests;
- PostgreSQL concurrency;
- Railway compatibility and deployment readiness;
- API endpoint, documentation, and aggregate gates;
- Railway API and worker deployment contexts.

That evidence remains valuable regression coverage, but it does not validate
the uncommitted final candidate.

## Commands actually executed by this reviewer

```text
git branch --show-current
git rev-parse HEAD
git status --short
git diff --name-status 59989445b6bf206c0f73bc9fb11f6d47f3494214
git diff --stat 59989445b6bf206c0f73bc9fb11f6d47f3494214
git diff --check
gh pr view 1408 --json ...
gh pr checks 1408
railway --version
railway status
railway status --json
railway deployment list --service arcanos-api-preview-bf8ac3bd --environment arcanos-preview-bf8ac3bd --limit 5 --json
railway deployment list --service arcanos-worker-preview-bf8ac3bd --environment arcanos-preview-bf8ac3bd --limit 5 --json
railway logs <explicit-api-deployment> --service arcanos-api-preview-bf8ac3bd --environment arcanos-preview-bf8ac3bd --lines 300 --json
railway logs <explicit-worker-deployment> --service arcanos-worker-preview-bf8ac3bd --environment arcanos-preview-bf8ac3bd --lines 300 --json
GET /health
npm run test:preview-e2e
npm run db:local-agent-hardening:plan
npm run validate:railway
npm run docs:check
npm run preview:e2e -- --mode discovery <explicit-preview-identities-for-87788342>
```

Results:

- Preview-verifier unit tests: **18 passed, 0 failed**.
- Migration artifact plan/checksum: **passed**.
- Railway compatibility: **passed**.
- Documentation audit: **272 passed, 0 failed, 0 warnings**.
- Diff whitespace check: **passed**; Windows emitted expected line-ending
  conversion warnings for the shared working tree.
- Public API `/health`: **healthy**.
- Current API/worker deployments: **SUCCESS** at committed head `87788342`.
- Bounded deployment log scan: **0 fatal-like and 0 secret-like matches**.
- Exact-head authenticated discovery: **not completed**; the locally available
  bearer was invalid for the preview and no mutation was attempted.
- Production deployment, migration, variable change, restart, and smoke test:
  **not executed by design**.

## Conditions for approval

1. Close REL-R2-001 with one immutable, exact-final-commit release candidate.
2. Resolve REL-R2-002 and preserve accurate final evidence.
3. Add the 18-test preview verifier suite to required CI.
4. Keep local-agent production enablement off until REL-R2-004 has a separately
   reviewed production migration path.
5. Require the final commit's CI and isolated preview deployment/E2E to pass.
6. Preserve explicit API/worker/PostgreSQL/Redis identities and never target
   the Phase 2E validation resources.
7. Preserve the documented teardown and credential-revocation plan.

## Merge recommendation

**REQUEST CHANGES**

There are no Critical findings and no request to redesign ARCANOS. One High
release-gate finding remains: the final code candidate is not yet a committed,
fully tested, exact-preview-validated artifact. Once that gap is closed and
the documentation/CI conditions above are satisfied, this review can be
updated to **APPROVE WITH CONDITIONS**. This review does not authorize merging
or production deployment.
