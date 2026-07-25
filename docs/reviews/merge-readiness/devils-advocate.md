# Devil's Advocate Production-Readiness Review

## Review identity and scope

- Reviewer: independent Devil's Advocate
- Review target: Draft PR `#1408`
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Runtime candidate reviewed: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Review date: 2026-07-24
- Committed PR inventory reviewed: 125 changed files, including source,
  protocol, tests, migrations, documentation, CI, Railway, and Python daemon
  changes
- Additional scope: current uncommitted review-only documentation corrections

This review did not rely on another reviewer's coverage. It independently
traced untrusted input, identity, tenancy, confirmation, persistence, job
claims, filesystem access, sandbox execution, and result publication across the
entire PR. It also challenged the migration, test, CI, deployment, and preview
claims against the exact runtime candidate.

## Executive verdict

**APPROVE WITH CONDITIONS**

| Severity | Open |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium residual conditions | 6 |
| Low observations | 3 |

No Critical or High finding has been waived. Material defects found during the
review rounds were corrected and covered by regression tests before this final
assessment.

The exact runtime candidate is supported by green required GitHub checks,
paired successful isolated Railway API/worker deployments, an authenticated
read-only preview verifier, six-event tenant timeline tests, preview PostgreSQL
concurrency tests, idempotency tests, a non-mutating `patch.preview`, and a
challenge-only `patch.apply` fail-closed check. The preview report correctly
distinguishes this exact-candidate challenge check from historical,
operator-approved mutation tests.

Reviewer confidence: **0.96 (high)**.

The PR may leave Draft after the combined merge-readiness report and all
independent review artifacts are committed, every reviewer remains at
`APPROVE` or `APPROVE WITH CONDITIONS`, and no executable, migration, workflow,
or deployment change is added after `f7f3a2c` without repeating the applicable
validation. This review does not recommend merging the PR.

## Resolved material findings

### Cross-tenant local-agent timeline disclosure

- Initial severity: High
- Final status: Resolved
- Locations:
  - `src/routes/gpt-access.ts:1287`
  - `src/core/db/repositories/jobEventRepository.ts:395`
  - `tests/integration/local-agent-hardening.pg.integration.test.ts`

The original timeline path did not constrain local-agent events to the
authenticated principal/workspace at the database query boundary. The final
implementation passes only server-controlled scope, joins authoritative job
data, returns matching local-agent rows only for the owning tenant, and excludes
all local-agent rows when trusted scope is absent or incomplete. A foreign
tenant receives no row for an exact foreign job id. The production query
builder is covered by a real PostgreSQL regression.

### Local-agent metadata escaped through generic job surfaces

- Initial severity: High
- Final status: Resolved

Generic latest-job, queue, failed-job, worker-control, MCP job, public
job-status/result/cancel/stream, and diagnostics paths now exclude
`job_type='local-agent'`. Local-agent control-plane data remains behind the
dedicated authenticated GPT Access and daemon lifecycle boundaries. Generic
cleanup preserves manual-reconciliation evidence.

### Confirmation bypasses on privileged execution

- Initial severity: High
- Final status: Resolved
- Location:
  `src/transport/http/middleware/confirmationChallengeStore.ts`

`patch.apply` and privileged `tests.run` require an expiring, one-use
confirmation challenge bound to the exact action, canonical payload,
authenticated actor, server-controlled principal, and workspace. Model-supplied
flags, broad trusted-GPT state, automation credentials, and allow-all policy
cannot satisfy the challenge. The token is top-level, stripped before payload
fingerprinting, and cannot be replayed for a modified payload.

### Windows path and Git containment gaps

- Initial severity: High
- Final status: Resolved

TypeScript and Python validation reject colon-bearing path segments and Windows
alternate-data-stream forms. Workspace resolution, secure file access, CLI
patch validation, and repository handlers apply the same rule. Git execution
forces `core.protectNTFS=true` and rejects a local configuration that explicitly
disables the protection. Tests cover ordinary ADS forms, secret-like ADS forms,
and `::$DATA`.

### Advisory-only job idempotency

- Initial severity: High
- Final status: Resolved
- Location:
  `migrations/20260724_local_agent_job_hardening_v1/01_local_agent_job_idempotency.sql:104`

Database uniqueness is now authoritative over tenant, device, action, and
idempotency key. Identical concurrent requests converge on the original
logical job/result, while a reused key with a different canonical fingerprint
conflicts. Advisory locks remain only an optimization. The migration includes
preflight validation, backfill, constraints, indexes, checksums, and a
fail-closed preview compensation path.

### Unsandboxed repository-controlled test execution

- Initial severity: High
- Final status: Resolved
- Location: `daemon-python/arcanos/local_agent/test_sandbox.py:186`

Production-capable `tests.run` uses a disposable non-root Docker/Podman
container with a read-only base and input, a bounded writable temporary
workspace, no host socket, disabled network, dropped capabilities,
`no-new-privileges`, and CPU, memory, process, disk, time, and output limits.
Unsandboxed execution remains disabled by default and fails closed under
production/Railway markers.

## Independent architecture falsification

| Claim challenged | Result |
| --- | --- |
| Python became a public API or an alternate authority | Falsified. Python remains outbound-only and consumes TypeScript-owned contracts. |
| Python can access canonical PostgreSQL state | Falsified. Canonical persistence stays in TypeScript repositories. |
| A second queue or workflow engine was introduced | Falsified. The binding table enforces uniqueness around the existing `job_data` queue. |
| Local-agent actions can use `/gpt/:gptId` or legacy module routes | Falsified. The module is protected, GPT-access-only, and legacy-route-disabled. |
| A generic shell capability was added | Falsified. Only the seven declared actions exist, and test execution uses fixed profiles. |
| Model payload can select tenant, device, repository root, authorization, or confirmation | Falsified. Those values come from authenticated server/device registration context and recursive unsafe aliases are rejected. |
| A generic job endpoint can inspect or control a local-agent job | Falsified after the final boundary fixes and regression tests. |
| A privileged mutation can rely on a model confirmation flag | Falsified. Exact challenge consumption is mandatory. |
| Sandboxing is only environment sanitization | Falsified. A real resource-bounded container boundary is enforced. |
| Job idempotency still relies on advisory locking | Falsified. A database unique constraint is authoritative. |
| Batch expiry hides individual job lifecycle evidence | Falsified. Each expired job retains its transition, event/outbox record, reason, correlation, and reconciliation time. |
| Productivity reads or writes can cross tenants | Falsified. Queries and relationships are principal/workspace scoped and caller tenancy fields are rejected. |
| Productivity can silently invent states or overwrite stale state | Falsified. Lifecycles are enumerated and optimistic concurrency returns structured errors. |
| State, outbox events, and command receipts can drift on a successful mutation | Falsified. They share a database transaction. |
| OpenAPI exposes daemon lifecycle internals to a Custom GPT | Falsified. Discovery exposes capability contracts, not executor endpoints. |
| The currently linked Phase 2E Redis service was reused | Falsified. The verified preview uses separately named API, worker, PostgreSQL, and Redis resources in environment `99d9eeae-c618-4a77-8498-85dd0d7444cc`. |

## Medium residual conditions

### DA-M-001 — Patch execution has an irreducible local filesystem race

- Category: local filesystem security
- Status: accepted only under the documented private-workspace threat model

Containment checks, link/reparse rejection, stable root identity, secret deny
rules, backup validation, postchecks, and manual reconciliation substantially
reduce risk. However, validation and the external `git apply` process are not
one atomic descriptor-relative operation. The residual is larger on Windows,
where not every traversal can use a descriptor-relative Win32 handle.

Condition: register only daemon-owned roots that are not writable by another
untrusted local principal. Keep mutation work on disposable fixtures where
possible and retain manual reconciliation for uncertain outcomes.

### DA-M-002 — `state.current` is a consistent but uncapped tenant snapshot

- Category: availability and scale
- Location: `docs/PRODUCTIVITY_SYSTEM.md:136`

The canonical productivity projection loads all tenant tasks and projects
within one repeatable-read, read-only snapshot and derives focus, project
health, and review evidence in memory. The consistency property is correct, but
a sufficiently large workspace can amplify database work, heap use, latency,
and response shaping.

Condition: treat the first release as a bounded-workspace deployment, monitor
cardinality and latency, and introduce a measured ceiling or bounded projection
before large/team tenants.

### DA-M-003 — Repository output remains semantically hostile

- Category: model-facing content security

Control characters, ANSI sequences, secrets, binaries, and output size are
sanitized or bounded. Source text, Git filenames, diffs, and test output can
still contain prompt-injection prose.

Condition: the conversational layer must present local-agent results as
untrusted evidence, never as instructions. Authorization and exact
confirmation must remain TypeScript decisions.

### DA-M-004 — Confirmation state is process-local

- Category: availability and horizontal scaling
- Location:
  `src/transport/http/middleware/confirmationChallengeStore.ts:62`

The challenge store is an in-memory `Map`. A retry routed to another API process
will not find the challenge and therefore fails closed. This is not a bypass,
but it can make approved operations unavailable in a multi-replica deployment.

Condition: keep the initial gateway single-instance or sticky. Move challenges
to existing shared persistence before non-sticky horizontal scaling.

### DA-M-005 — Executor credential theft retains device authority until revoke

- Category: credential operations

The executor credential is audience- and scope-restricted and is attributable
to a registered device, but possession still permits impersonation of that
device until rotation or revocation.

Condition: use a dedicated OS account and secret store, rotate preview and
production credentials independently, alert on unexpected device identity or
claim patterns, and keep revocation procedures tested.

### DA-M-006 — The local journal contains operationally sensitive evidence

- Category: endpoint storage
- Location: `daemon-python/arcanos/local_agent/journal.py`

The local SQLite journal can contain assignment metadata, repository paths,
patch details, and reconciliation evidence. It is private to the daemon and is
not canonical backend state, but it is not application-layer encrypted.

Condition: run under a dedicated account, enforce restrictive file
permissions, use encrypted host storage, and apply a documented retention
policy that preserves unresolved reconciliation evidence.

## Low observations

### DA-L-001 — Explicit idempotency keys are still the reliable retry contract

Callers must reuse the same explicit `Idempotency-Key` across transport retries.
Automatically derived keys include request identity, so a logically new
request can intentionally create a new job. OpenAPI and temporary Custom GPT
instructions should continue to state this requirement.

### DA-L-002 — Hard daemon failure can leave a bounded orphan container

Normal completion, timeout, and cancellation clean up the sandbox; `--rm`
handles normal container exit. A hard daemon or host failure can leave a
networkless, resource-bounded container until the runtime removes it or an
operator reconciles it. Monitor the dedicated container label and add startup
reaping if this becomes recurring.

### DA-L-003 — Project-health coverage is a product-policy choice

Scheduled work counts as next-action coverage. This is coherent and tested, but
it is broader than a strict methodology requiring a task explicitly in `next`.
Keep the behavior visible in product documentation so “healthy” is not
misinterpreted.

## Database and migration challenge

The local-agent migration is additive and transactional, validates existing
rows before adding authoritative uniqueness, and refuses destructive
compensation when bindings or active jobs exist. That fail-closed behavior is
appropriate. The productivity migration is additive and deliberately
forward-only; the maintained documentation correctly states that production
recovery is a forward fix rather than destructive rollback.

The following operator obligations remain:

1. Resolve old manual-reconciliation evidence deliberately rather than
   deleting it.
2. Apply migrations only to a proven target environment.
3. Verify constraints and indexes after migration.
4. Never present preview environment deletion as a production rollback.

No open database Critical or High finding remains.

## Deployment and preview evidence

The independent reviewer verified:

- PR head and runtime candidate:
  `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Base:
  `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- PR state during review: Draft, merge state clean
- All required GitHub checks: successful
- Railway CLI: `4.30.2`
- Isolated preview environment:
  `99d9eeae-c618-4a77-8498-85dd0d7444cc`
- API deployment:
  `ce5a974e-a087-4634-9e74-992b4c44144e` — `SUCCESS`
- Worker deployment:
  `87baaf0a-ac51-42a0-abdc-5044cd71f122` — `SUCCESS`
- Preview API health: ready, with Redis dependency ready
- Unauthenticated GPT Access health: correctly rejected with `401`
- Public dynamic OpenAPI: OpenAPI 3.1, correct preview server, both
  `ARCANOS:PRODUCTIVITY` and `ARCANOS:LOCAL_AGENT` present
- Preview PostgreSQL hardening verification: 6/6
- Authenticated read-only E2E: passed
- Six-event owning/foreign/null-scope timeline matrix: passed
- Idempotent replay and conflict behavior: passed
- `patch.preview`: passed with no workspace mutation
- `patch.apply`: exact-candidate challenge-only invocation failed closed with
  no retry and no mutation
- API and worker logs reviewed as clean of credentials

The paired deployment and exact-head evidence is recorded in
`docs/PREVIEW_E2E_REPORT.md:123` and
`docs/PREVIEW_E2E_REPORT.md:149`. Teardown was intentionally not executed; the
preview is retained temporarily with a documented teardown plan.

## Test evidence

### Exact-candidate authoritative evidence

| Check | Result |
| --- | --- |
| Windows Python daemon CI | 551 passed, 13 skipped |
| Node unit CI | 4,944 passed, 14 skipped |
| Node integration CI | 84 passed, 9 skipped |
| Linux effective sandbox/link-race CI | 29 passed |
| PostgreSQL concurrency/integration verification | Passed, including 6/6 preview migration verification |
| Build, lint, typecheck, Railway compatibility, deployment readiness, preview harness, security audit | Passed |
| API and worker Railway deployments | Paired and successful at the exact runtime commit |

### Commands executed directly by this reviewer

- Git base/head/status, changed-file, stat, and focused diff inspection
- Repository-wide searches over generic job surfaces, confirmation,
  filesystem, migrations, productivity, tests, CI, and documentation
- `gh pr view 1408` and `gh pr checks 1408`
- `railway --version`
- structured `railway status` inspection for the explicit preview environment
- preview `/health` and `/gpt-access/openapi.json` requests
- an unauthenticated `/gpt-access/health` request to confirm fail-closed auth

Earlier independent local checks in this review series also passed Python
pytest (546 passed, 18 platform skips), typecheck, lint with no errors, build,
focused and broad PR Jest suites, Railway validation, protocol sync/offline
contract checks, and the 18/18 preview harness. Platform-sensitive failures in
the broad local Windows baseline were not used as release evidence; the exact
runtime candidate's required CI is green.

No test is claimed as passed solely because it was proposed. Real Custom GPT UI
conversation testing remains a manual UX/integration check; it does not replace
the authenticated API E2E or exact confirmation evidence. The production Custom
GPT configuration was not changed.

## Conditions before changing Draft status

1. Preserve runtime candidate `f7f3a2c` unchanged, except for review-only
   documentation.
2. Commit the combined `docs/MERGE_READINESS.md` and all seven independent
   review artifacts.
3. Confirm all reviewers remain `APPROVE` or `APPROVE WITH CONDITIONS` with
   zero open Critical and High findings.
4. Keep the exact-candidate CI, isolated deployment, migration, E2E, audit, and
   trace evidence linked from the final summary.
5. If any executable, migration, CI/workflow, environment, or deployment
   configuration changes after `f7f3a2c`, repeat affected reviews and
   exact-candidate validation before readiness.
6. Carry the six Medium residuals above into operational/release ownership;
   none may be silently represented as eliminated.

Documentation-only review corrections do not require a new preview deployment,
provided the final diff is verified to contain no executable, migration,
workflow, variable, or deployment change.

## Merge recommendation

The implementation preserves the intended ARCANOS TypeScript/Python authority
boundary and has no known open Critical or High defect. The remaining Medium
items are bounded threat-model, scale, availability, or endpoint-operations
conditions with explicit mitigations.

**Code recommendation:** approve with conditions.

**Ready-for-Review recommendation:** yes, after the documentation aggregation
and seven-reviewer conditions above are complete.

**Merge recommendation:** do not merge as part of this task.
