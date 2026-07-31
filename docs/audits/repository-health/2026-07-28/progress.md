# Repository health-audit progress through merged PR #1412 and the 2026-07-30 continuation

Status: historical progress snapshot with dated continuations and a current
post-merge read-only audit

Captured: 2026-07-28T18:00:52Z

Dependency-remediation addendum: 2026-07-28T21:58:17Z

Audit/refactor continuation: 2026-07-29T07:44:09Z

Post-#1411 audit continuation: 2026-07-29T20:03:09Z

Post-#1412 read-only audit continuation: 2026-07-30

Scope: the capability-preview work completed in the preceding Codex task and
the repository-health remediation continued in the current task, through the
post-merge checks on `main`, the dependency-remediation delivery in PR #1410,
the memory-plane containment delivery in PR #1411, the worker-diagnostics and
job-continuation delivery in PR #1412, and the current residual repository
audit

This report records evidence and remaining work; it is not deployment,
database, teardown, or production authorization. Current source, configuration,
provider state, and required CI supersede this snapshot.

The original 2026-07-28 operational table and remaining-work list are retained
as historical evidence. The
[2026-07-29 continuation](#continuation-update--2026-07-29) and the
[post-#1411 continuation](#post-1411-audit-continuation--2026-07-29), followed
by the
[post-#1412 continuation](#post-merge-pr-1412-read-only-audit-continuation--2026-07-30),
supersede their current-state assertions.

## Executive status

The original implementation and merge-readiness work is complete and merged. It
landed in two directly related pull requests comprising 49 authored commits.
The dependency-waiver remediation then landed in a separate two-commit pull
request, followed by the five-commit memory-plane containment pull request and
the six-commit worker-diagnostics/job-continuation pull request:

| Phase | Pull request | Merge result | Size |
| --- | --- | --- | --- |
| Productivity and local-agent capability foundation | [#1408](https://github.com/pbjustin/Arcanos/pull/1408) | Merged as `f5c7826e8a31cf03931fd77b7806394d3cde2233` on 2026-07-25 | 17 commits, 127 files, +37,047/-312 |
| Repository health, security, runtime, and persistence hardening | [#1409](https://github.com/pbjustin/Arcanos/pull/1409) | Merged as `81376790c7b726a2a2f55a66980c460440873386` on 2026-07-28 | 32 commits, 562 files, +68,898/-6,952 |
| Expired dependency-waiver removal | [#1410](https://github.com/pbjustin/Arcanos/pull/1410) | Merged as `2c1be145da9faf5e60b811f25bc361a5aaf8d31e` on 2026-07-28 EDT / 2026-07-29 UTC | 2 commits, 15 files, +426/-552 |
| Memory-plane request containment and native-preview compatibility | [#1411](https://github.com/pbjustin/Arcanos/pull/1411) | Merged as `481a1fb3e9f935699a2fcf685841e34edb04012e` on 2026-07-29 | 5 commits, 22 files, +274/-44 |
| Worker-diagnostics containment, generic job continuation, and Railway proof/cleanup automation | [#1412](https://github.com/pbjustin/Arcanos/pull/1412) | Merged as `2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021` on 2026-07-30 | 6 commits, 110 files, +10,475/-729 |

The dependency-remediation addendum described below records the candidate
evidence that supported PR #1410. It is merged on `main`; this report does not
claim that it has been promoted to production.

PR #1409 was based exactly on the merge of PR #1408. Its merged head was
`f932fc523833ecd0af9b889636271d7710a54d52`; its merge commit has the prior
`main` revision and that exact head as parents. Remote `main` was still at the
merge commit when this snapshot was captured, the feature branch had been
deleted, and there were no open pull requests.

The practical readiness judgment is:

| Area | Status |
| --- | --- |
| PR implementation and merge readiness through #1412 | Merged; post-merge audit found release blockers before production promotion |
| Final-head verification for PR #1412 | Local validation and GitHub checks completed at `cd368d89`; the native final-head preview established passive health/status only, while the production-shaped live API proof ran at intermediate commit `80ad4b70`, not final head |
| Post-merge #1409 `main` verification | Complete; all 13 CI jobs passed |
| Post-merge #1411 `main` verification | Complete: all 13 authoritative CI jobs passed; repository-registration and both documentation workflows also passed |
| Post-merge #1412 `main` verification | Core CI passed all 13 jobs, but documentation analysis failed because a new production-mode startup secret was not supplied |
| Automatic production promotion | Correctly blocked by the active coordinated-writer hold |
| Production rollout through PR #1412 | Not authorized or started by this continuation; a fresh July 30 operational readback still found the deployed source baseline at #1408 |
| Review preview teardown | Railway environment deleted; the four named local artifacts are absent and the dedicated Podman machine is gone; the preserved Git stash remains; temporary-GPT deletion was not reverified in this continuation |
| Security exception review | Complete and merged in PR #1410: patched npm graphs adopted, the npm exception register and Python ignore removed, and production npm/Python audits clean; no waiver was extended or restored |
| Memory-plane containment | Forward fix merged in PR #1411 and passed an isolated live Railway API E2E; it has not been promoted to production |
| Worker-diagnostics and job-read containment | Core public projection fix is credible, but closure is partial; see the grouped current blocker list for generic job cache containment, optional Python-client compatibility, workflow fixtures, deploy-tool/token provenance, and all-consumer cutover/retention decisions |
| Long-term maintainability and scaling debt | Reduced substantially, but not eliminated |

In short, the merged change set through PR #1412 passed its PR checks and the
authoritative post-merge core CI, while the broader post-merge workflow and
read-only audit exposed release-blocking cache, deploy-tooling,
activation-readiness/drain, and mixed-writer cutover defects, plus a current
public metric-cardinality P1, an auxiliary workflow-startup regression, and
compatibility/privacy decisions. The exact review-preview environment has been
retired and its named local artifacts cleaned up. Production promotion must
remain paused pending the ranked corrections and per-type retained-job/replica
cutover decision, followed by the coordinated database/writer rollout. Stale
non-production environment review and explicit temporary-GPT verification also
remain separate exact-target work.

## Work completed

### 1. Reconciled the local work and established a clean delivery history

- Reviewed the two initially uncommitted change splits and consolidated them
  into one coherent worktree rather than carrying overlapping implementations.
- Preserved unrelated local work separately.
- Organized the capability phase into the authorized 17-slice commit series,
  then created and updated the draft pull request until its required checks and
  isolated preview evidence were complete.
- Continued the health audit on top of the #1408 merge as a separate,
  reviewable 32-commit remediation series.
- Used focused reviewers throughout the second phase and closed each actionable
  merge-readiness finding before merge.

### 2. Delivered the productivity and local-agent capability foundation

PR #1408 added the protected `ARCANOS:PRODUCTIVITY` and
`ARCANOS:LOCAL_AGENT` capabilities behind GPT Access while keeping TypeScript
authoritative for public protocol and policy:

- Added the typed local-agent capability catalog, handlers, workspace registry,
  secure filesystem and patch operations, process runner, execution journal,
  and sandbox integration.
- Kept the Python daemon private and outbound-only rather than creating a
  competing public protocol or unauthenticated inbound execution surface.
- Added server-owned tenant, device, requester/executor, idempotency,
  confirmation, and job semantics.
- Added productivity contracts, services, repositories, receipts, and
  persistence.
- Added the local-agent idempotency and productivity migrations:
  - `migrations/20260724_local_agent_job_hardening_v1/`
  - `migrations/20260724_productivity_core.sql`
- Synchronized dynamic OpenAPI and TypeScript/Python contract surfaces.
- Added Windows-safe Railway-preview tooling, isolated preview verification,
  documentation, and focused tests.
- Corrected reviewer-found identity separation, line-ending, Windows process
  invocation, Builder-description, response-schema, NTFS alternate-stream,
  Git metadata, path-containment, and expiry-clock issues.
- Required the preview-safety harness in CI.

The retained historical evidence is in
[the preview E2E report](../../../PREVIEW_E2E_REPORT.md),
[the #1408 merge-readiness report](../../../MERGE_READINESS.md), and
[the local-agent security review](../../../security/LOCAL_AGENT_CAPABILITY_BRIDGE_SECURITY_REVIEW.md).
Their dated provider statements must be revalidated before operational use.

### 3. Removed dependency-cycle and ownership tangles

The health-audit phase made architecture ownership explicit and made cycle
regression executable:

- Moved module ownership into a frozen, validated, single-flight catalog and
  immutable registry shared by the writing plane, GPT Access, daemon, MCP,
  diagnostics, and worker composition.
- Made public module projections derive from explicit safe catalog fields and
  excluded protected definitions from public fuzzy routing and discovery.
- Replaced cross-layer back-edges with narrow composition providers for worker
  control, OpenAI health, MCP execution, ARCANOS:CORE operator routing, and
  other control-plane dependencies.
- Moved shared contracts and queue-wait behavior into dependency-neutral
  modules.
- Extracted and directly characterized GPT job completion, timeout shaping, and
  execution-mode classification from the large router.
- Replaced the former advisory cycle check with an executable Madge gate. The
  merged build and type-check passed with zero TypeScript dependency cycles.
- Consolidated duplicate documentation and added a lifecycle-aware
  documentation index and cross-platform documentation checker.

This was the largest direct improvement to the original “spaghetti code”
finding. It prevents known dependency cycles from returning, although several
large modules remain future refactor candidates.

### 4. Hardened authentication, credentials, ingress, and disclosure

The remediation moved sensitive HTTP surfaces behind exact, pre-parser,
purpose- and scope-bound control-plane policies:

- Protected system-state, RAG, DAG, self-heal, self-improve, CEF,
  reinforcement, AFOL, assistant-registry, worker-control, daemon, memory,
  session, DevOps, SDK, orchestration, prompt-trace, repository-inspection, and
  related diagnostic surfaces.
- Added bounded bodies, request/principal limits, one-use challenges,
  operation/body/actor binding, `no-store` responses, stable public failures,
  and server-owned authorization context as appropriate to each operation.
- Confined file inspection and execution to canonical roots, rejecting symlink,
  junction, alternate-stream, traversal, and shell/path-injection escapes.
- Isolated prompt trust from execution authority and made traces bounded,
  metadata-only, and memory-only by default.
- Hardened worker-helper, memory-plane, daemon, debug-watchdog, standalone
  runtime, and control-plane credentials as distinct purpose-bound principals.
- Enforced canonical credential isolation across every application credential,
  including current and active-previous local-agent credentials and every
  ActionPlan role.
- Added TypeScript and Python role-by-peer collision-matrix tests.
- Made redaction collision-safe and prototype-safe, including credential-shaped
  property names.
- Enforced exact-origin CORS through one global policy owner.
- Replaced raw provider, database, filesystem, queue, worker, route-resolution,
  and internal exception reflection with bounded stable public contracts while
  retaining redacted structured diagnostics server-side.
- Minimized and serialized persisted AFOL and assistant-registry records.

### 5. Normalized OpenAI, queue, and standalone-runtime semantics

- Unified backend and worker Responses-to-ChatCompletion conversion so
  refusals, tool calls, incomplete results, cancellation, failure, and unknown
  lifecycle states cannot masquerade as successful completed output.
- Required completed lifecycle state before accepting structured JSON.
- Consolidated Ask and GPT queue waiting into one bounded polling engine while
  preserving route-specific terminal mappings and abort behavior.
- Distinguished unavailable/missing jobs from outages without exposing
  credential or backend details.
- Restored fail-closed authentication and ownership to the opt-in BullMQ/Redis
  runtime.
- Added bounded payload/output policy, server-owned model and token limits,
  Redis-backed admission reservations, execution claims, stale-reservation
  reconciliation, readiness, and graceful bounded shutdown.
- Added disposable loopback Redis tests for cross-replica admission, BullMQ
  fencing, and terminal reservation release.

### 6. Added database, job, and DAG concurrency correctness

- Restricted database retries to an audited transient-read allowlist.
- Made collation inspection passive and schema initialization single-flight.
- Added `claim_generation` fencing to database-backed worker ownership with
  PostgreSQL 18 migration, rollback, and concurrency tests.
- Added `snapshot_generation` fencing to durable DAG snapshots with migration,
  rollback, guarded writes, conflict quarantine, and reconciliation.
- Added bounded per-process DAG admission and terminal retention.
- Made cancellation intent durable and serialized admission, execution-state
  publication, and cancellation through the same per-run persistence lane.
- Reconciled ambiguous initial commits by reading back the exact run identity
  and generation rather than abandoning uncertain durable ownership.
- Exposed bounded admission-monitor states without weakening the read policy.

These final three points directly close the three last reviewer comments:
generation-2 cancellation can no longer overtake generation-1 admission,
ambiguous initial commits are reconciled, and canonical credential isolation is
enforced by a complete matrix.

The new coordinated migrations are:

- `migrations/20260727_job_claim_generation_v1.sql`
- `migrations/20260727_job_claim_generation_v1.rollback.sql`
- `migrations/20260727_dag_run_snapshot_generation_v1.sql`
- `migrations/20260727_dag_run_snapshot_generation_v1.rollback.sql`

### 7. Hardened supply chain, release, CI, and documentation behavior

- Patched and policy-constrained the affected vendored brace-expansion path.
- Made publication consume only the source revision that passed validation.
- Restored startup, coverage, PostgreSQL fencing, local-agent concurrency,
  standalone Redis, deployment-readiness, and convergence gates.
- Added a production promotion hold for the coordinated DAG-writer migration.
- Reindexed generated backend and CLI documentation after structural changes.
- Updated maintained API, architecture, CI/CD, database, Railway, workspace,
  security, local-agent, and runtime documentation.
- Retired the unsafe root probe that referenced a missing test and could expose
  part of an API credential.

### 8. Removed the temporary dependency exceptions, delivered in PR #1410

- Upgraded `axios` from `1.16.0` to `1.18.1`.
- Kept `knex@2.5.1` and resolved its existing compatible range to
  `lodash@4.18.1`; no direct Lodash dependency or override was added.
- Upgraded `@modelcontextprotocol/sdk` from `1.29.0` to `1.30.0`, with
  SDK-scoped overrides to `@hono/node-server@2.0.12` and `hono@4.12.32`.
- Removed the entire package/advisory exception register from
  `scripts/check-npm-audit.js`. Every reported production vulnerability is now
  actionable, incomplete or internally inconsistent audit-v2 reports fail
  closed, and both CI and release validation require npm's raw exit and the
  repository policy to pass.
- Removed the `CVE-2026-4539` suppression from both Python audit workflows. A
  fresh resolution selected Pygments `2.20.0`; that is current resolver
  evidence, not a new repository pin.
- Raised the declared Node floor from `>=18.14.0` to `>=20.18.1`, matching the
  installed graph's existing Cheerio/Undici requirement, and aligned `.nvmrc`
  to `20.19.0`. The adopted node-server major independently requires Node 20+.
- Did not run `npm audit fix`; every manifest and lock change was reviewed as
  an isolated compatibility update.
- The historical pre-remediation baseline was six production vulnerability
  records and 22 development-inclusive package records. The current candidate
  has zero production records. Its 16 remaining high-severity package records
  are propagated from three development-only tooling families:
  `brace-expansion`, `js-yaml`, and `postcss`.
- Addressed the final review concern by dynamically importing the Node HTTP
  transport inside the round-trip test, so the separate entrypoint-load test
  actually exercises an isolated import.
- Delivered the reviewed candidate as commits `ccb18b71` and `aec39397` in
  PR #1410. The merge commit is `2c1be145`.

## Validation and review evidence

### PR #1408

The #1408 candidate passed:

- 4,944 root unit tests, with 14 expected skips
- 84 focused integration tests, with 9 expected skips
- 551 Windows Python tests, with 13 expected skips
- 546 local Python tests, with 18 expected skips
- 29 Linux sandbox tests
- 281 documentation checks
- 6 isolated PostgreSQL preview tests
- read-only and confirmation-only preview verification
- required GitHub and Railway preview checks

Seven independent readiness reviews returned approve-with-conditions with no
Critical or High finding. The conditions and reviewer-discovered gaps were
fixed before merge.

### PR #1409 exact head

The exact head `f932fc523833ecd0af9b889636271d7710a54d52`
passed:

- `npm run type-check`
- `npm run build`
- lint with 0 errors and 76 pre-existing warnings
- 549 root Jest suites: 6,429 passing tests; 5 suites/33 tests skipped
- 160 DAG tests; 10 skipped
- 44/44 focused DAG-admission tests
- 757 Python daemon tests; 18 skipped
- 175/175 Python credential-matrix cases
- 75/75 standalone-runtime integration tests
- 18/18 preview-safety harness cases
- 291/291 documentation checks
- Railway compatibility validation
- TypeScript/Python synchronization with 0 errors and 0 warnings
- commit guard and diff-integrity checks

The isolated Railway preview ran the exact head on both API and worker. Its
end-to-end suite passed 68/68 checks: 10 discovery checks, 47 read-only or
local-agent checks, and 11 confirmation-only checks.

All 18 GitHub check runs and both Railway status contexts on the exact PR head
were successful. GitHub had no unresolved review thread or change-request
review. Copilot left only a non-blocking note that the 562-file change exceeded
its 300-file review limit. Two additional independent full-diff reviews found
no P0-P2 issue after the final fixes.

### Post-merge `main`

[CI/CD run 30383751487](https://github.com/pbjustin/Arcanos/actions/runs/30383751487)
completed successfully on merge commit
`81376790c7b726a2a2f55a66980c460440873386`. All 13 jobs passed, including
unit, integration, security, PostgreSQL fencing/local-agent concurrency,
sandbox, Python, standalone Redis, Railway compatibility, deployment readiness,
and the aggregate all-checks job.

The ensuing
[Railway Auto Deploy run 30384724868](https://github.com/pbjustin/Arcanos/actions/runs/30384724868)
also completed successfully. Its policy job recorded that automatic promotion
was skipped because hold `20260727-dag-snapshot-generation-v1` is active; the
production deployment job was skipped. This is the intended safe outcome.

No production deploy, restart, variable mutation, migration, persistent live
memory mutation, or production smoke test was performed by this audit.

### Dependency-remediation candidate evidence, later merged in PR #1410

The candidate was validated on the authoritative Node `20.19.0` runtime with
npm `11.6.2`:

- The focused dependency graph is coherent:
  - `axios@1.18.1` resolves `follow-redirects@1.16.0`,
    `form-data@4.0.6`, `https-proxy-agent@5.0.1`, and
    `proxy-from-env@2.1.0`.
  - `knex@2.5.1` resolves `lodash@4.18.1`.
  - `@modelcontextprotocol/sdk@1.30.0` resolves the scoped
    `@hono/node-server@2.0.12` and `hono@4.12.32` overrides.
- Fresh `npm audit --omit=dev --json` returned zero vulnerabilities across 271
  production dependencies with raw exit 0. The strict
  `scripts/check-npm-audit.js` evaluation also exited 0 with no actionable
  entries.
- The fresh development-inclusive audit reported 16 high-severity vulnerable
  package records propagated from three development-only tooling families:
  `brace-expansion`, `js-yaml`, and `postcss`. It remains non-clean and is not
  represented as a production finding.
- Fresh `python -m pip_audit --format json --requirement
  daemon-python/requirements.txt` audited 77 resolved dependencies with zero
  vulnerabilities and resolved Pygments `2.20.0`.
- The strict npm audit-policy suite passed 26/26 tests. The combined audit
  policy, release-workflow, and MCP transport regression set passed 38/38.
- Axios-focused tests passed 37/37.
- Knex/Lodash-focused tests passed 13/13, and a no-database smoke compiled the
  seven real select, upsert, delete, purge, audit-insert, table-check, and
  table-create builder groups under Node `20.19.0`.
- All 15 MCP-focused suites passed 104/104 tests, including a real in-process
  Express/SSE initialize round-trip through
  `StreamableHTTPServerTransport.handleRequest`.
- `npm run type-check` passed, including all boundary and cycle checks.
- `npm run lint` passed with 0 errors and the same 76 inherited warnings.
- `npm run build` passed.
- Before the final two CI-policy cases were added, the full root
  `npm test -- --silent` gate passed 549/549 active suites and 6,422/6,422
  active tests, with 5 suites/33 tests skipped and 100% configured coverage.
- On the exact current candidate, an in-band Node `20.19.0` no-coverage run
  passed all 549 active suites and 6,424 active tests, with the same 5
  suites/33 tests skipped. Two parallel coverage attempts each passed 548
  active suites and 6,423 active tests but hit the same unrelated hard
  five-second `spawnSync bash` timeout in
  `phase2e-migration-validator.test.ts`. That 13-test suite then passed alone
  in 3.45 seconds. The normal parallel coverage gate is therefore not recorded
  as clean for the exact current candidate; the evidence points to a
  concurrency-sensitive pre-existing timeout rather than a dependency-policy
  regression.
- `npm run docs:check` and `git diff --check` passed.

At the time of this validation the candidate was uncommitted and undeployed.
It was subsequently committed, reviewed, and merged in PR #1410. No provider,
database, Railway, production, or preview target was mutated by dependency
remediation or its validation.

## Operational state at original capture

| Target | Observed state |
| --- | --- |
| GitHub `main` | `81376790c7b726a2a2f55a66980c460440873386`, the #1409 merge |
| Open pull requests | 0 |
| Production worker | Successful 2026-07-25 deployment at #1408 merge `f5c7826e...`; #1409 not deployed |
| Production API | Successful deployment created 2026-07-25; it predates #1409 and Railway exposes no commit for that deployment |
| Production promotion | Blocked by the active coordinated-writer hold |
| Review preview | `arcanos-preview-bf8ac3bd` (`99d9eeae-c618-4a77-8498-85dd0d7444cc`) remains live; exact-head API, worker, PostgreSQL, and Redis are successful |
| Local preview daemon | Stopped |
| Dedicated Podman machine | `arcanos-preview-sandbox` exists but is stopped |
| Preserved unrelated work | `stash@{0}: codex-preserve-unrelated-before-local-agent-preview` remains |

The temporary preview GPT
`g-6a63f75beba88191a5f5d93e7abfb911` documented by the E2E run has no
verified deletion evidence. The preview environment and its stateful services
continue to consume provider resources until explicitly removed.

Eight older non-production Railway environments were also still subscribed to
`main` and received 16 merge-triggered API/worker deployments. At capture, all
16 were terminal: 5 succeeded and 11 failed. One environment was fully
successful; the other seven had at least one failed service. They were not
production, but their ownership, branch subscriptions, and continued need
should be audited before any exact-target cleanup.

## Work remaining at original capture

This list preserves the original decision state. Completion and reprioritization
are recorded in the 2026-07-29 continuation below.

### P0 — Retire the review preview and its credentials

After confirming it is no longer needed:

1. Re-read the exact teardown targets in
   [the preview report](../../../PREVIEW_E2E_REPORT.md).
2. Verify the target is the non-production environment
   `arcanos-preview-bf8ac3bd` with ID
   `99d9eeae-c618-4a77-8498-85dd0d7444cc`, not production.
3. Prefer deleting that exact environment so its API, worker, PostgreSQL,
   Redis, volumes, domain, and preview-only variables are retired together.
4. Verify and delete only temporary preview GPT
   `g-6a63f75beba88191a5f5d93e7abfb911`; do not alter any production GPT.
5. Revoke preview-only application, daemon, device, and database credentials
   if teardown is delayed or provider deletion does not remove them.
6. Inspect before removing the four disposable local artifacts named
   `arcanos-local-agent-preview-bf8ac3bd-fixture`,
   `arcanos-local-agent-preview-bf8ac3bd-state`,
   `arcanos-local-agent-preview-bf8ac3bd-fixture.patch`, and
   `arcanos-local-agent-preview-bf8ac3bd-sandbox-preview.patch` under the local
   temporary directory.
7. Remove the dedicated stopped Podman machine and preview-only image only
   after exact-target verification.
8. Inspect `stash@{0}` before deciding whether to restore or drop it.

This teardown was not performed because the merge-readiness authorization did
not extend to deleting provider environments, GPTs, local artifacts, or stashes.

### P1 — Perform the coordinated production rollout

PR #1409 is not yet running on either production writer. Follow
[the Railway runbook](../../../RAILWAY_DEPLOYMENT.md) and
[the database migration guide](../../../DATABASE_MIGRATIONS.md) as the current
authorities:

1. Attach the dependency-remediation evidence to the production authorization
   bundle: reverify that the production-only npm audit and fresh Python audit
   remain clean, record development-only audit residuals separately, and verify
   that the strict npm policy contains no exceptions. If an audit regresses
   before rollout, stop and obtain separate risk acceptance rather than
   silently restoring an ignore.
2. Obtain exact production project, environment, API service, worker service,
   and database authorization.
3. Inventory every process capable of writing DAG snapshots, including all web
   replicas, workers, maintenance paths, and restart policies.
4. Reverify native Railway auto-deploy is disabled for both production writer
   services.
5. Re-audit live Railway drift in
   [issue #1225](https://github.com/pbjustin/Arcanos/issues/1225). Its original
   start-command claim is stale, but `/healthz` still differs from the
   repository `/health` contract and five of its six named variable keys were
   still absent at capture.
6. Confirm the exact database target, backup/restore evidence, migration
   permissions, rollback boundary, and forward-fix plan.
7. Drain or stop every old DAG writer and prevent an old binary from restarting.
8. Only after a real drain, use the exact manual attestation
   `DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1`. The phrase is an
   attestation, not a drain command.
9. Apply the compatible schema/code pair and coordinate both API and worker;
   the current workflow deploys only one configured service.
10. Verify schema generation, exact deployed source revision on every writer,
    absence of old replicas, health, readiness, and bounded logs.
11. Keep the hold active through acceptance or rollback.
12. After acceptance, use a separate reviewed change to set the hold sentinel
    to `none`, then re-enable the intended native deployment triggers.

Productivity startup DDL separately needs exact-target proof, backup,
permissions, and forward-fix planning. Local-agent production enablement
remains fail-closed until its migration, canonical credential registry,
workspace ownership, sandbox, and operator runbook are approved.

### P1 — Audit stale non-production Railway environments

Determine why eight older environments still follow `main`, whether any are
owned test environments, and whether their failed merge-triggered deployments
are expected. Remove or unsubscribe them only through an exact-target,
owner-reviewed cleanup. Do not include production or the active review preview
in a bulk operation.

### P2 — Close accepted security, scale, and lifecycle residuals

These were accepted as non-merge-blocking but are required before the stated
expansion:

- Define retention and audited cleanup for terminal local-agent jobs, output,
  events, bindings, productivity receipts, and reconciliation evidence.
- Add an operator-reviewed archive/manual-reconciliation workflow for uncertain
  file-mutation outcomes.
- Add pagination, bounded projections, and load tests before increasing
  productivity tenant volume.
- Move process-local confirmation and rate-limit state to an approved shared
  store before non-sticky horizontal scaling.
- Keep mutation workspaces private to the daemon account and retain identity
  rechecks, quarantine, backups, and manual reconciliation for filesystem
  time-of-check/time-of-use risk.
- Pin immutable sandbox and PostgreSQL CI images and define provenance/SBOM
  policy before broader distribution.
- Use a dedicated daemon account, encrypted platform storage, credential
  rotation/revocation, and a reviewed SQLite journal retention policy.
- Continue to treat repository, test, and daemon output as untrusted prompt
  data rather than execution authority.
- Tighten OpenAPI output schemas without creating a second protocol authority.
- Add privileged Windows symlink coverage when the test host supports Developer
  Mode/elevation.
- Add the missing focused test for the complete dispatcher
  interception/persistence branch before using it as operational evidence. This
  focused-test gap is closed by the continuation's memory-auth work.

### P3 — Continue maintainability cleanup in isolated batches

The dependency graph is now cycle-free and guarded, but the repository is not
literally debt-free:

- A supplemental strict compiler probe with `noUnusedLocals` and
  `noUnusedParameters` produced 53 diagnostics. These flags are not current CI
  gates; clean the findings in characterized slices before considering a gate.
- Lint still reports 76 warnings.
- Several modules remain large and should be treated as future isolated
  extraction candidates, including `selfHealingLoop.ts`,
  `arcanosDagRunService.ts`, `predictiveHealingService.ts`,
  `gamingWebContext.ts`, `gptRouter.ts`, `gptAccessGateway.ts`, and
  `jobRepository.ts`.
- The active [deprecation register](../../../../DEPRECATION.md) still needs
  runtime or owner evidence for `legacy/`, `/brain`, `/api/arcanos/ask`,
  compatibility route adapters, `Procfile`, middleware re-export shims,
  multiple worker runtimes, and the old server bootstrap.
- GitHub now warns that Node 20 JavaScript actions are being forced to Node 24.
  PR #1410 partially remediated this in the release workflow by pinning
  supported actions; remaining workflows still require an inventory and
  isolated upgrades rather than an insecure runtime override.
- Two pre-existing code TODOs remain: confidence extraction in the standalone
  runtime execution controller and a possible future AI-assisted GPT planner.
  PR #1409 added no `TODO`, `FIXME`, `HACK`, or `XXX` marker.
- Most of these residuals have no dedicated open tracking issue. Create
  owner-, scope-, and acceptance-criteria-specific issues before treating them
  as a parallel cleanup program.

### Deferred and separate work

- The proposed Redis outage/recovery experiment remains not authorized and is
  not required to close this remediation. It needs a separate exact-target
  plan and approval.
- The GPT-OSS production `NO-GO` roadmap is a separate product program, not
  unfinished #1409 remediation.
- Old PR-assistant automation issues and unrelated historical stashes should
  not be folded into a health-remediation change without separate scope review.

## Recommended next sequence at original capture

1. Authorize and execute exact-target preview/GPT/local cleanup.
2. Audit the stale non-production Railway subscriptions.
3. Prepare the exact production writer/database authorization bundle, include
   the recorded dependency-remediation evidence, and run the coordinated
   rollout.
4. Open small, independently tested follow-ups for retention/scale controls,
   then no-unused/lint/large-module/deprecation cleanup.

The first three steps complete the operational work around the merged changes.
The fourth is continuing repository stewardship rather than a blocker to the
already merged PR.

## Continuation update — 2026-07-29

This section records the current coordination baseline. It preserves the
original snapshot above rather than silently rewriting dated provider and CI
observations.

### Chronology and exact state transitions

| Item | Current evidence |
| --- | --- |
| GitHub `main` | The local tracking ref is `2c1be145da9faf5e60b811f25bc361a5aaf8d31e`, the merge of PR #1410. |
| Dependency remediation | Commits `ccb18b71` and `aec39397` are merged. No npm or Python audit waiver was extended or reintroduced. |
| Review Railway environment | The exact environment deletion was separately authorized. The historically linked checkout now returns `Environment is deleted` from `railway status --json`, consistent with retirement of `arcanos-preview-bf8ac3bd` (`99d9eeae-c618-4a77-8498-85dd0d7444cc`). |
| Named local preview artifacts | All four exact temporary paths listed in the teardown plan are absent. |
| Dedicated Podman runtime | `podman machine list --format json` returns an empty list; the preview-only machine is gone. |
| Preserved Git work | `stash@{0}: codex-preserve-unrelated-before-local-agent-preview` remains and was not dropped or applied. |
| Temporary GPT | Provider-side deletion of `g-6a63f75beba88191a5f5d93e7abfb911` was not reverified during this continuation. Railway teardown is not evidence of GPT deletion. |
| Production | No production deployment, migration, restart, variable change, smoke test, or live memory operation was performed by this continuation. The inherited evidence still places production on the #1408 baseline `f5c7826e`; reverify immediately before any rollout. |
| Older non-production environments | No bulk cleanup is claimed. Ownership and branch-subscription review remains an exact-target task. |

### Historical pre-#1411 repository-health judgment

The repository is not best described as repository-wide spaghetti code.
Protocol, CEF, package, writing-plane, and control-plane boundaries are explicit
and executable; dependency cycles are gated; testing and maintained
documentation are unusually broad. Risk is concentrated in a small number of
large orchestrators, duplicated policy builders, and two confirmed defects.

| Dimension | Historical pre-#1411 judgment, superseded below |
| --- | --- |
| Maintainability | Improved and generally structured, with high-risk concentration in GPT routing, job lifecycle, Trinity, Gaming context, and dual self-heal ownership. |
| Scalability | Viable at the current characterized envelope; shared-state, pagination, retention, queue-lifecycle, and load evidence are still required before material horizontal or tenant-volume expansion. |
| Security | Stronger after #1409/#1410, but production does not yet contain #1409 and the final memory-plane containment candidates remain local. Session IDs remain caller-controlled scope, not tenant authentication. |
| Testing | Strong focused and broad coverage with executable architecture gates. The old-baseline exploratory broad run has seven known failures and is not represented as clean. |
| Documentation | Strong generated and maintained-doc checks, but the served Custom GPT bridge OpenAPI document has a confirmed public-contract defect. |
| Spaghetti-code assessment | No repository-wide finding. A few oversized state machines and duplicated boundary utilities deserve isolated characterization-led extraction. |

### Isolated memory-plane authentication containment

The first post-audit implementation slice is locally complete in two separate
worktrees so current `main` can be fixed normally without losing the option to
contain the exact deployed baseline.

| Candidate | Base and local state | Purpose |
| --- | --- | --- |
| `codex/memory-plane-auth-hotfix` in `C:\pbjustin\Arcanos-memory-plane-auth-hotfix` | Exact production baseline `f5c7826e`; 25 modified and 10 untracked entries; zero staged commits | Behavior-complete backport that can contain the memory plane without deploying all post-#1408 changes. |
| `codex/memory-auth-forward-fix` in `C:\pbjustin\Arcanos-memory-auth-forward-fix` | Exact `origin/main` `2c1be145`; 16 modified tracked files; zero staged commits | Narrow forward fix so a later full-`main` rollout does not regress pre-parser authentication, `no-store`, or sanitization parity. |

Both candidates remain uncommitted, unpushed, unmerged, and undeployed. The
forward fix is suitable for a normal PR to current `main`. The `f5c7826e`
backport is an exact release-baseline candidate, not a second normal PR
containing current-main work.

The deployed-baseline candidate adds six narrow modules:

- `src/shared/security/purposeBoundCredential.ts`
- `src/shared/security/memoryAccessCredential.ts`
- `src/transport/http/middleware/memoryPlaneAuth.ts`
- `src/shared/gpt/gptModuleAction.ts`
- `src/shared/memory/memoryDispatchRouting.ts`
- `src/services/memoryDispatchInterception.ts`

The resulting containment contract is:

- The sole caller credential is the exact `x-arcanos-memory-token` header,
  backed by `ARCANOS_MEMORY_ACCESS_TOKEN`.
- The configured token is resolved on every request, is case-sensitive, must be
  32–4096 characters, rejects whitespace and placeholder values, and cannot
  collide with another registered purpose-bound credential. Opaque comparisons
  use timing-safe equality.
- Bearer credentials, cookies, query values, and body fields cannot grant
  memory authority. Duplicate custom-header values are rejected.
- Missing, malformed, duplicate, or incorrect caller credentials return
  `401 MEMORY_AUTH_REQUIRED`; missing, invalid, or colliding server
  configuration returns `503 MEMORY_AUTH_UNAVAILABLE`.
- `/api/memory`, `/api/save-conversation`, and `/api/sessions` authenticate
  before broad JSON or form parsing. CORS preflight remains available before
  authentication.
- Exact GPT memory actions authenticate after bounded request parsing and
  classification but before fast-path execution, queue admission, or memory
  execution. They execute synchronously and bypass the durable job lane.
- The dispatcher sink independently requires the server-owned
  `memoryPlaneAuthorized === true` context. Body or payload spoofing cannot set
  it, and background-worker callers fail closed.
- Denials and successful authenticated responses use `Cache-Control: no-store`.
- Spreading the explicit GPT payload before prompt extraction removes the
  inherited-prototype alias discrepancy found by differential review.

The token is deployment-wide containment, not tenant identity or session
ownership. `/brain` compatibility handling, MCP memory tools, and a true
tenant/session authorization model remain explicit non-goals for this slice.

### Memory-plane validation and independent review

The exact `f5c7826e` backport passed on the authoritative cached Node
`20.19.0` executable:

- 10 focused Jest suites and 201 tests
- `npm run type-check`, including boundary, CEF, routing, package, and TypeScript
  checks
- `npm run lint` with 0 errors and 84 inherited warnings
- `npm run build`
- `npm run validate:railway`
- 290/290 documentation checks
- `git diff --check`, with line-ending notices only
- generated-index verification for all six new source modules

An earlier exploratory broad run on the old `f5c7826e` baseline used the
non-authoritative Node 24 host. It produced 457 passed, 7 failed, and 5 skipped
suites; 5,028 passed, 15 failed, and 12 skipped tests. All seven failing files
were untouched baseline tests:

1. `tests/gate-r1-postgres-r3b2-procedure-contract.test.js`
2. `tests/gate-r1-projector-session.test.js`
3. `tests/gate-r1-postgres-r3-procedure-contract.test.js`
4. `tests/gate-r1-procedure-contract.test.js`
5. `tests/phase2e-migration-validator.test.ts`
6. `tests/gptoss-private-serving-durable-replay-migration-guard.test.ts`
7. `tests/gate-r2-projector-session.test.js`

The broad old-baseline gate is therefore not recorded as clean and those
unrelated failures are not part of this memory slice.

The exact current-main forward fix passed on Node `20.19.0`:

- 7 focused Jest suites and 148 tests
- `npm run type-check`, including the cycle gate
- `npm run lint` with 0 errors and 76 warnings, all outside changed files
- `npm run build`
- `npm run validate:railway`
- 291/291 documentation checks
- `git diff --check`, with line-ending notices only

Four independent review passes materially shaped and then cleared the work:

- A behavior reviewer compared a 144-case classifier matrix with zero mismatch
  for ordinary JSON values, found the inherited/prototype alias discrepancy,
  and requested chat-alias, scalar, null, array, and background-worker cases.
  Those cases and the sanitization fix were added.
- A scope reviewer found missing changelog, generated-index, malformed-JSON,
  and `/dispatch` status-map evidence. Each gap was closed.
- A security reviewer required `no-store` on successful sensitive responses and
  corrected an overstatement that GPT authentication was pre-parser. Both were
  fixed; the final backport review returned no finding.
- A separate current-main security re-review found no issue in the final
  16-file diff.

No secret value is recorded in source, tests, logs, or this report.

### Historical pre-#1411 Git and authorization state

| Worktree | State |
| --- | --- |
| `C:\pbjustin\Arcanos` | Historical `codex/health-audit-progress-report` at `81376790`; three commits behind `origin/main`; pre-existing tracked dependency/report changes preserved; this report remains uncommitted. |
| `C:\pbjustin\Arcanos-dependency-waiver-remediation` | Clean at `aec39397`; one merge-only commit behind `origin/main`; tree-identical to `2c1be145`. |
| `C:\pbjustin\Arcanos-memory-plane-auth-hotfix` | Exact `f5c7826e` base; local unstaged backport described above. |
| `C:\pbjustin\Arcanos-memory-auth-forward-fix` | Exact current `origin/main`; local unstaged forward fix described above. |

Local implementation and validation were authorized. This continuation does
not authorize staging, committing, pushing, opening a pull request, deploying,
applying a migration, changing variables, invoking live memory operations, or
mutating production/provider state. The two memory candidates therefore stop
at reviewed local diffs.

### Historical pre-#1411 ranked residual audit board

This ranking was reverified against current `origin/main` `2c1be145`; the clean
dependency-remediation checkout at `aec39397` is tree-identical.

| Rank | Classification | Finding and evidence | Safest next move |
| ---: | --- | --- | --- |
| 1 | Confirmed public-contract defect | `openapi/custom-gpt-bridge.yaml:16` still serves `YOUR-RAILWAY-DOMAIN` through `src/routes/introspection.ts:96`. `BridgeRequest.action` is required at YAML line 196 even though `src/services/customGptBridgeService.ts:64` defaults omission to `query`. The two polling operations around YAML lines 150–167 lack response schemas. `tests/introspection-openapi-contract.route.test.ts:168` only checks substrings and misses all three. | Repair only the YAML contract and replace substring checks with parsed, local-reference-resolving assertions. No runtime, database, queue, or provider change is required. |
| 2 | Confirmed conditional defect and ownership risk | The web runtime starts `controlLoop` at `src/app.ts:103` and a separate `selfHealingLoop` at `src/server.ts:333`. `controlLoop` reports private mitigations applied around `src/services/selfImprove/controlLoop.ts:672`, but its getter at line 1133 has no consumer. Trinity reads the separate `selfHealingV2` state at `src/core/logic/trinity.ts:826`. The configured degraded/bypass mitigation can therefore be inert. | First characterize both state owners and startup modes; then establish one authoritative mitigation state without mixing broader self-heal redesign. |
| 3 | P1 refactor risk | The route handler beginning near `src/routes/gptRouter.ts:1223` spans about 2,149 lines and crosses fast-path classification, execution planning, queue choice, and final dispatch. It resolves routing/action state before `src/routes/_core/gptDispatch.ts` resolves related state again. No specific defect is proven. | Extract one already-characterized state transition at a time; preserve queue, timeout, fallback, and response contracts. |
| 4 | P1 scalability and concurrency risk | The lifecycle block beginning at `src/workers/jobRunner.ts:1185` spans roughly 730 lines across polling/claim, lease heartbeat, execution, claim fencing, terminal compare-and-swap, cancellation, retry, and failure. | Add lifecycle characterization around one seam before extracting it; do not mix claim, cancellation, and terminal-state changes. |
| 5 | P2 drift risk; ideal pure refactor | The CLEAR recheck payload builder is triplicated at `src/routes/plans.ts:646`, `src/mcp/server/actionPlanTools.ts:144`, and `src/mcp/server/helpers.ts:91`. Existing parity tests already compare the outputs. | Consolidate one shared pure builder and keep the parity tests. This is the safest behavior-preserving refactor after confirmed defects. |
| 6 | P2 boundary-consistency risk | Thirty-one local `isRecord`/`asRecord`/`toRecord` guards exist despite canonical helpers in `src/shared/typeGuards.ts:6` and `src/shared/http/clientResponseCommon.ts:40`. Boolean environment parsing also differs between `src/services/gptDagBridge.ts:82` and `src/routes/gptRouter.ts:466`. | Inventory semantics first, then migrate one compatible family at a time. Do not globally replace guards with different null/array/prototype behavior. |
| 7 | P2 concentrated orchestration risk | `src/core/logic/trinity.ts` is 1,696 lines and `runThroughBrain` owns staged generation, self-heal, CLEAR audit, escalation, reflection, filtering, and integrity. `src/services/gamingWebContext.ts` is 3,454 lines and owns URL safety, fetching, ranking, caching, discovery, and RAG assembly. | Treat them as cohesive hotspots, not proven defects. Extract only a pure, directly testable stage per slice. |
| 8 | Governance and deprecation debt | `DEPRECATION.md:20`, `:23`, and `:26` retain overdue decisions for `/brain`, `Procfile`, and multiple worker runtimes. The default-gone `/brain` surface still carries a large compatibility implementation behind a late 410 gate. | Obtain runtime caller and owner evidence before deletion; do not combine it with the defect fixes above. |

### Historical pre-#1411 recommended sequence

1. Freeze the validated memory-auth diffs. With separate Git authorization,
   stage, commit, push, and open a normal PR for
   `codex/memory-auth-forward-fix`.
2. Separately decide whether the exact `f5c7826e` backport should be packaged as
   a production-baseline release candidate. Reverify the actual deployed
   revision before that decision; do not silently turn it into a current-main
   PR.
3. Fix the served Custom GPT bridge OpenAPI contract as the next isolated
   current-main slice, with parsed contract tests.
4. Characterize and repair the dual self-heal state-owner defect without
   redesigning the full subsystem.
5. Consolidate the three CLEAR recheck builders behind one pure shared helper.
6. Continue GPT router and job-runner extraction only as small,
   behavior-preserving, separately verified slices.
7. Prepare and reverify the coordinated production database/API/worker rollout
   bundle. Keep the promotion hold active and obtain exact production
   authorization before every live operation.

## Post-#1411 audit continuation — 2026-07-29

This is a living, dated continuation of the repository-wide audit. It preserves
the prior sections as historical evidence and records only claims reverified
against current `origin/main` or the exact merged PR #1411 tree. The first
update below was captured at 2026-07-29T20:03:09Z; terminal post-merge workflow
evidence was added through 2026-07-29T20:05:33Z, and the residual audit was
reconciled through 2026-07-29T20:23:05Z.

### Reconciled source, delivery, and isolation evidence

| Subject | Reverified state |
| --- | --- |
| Current remote source | `origin/main` is merge commit `481a1fb3e9f935699a2fcf685841e34edb04012e`. |
| PR #1411 | Merged on 2026-07-29T19:52:32Z. Its exact head was `7252172181962148bb0cb192d2398c366a4541b7`; it contains 5 commits across 22 files, +274/-44. |
| Clean audit checkout | `C:\pbjustin\Arcanos-memory-auth-forward-fix` is clean at the exact PR head and `git diff origin/main HEAD` is empty, so its source tree is identical to the merge commit. |
| Historical report checkout | `C:\pbjustin\Arcanos` remains on `codex/health-audit-progress-report` at `81376790`, 0 commits ahead and 9 behind `origin/main`. Its 16 pre-existing tracked edits and untracked audit directory remain preserved; only this report is being updated in this continuation. |
| Active memory API E2E | An isolated disposable Railway deployment of exact head `72521721` passed all 12 assertions: authentication ran before parsing; Bearer-only requests were denied; the approved header credential reached parsing; confirmation was enforced; save/load/list/delete/post-delete absence worked; and sensitive responses used `Cache-Control: no-store`. |
| E2E topology and health | The test used a fresh PostgreSQL service only. It deliberately omitted OpenAI, Redis, and workers. `/api/memory/health` returned HTTP 200 with database connectivity true; `/readyz` correctly returned 503 because the OpenAI dependency was intentionally unavailable. |
| E2E teardown and containment | The disposable environment, services, volume, domain, and local harness were deleted. The native PR preview and production were reverified unchanged. No production, temporary-GPT, Podman, stash, or unrelated local artifact was mutated. |
| Merge-state diagnosis | The PR's transient `UNSTABLE` state was traced to workflow run `30476522290`, which was waiting for approval after a Copilot review trigger. After the user-approved workflow was run, it passed and the PR reported `MERGEABLE`/`CLEAN`; all 22 visible PR contexts passed before merge. |
| Post-merge `main` workflows | Repository registration, documentation audit, and documentation-update analysis passed. Authoritative CI/CD run `30486295138` completed successfully with all 13 jobs passing. |
| Production-promotion policy | Follow-on Railway Auto Deploy run `30487099635` passed the policy job and skipped `Deploy Production (Railway)` because hold `20260727-dag-snapshot-generation-v1` remains active. No GitHub-driven production deployment started. |

### Newly confirmed highest-priority residuals

#### P1 / SEC-AUTH-001 — Canonical GPT writing has no authentication or admission budget

**Severity:** High public abuse, provider-cost, and durable-work admission risk.

**Location and evidence:** `src/routes/register.ts:169` mounts the canonical
router at `/gpt`; `src/app.ts:256-276` applies broad parsing, body fallback, the
runtime unsafe-state gate, and OpenAI initialization without a caller-auth or
rate-limit middleware. The main handler begins at
`src/routes/gptRouter.ts:1223`, and that file does not apply
`createRateLimitMiddleware`. Its `buildGptRequestAuthState` helper at lines
1078-1110 explicitly supports `anonymous`; it records header presence but does
not verify a credential.

Anonymous requests can reach paid execution. The fast path calls
`executeFastGptPrompt` at `src/routes/gptRouter.ts:2072-2084`, which enters the
Trinity/OpenAI pipeline at `src/services/gptFastPath.ts:142-208`. Async writing
also reaches durable job construction around
`src/routes/gptRouter.ts:2300-2330`. The maintained API guide supplies an
unauthenticated curl example at `docs/API.md:29-35` and documents provider and
durable writing behavior at lines 50-81. It says the memory token applies only
to exact memory interception at lines 396-403. Tests such as
`tests/gpt-fast-path.route.test.ts:272-315` and `:317-360` exercise successful
provider/direct execution without authentication headers.

**Impact:** any network caller that can reach the service can submit unbounded
paid model work and, for job-backed requests, database/queue work. Provider
quotas may eventually stop spend but do not provide fair admission or protect
application capacity. This broader exposure exists independently of the
caller-selected rate-limit keys on the narrower utility routes below.

**Safest next decision and fix:** add a non-bypassable provider-ingress budget
first, shared by canonical `/gpt/:gptId` and deprecated
`/api/arcanos/ask`, without changing the documented anonymous contract in that
first slice. Key authenticated callers by verified credential, never replace
the ingress budget with caller-selected session metadata, add a
deployment-wide ceiling, and bound durable-queue admission before provider or
database work. Separately decide whether anonymous GPT writing remains an
intentional supported product contract; requiring a new credential would need
client migration and is a larger compatibility change.

**Mitigation and uncertainty:** Railway, an upstream gateway, or the provider
account may impose external quotas, but no equivalent application control is
visible in the repository. CORS and the unsafe-state gate are not caller
authentication. Because authentication would change the documented public
contract, this requires a product/compatibility authorization bundle rather
than an opportunistic code edit.

#### P1 / CI-GOV-001 — Main does not require the authoritative quality gates

**Severity:** High release-governance risk.

**Live evidence:** a read-only GitHub branch-protection query at
2026-07-29T20:11:56Z returned only `docs:check` as a required status for
`main`, with strict/up-to-date checking disabled. Required approving reviews
and conversation resolution were absent, administrators were not covered, and
the repository returned zero rulesets. This directly conflicts with
`.github/workflows/ci-cd.yml:1`, which describes `CI/CD Pipeline` as the
authoritative required workflow, and leaves its aggregate
`All Checks Complete` job at lines 482-502 advisory rather than enforced.

**Impact:** a future pull request can merge while lint, type-check, build,
Jest, integration, security audit, PostgreSQL fencing, Redis admission,
Railway compatibility, or deployment-readiness jobs are failing, missing, or
still running. The fact that merge commit `481a1fb3` voluntarily passed all 13
jobs does not protect later merges.

**Safest settings bundle:** require the stable `All Checks Complete` context
and `docs:check`, require the branch to be current before merge, require pull
requests and conversation resolution, and enforce the rule for administrators.
The repository currently has one human writer, who is its sole administrator,
so begin with zero required approvals rather than creating an impossible
self-approval gate. Raise that to one approval with stale-review/last-push
protection when a second maintainer exists. Apply and verify settings with an
exact `pbjustin/Arcanos`/`main` plan so a renamed or non-emitting context cannot
deadlock merges.

**Mitigation and uncertainty:** maintainers may be following the full checks
manually, but no current GitHub rule enforces that practice. Changing branch
protection is an external mutation and is not authorized by this report update.

#### P2 current / P1 latent / CI-SEC-002 — Active manual workflows run unchecked refs with persisted write credentials

**Severity:** Moderate current workflow-credential and supply-chain risk;
high latent provider-secret exposure if that secret is configured or dispatch
authority expands.

Both active `workflow_dispatch` definitions accept a caller-selected ref,
request `OPENAI_API_KEY` at workflow scope, check out that ref with the default
persisted GitHub credential, and run candidate-controlled repository code
before proving the commit is trusted:

- `.github/workflows/arcanos-code-analysis.yml:6-18` accepts `commit_sha` and
  requests the provider secret; lines 24-44 grant write permissions, check out
  the selected ref without `persist-credentials: false`, and run `npm ci`.
- `.github/workflows/arcanos-deploy.yml:10-30` accepts
  `merge_commit_sha` and requests the same secret; lines 33-54 grant broad
  write permissions, check out the selected ref without disabling credential
  persistence, and run `npm ci`.
- `package.json:198` makes ordinary `npm ci` execute the checked-out
  `scripts/postinstall.cjs`. The selected commit can also alter later build,
  test, and start scripts. Neither workflow first requires a full immutable SHA
  reachable from protected `main` with successful authoritative CI.

**Impact:** an actor allowed to dispatch either workflow can select non-main
code whose install or validation scripts use or exfiltrate the checkout's
write-scoped GitHub credential within the job's repository, Actions, and pull
request permissions. Current live collaborator data shows only the sole
administrator can dispatch, which materially lowers present exploitability. If
dispatch authority expands or `OPENAI_API_KEY` is later configured, the same
candidate code can expose write capabilities or consume provider budget.

The deployment workflow has a separate correctness defect:
`.github/workflows/arcanos-deploy.yml:117-138` explicitly simulates deployment
without any Railway deploy operation, yet writes
`Status: Deployed successfully`; lines 171-186 may post that false attestation
to a pull request. Its input named `environment` is not a protected GitHub
Actions job environment.

**Safest isolated fix:** disable or fail-close these legacy workflows first,
then rebuild from trusted default-branch code: validate a full SHA and
default-branch ancestry before candidate checkout; require successful
authoritative CI for that exact SHA; keep provider secrets out of install,
build, and test steps; use `persist-credentials: false` and
`npm ci --ignore-scripts` where the validated task permits them; minimize
permissions; use an actual protected job environment; and label a simulation
as readiness analysis rather than deployment.

**Mitigation and uncertainty:** dispatch requires repository write access, the
deployment workflow has no recorded run, and a read-only secret-name query at
2026-07-29T20:13Z showed no repository `OPENAI_API_KEY` secret, which removes
the claimed current provider-secret exposure. The repository is user-owned, so
there is no organization-secret fallback; neither workflow binds a protected
environment. Both workflows and their write-scoped checkout credentials are
nevertheless active. No workflow, permission, or secret setting was changed
during this audit.

#### P1 / SEC-RATE-001 — Caller-selected identities bypass public provider rate limits

**Severity:** High for abuse and provider-cost exposure.

**Location and evidence:** `src/platform/runtime/security.ts:255-269` accepts
`x-session-id`, `mcp-session-id`, body `sessionId`, or query `sessionId` without
authentication. `getRequestActorKey` at lines 304-329 gives that value priority
over authenticated and ingress identities. The default limiter at lines
403-471 creates a separate process-local `Map` entry for every resulting key.
Its final fallback also accepts the first raw `x-forwarded-for` value at lines
222-230 and 277-280 rather than using a verified proxy-chain policy.

The behavior is intentional enough to be locked into
`tests/security-rate-limit.test.ts:95-117`, which asserts that two
caller-selected sessions on one address receive separate budgets. That policy
is unsafe when used by public provider-backed routes. Confirmed examples are
`POST /api/arcanos/ask` (`src/routes/api-arcanos.ts:50-55`, `:483-537`),
`POST /image` (`src/routes/image.ts:8-28`), `POST /api/vision`
(`src/routes/api-vision.ts:17-18`, `:75-130`), `POST /api/transcribe`
(`src/routes/api-transcribe.ts:16-17`, `:58-106`),
`POST /api/web/search` (`src/routes/web-search.ts:47-70`),
`POST /api/ask-hrc` (`src/routes/hrc.ts:9-29`,
`src/services/hrc.ts:43-80`), `POST /api/sim`
(`src/routes/api-sim.ts:16-17`, `:169-186`), and
`POST /query-finetune` (`src/routes/queryFinetune.ts:21-32`, `:39-60`).
This list is not yet claimed exhaustive. The maintained API guide identifies
the first four as public AI utility/media or integration surfaces at
`docs/API.md:151`, `:318`, and `:337-346`; no upstream application
authentication precedes the provider work in these confirmed routes.

**Impact:** an unauthenticated caller can rotate `x-session-id` values to
receive a fresh application budget on every request, amplifying paid provider
usage plus CPU, memory, and network work. Rotating the raw forwarded-address
header may provide a second bypass depending on edge header rewriting. Each
replica has an independent counter map, so horizontal scaling multiplies the
effective budget.

**Safest isolated fix:** first add route-level regression tests that exhaust a
budget while rotating caller session metadata. Then give public paid routes an
ingress-derived abuse budget that caller metadata cannot replace; a subordinate
session budget may remain for fairness. Define and test the Railway proxy trust
chain before consuming forwarded addresses, and use an approved shared limiter
before non-sticky multi-replica scaling.

**Mitigation and uncertainty:** an external gateway/WAF or provider quota may
cap total damage, but no such control is visible in repository source and it
would not make the advertised application limit effective. Exact edge header
rewriting must be verified; the `x-session-id` bypass does not depend on that
unknown. At that audit checkpoint, no fix was authorized.

#### P2 current / P1 before multi-writer memory rollout — Natural-language memory auto-key collisions can overwrite a distinct save

`src/services/naturalLanguageMemory.ts:1131-1147` constructs an automatic key
from the session identifier, the first eight normalized content words, and a
timestamp truncated to second precision. The save path at
`src/services/naturalLanguageMemory.ts:613-632` reuses a key only when the
latest payload is identical; two different payloads in the same session, with
the same first eight normalized words, can therefore receive the same key when
saved during one second.

The storage contract makes this destructive rather than merely ambiguous:
`src/core/db/schema.ts:228-235` declares `memory.key` unique, while
`src/core/db/repositories/memoryRepository.ts:94-110` uses
`ON CONFLICT (key) DO UPDATE SET value = $2`. The later save silently replaces
the earlier payload. Concurrent callers make the collision reachable without
unusually fast sequential interaction.

The route still returns its own successful `savedPayload` at
`src/services/naturalLanguageMemory.ts:701-715`, so the first caller can be
told its value was saved even after the row is replaced. Conversation mirroring
at `src/services/naturalLanguageConversationSessionStore.ts:90-106` can also
treat the collided key as already mirrored, leaving canonical memory, RAG, and
session-catalog representations inconsistent.

Existing coverage at `tests/naturalLanguageMemory.session.test.ts:362-413` and
`:450-527` verifies ordinary structured saves and the intentional reuse of an
identical retry, but it does not exercise two different same-second saves or
concurrent key generation. This is a confirmed data-integrity defect, not just
a refactor preference.

The safest isolated repair is to add behavior-preserving characterization for
identical retries plus failing sequential and concurrent same-second
distinct-save tests under a frozen clock, then append collision-resistant
entropy while retaining the readable slug/timestamp and 255-character bound.
Preserve explicit-key semantics, session scoping, recall ordering, and the
intentional retry-deduplication contract. At that audit checkpoint, no
implementation was authorized.

### Revalidated residuals and repository-wide posture

The current evidence does **not** support calling ARCANOS repository-wide
spaghetti code. A read-only architecture pass on the merged tree reported that
the general, CEF-layer, and routing boundary checks passed, while the current
Madge gate found zero cycles across the 832 files it processed in the root
`src/` TypeScript graph. Three CLI package-export imports were skipped by Madge,
so this is not claimed as cycle coverage for every workspace. The source also
has substantive schema-first packages, protected control-plane composition,
and focused concurrency tests. The maintainability risk is instead
concentrated: a small number of oversized request and background-runtime
orchestrators own too many state transitions, and several adjacent subsystems
have duplicate or inconsistent policy/state owners.

The following prior or newly discovered residuals were rechecked against the
exact merged #1411 source tree:

| Priority | Revalidated finding | Current evidence and qualification |
| --- | --- | --- |
| P1 | Dual self-heal mitigation owners create a functional split-brain defect. | `src/app.ts:96-105` starts the self-improvement `controlLoop`, while `src/server.ts:322-336` starts the separate `selfHealingLoop`. The former applies private mitigation state at `src/services/selfImprove/controlLoop.ts:672-696`, but its exported consumer-facing getter at lines 1133-1157 has no source consumer. Trinity instead reads `getTrinitySelfHealingMitigation` at `src/core/logic/trinity.ts:823-837`; that state is owned by `src/services/selfImprove/selfHealingV2.ts:427-474` and activated by `src/services/selfImprove/selfHealingLoop.ts:3304-3403`. Therefore a `controlLoop` report that degraded or final-stage-bypass mitigation was applied need not affect Trinity. Characterize the actual effect first, then make one state owner authoritative without redesigning self-heal. |
| P1 | The served Custom GPT bridge OpenAPI contract is invalid or misleading for real clients. | `openapi/custom-gpt-bridge.yaml:16` still advertises `YOUR-RAILWAY-DOMAIN`; `BridgeRequest.action` is required at lines 196-197 even though `src/services/customGptBridgeService.ts:64-66` defaults omission to `query`; and the job-status/result operations at YAML lines 150-167 have no response schemas. `src/routes/introspection.ts:96-102` serves the file verbatim, while `tests/introspection-openapi-contract.route.test.ts:168-198` uses substring checks that cannot catch these semantic defects. This remains a small, isolated contract-and-test repair. |
| P2 | Durable session integration behavior is not continuously exercised in CI. | `tests/integration/session-system.integration.test.ts:39-46` skips its PostgreSQL suite unless ordinary `DATABASE_URL` is set. The integration job at `.github/workflows/ci-cd.yml:137-144` does not set it. The PostgreSQL job at lines 395-438 provides only the local-agent hardening, job-claim fencing, and DAG snapshot-generation database variables and scripts. Session save/get/list/replay and restart durability can therefore regress while authoritative CI remains green. |
| P2 | Daemon coordination state is process-local and restart-volatile. | `src/routes/daemonStore.ts:55-60` keeps heartbeats, queued commands, command results, token mappings, and pending confirmations in `Map` instances. Only the instance-to-partition/token mapping is loaded and saved at lines 62-135; heartbeats at 150-158, commands at 160-235, results at 238-259, and confirmations at 261-313 are neither shared across replicas nor recovered after restart. This is acceptable only under an explicit single-replica, loss-tolerant daemon contract; otherwise it blocks reliable horizontal scaling. |
| P2 | Confirmation capabilities and rate counters are also replica-local. | The confirmation challenge store is a process `Map` at `src/transport/http/middleware/confirmationChallengeStore.ts:61-63`, with issue/consume behavior at lines 140-216. One-time confirmation tokens use another `Map` at `src/lib/tokenStore.ts:34-94`, and the default request limiter uses per-process maps at `src/platform/runtime/security.ts:403-471`. In a multi-replica service, a challenge can be issued on one replica and rejected on another, while every replica grants another rate budget. Move these short-lived security primitives to an atomic shared store or enforce verified sticky/single-replica operation before horizontal scaling. |
| P2 | Implicit Trinity file memory is unbounded and synchronously rewrites its full index. | Successful Trinity paths persist prompt/output snippets at `src/core/logic/trinity.ts:988-993` and `:1498-1504`. `src/services/memory/store.ts:16-57` retains entries in an in-process array, and `src/services/memory/storage.ts:10-40` synchronously reads and rewrites the entire JSON file. `cleanupMemory` exists at `src/services/memory/maintenance.ts:54-76` but has no production scheduler. This creates event-loop/disk growth plus restart and replica divergence. The review rejected a stronger direct-secret-exfiltration claim: context retrieval remains exact-session scoped and public response shaping removes the internal memory context. |
| P2 / product boundary | The protected memory/session API is deployment-authenticated, not tenant-authorized. | The merged middleware correctly enforces one shared deployment credential, but `memory` and `sessions` have no owner or tenant columns at `src/core/db/schema.ts:227-235` and `:549-574`. Memory search can be global at `src/routes/api-memory.ts:359-398`, and session detail/replay accepts any valid session UUID at `src/routes/api-session-system.ts:304-391`. This is not a bypass of the new credential; it is a blocker to safely giving mutually untrusted tenants the same credential or scaling to tenant-specific principals. |
| P2 | Session and memory collection APIs still have boundedness/indexing gaps. | Session listing caps responses at 100 but has no cursor (`src/routes/api-session-system.ts:47-50`, `:304-321`); `src/core/db/repositories/sessionRepository.ts:482-527` selects full JSON payloads, performs a separate count, and uses multi-column substring search without matching search indexes. `POST /api/memory/bulk` accepts an unbounded operations array and executes it sequentially at `src/routes/api-memory.ts:751-798`. Add request cardinality/byte limits first, then cursor pagination and query/index evidence before increasing data or replica scale. |
| P1 / privacy boundary, superseded below | Generic GPT job reads treat possession of a job UUID as the capability, and later inspection found public endpoints that publish those UUIDs. | `src/routes/register.ts:155` mounts `src/routes/jobs.ts` without a caller-auth middleware. `GET /jobs/:id`, `/result`, and `/stream` at `src/routes/jobs.ts:141-241` and `:351-415` read any non-local-agent GPT job by UUID, while `src/shared/gpt/gptJobResult.ts:135-206` and `:249-267` return retained output. PostgreSQL-generated UUIDs (`src/core/db/schema.ts:300-308`) make blind enumeration impractical, but the later route-completeness pass found several public health/diagnostic projections that disclose current and failed job IDs. The P1 `SEC-PUBLIC-DIAGNOSTICS-001` entry below therefore replaces the earlier leaked-URL-only mitigation. |
| P2 | Several advertised maintenance commands and the audit workflow do not perform their stated job. | `package.json:8-9`, `:48-49`, `:66-76`, and `:83` reference absent database-init, schema-sync, tagged-guide, documentation-workflow, continuous-audit, Python-audit, and auto-sync targets. `.github/workflows/arcanos-audit-cycle.yml:25-40` only rewrites and attempts to commit an audit-cycle marker; it does not audit source. This is operational/documentation debt rather than evidence that the working build and test scripts are broken. |
| P2 / governance | The approval workflow can count a bot or GitHub App review as its claimed human approval. | `.github/workflows/require-approval.yml:38-52` accepts the latest `APPROVED` review from any login other than the author. It does not require `r.user.type === "User"` or exclude bot/App identities, yet line 57 describes the gate as human approval. Whether this is exploitable depends on which installed identities can submit an approving review, so fix it as a conditional policy gap rather than a demonstrated bypass. |
| Maintainability risk | Complexity is concentrated, not cyclic. | The main `gptRouter` handler beginning at `src/routes/gptRouter.ts:1223` spans about 2,148 lines and includes a roughly 1,900-line nested callback with more than 200 branches. `runThroughBrain` in `src/core/logic/trinity.ts` spans about 1,066 lines, and the worker-consumer slot in `src/workers/jobRunner.ts` spans about 735. These measurements establish refactor risk, not a behavior defect; extraction must proceed one characterized state transition at a time. |
| Low/P2 observability debt | The 100% Jest threshold is intentionally scoped, not repository-wide coverage. | `jest.config.js:95-98` applies the threshold only to `config/coverageScope.js`. That list currently names 94 files out of 808 TypeScript files under `src/` (about 11.6%). This is accurately implemented as an opt-in quality gate, but the percentage must not be interpreted as whole-repository coverage; expand ownership incrementally around the highest-risk paths. |
| Low/P2 dependency and reproducibility debt | Production dependencies are currently clean; development tooling and build inputs still drift. | The independent dependency pass reported zero findings from strict production npm audit and Python `pip-audit`, with no remaining waiver or ignore entry. The development-inclusive npm graph still has 16 high-severity records rooted in ESLint/Madge tooling transitive dependencies. Node also differs between `.nvmrc`/authoritative CI (`20.19.0`) and Docker (`20.18.1`), most Actions use floating major tags, and the Railway workflow installs an unpinned latest CLI. Treat these as tooling/supply-chain debt, not a production-package vulnerability waiver. |

The prior CLEAR recheck duplication, inconsistent boolean parsing, overdue
`/brain`/`Procfile`/worker-runtime decisions, and large cohesive
`gamingWebContext` module also remain valid lower-priority cleanup candidates.
They are deliberately kept below confirmed authentication, rate-limit,
data-integrity, CI-governance, workflow-credential, contract, and state-owner
defects.

### Adversarial validation and checkpoint ranking

An independent adversarial pass challenged the promoted findings against the
clean current-main tree rather than accepting the earlier ranking. It upheld
the core defects, narrowed their conditions, and found no currently proven P0.
In particular, it rejected current `OPENAI_API_KEY` exposure, direct
cross-session exfiltration through Trinity file memory, the claim that all
self-heal status is unconsumed, and a suspected new queue-claim race. It found
no new confirmed SQL-injection, SSRF-bypass, or raw-secret-logging defect in
the inspected paths.

| Rank | Current priority | Finding | Safest isolated next move |
| ---: | --- | --- | --- |
| 1 | P1 | Public provider ingress is under-protected: canonical `/gpt/:gptId` has no application admission limiter, while several paid routes let caller-selected session IDs replace the abuse budget. | Add one shared provider-ingress limiter and a deployment-wide ceiling without changing anonymous compatibility in the first slice; prove that rotating session metadata cannot reset it. |
| 2 | P1 | `main` requires only non-strict `docs:check`; authoritative CI, current-head status, conversation resolution, and administrator enforcement are not protected. | Apply the exact external `pbjustin/Arcanos`/`main` settings bundle described above, initially with zero approvals because only one human maintainer can approve. |
| 3 | P1 before memory rollout | Same-session, same-second natural-language saves with the same first eight normalized tokens can silently overwrite while both callers receive success. | Freeze time in focused sequential/concurrent tests, then add collision-resistant entropy without changing explicit keys or retry deduplication. |
| 4 | P1 conditional | The older self-heal control loop can report a mitigation applied while Trinity reads a separate mitigation owner. | Add an effect-level characterization test, then make one existing owner authoritative or retire the disconnected actuator. |
| 5 | P1 contract defect | The served Custom GPT bridge OpenAPI document has a placeholder server, contradicts the runtime's default action, and omits polling response schemas. | Repair only the YAML and replace substring assertions with parsed, locally resolved contract tests. |
| 6 | P2 current / P1 latent | Two active manual workflows execute caller-selected code with a persisted write-scoped checkout credential; provider-secret exposure is latent, not current. | Fail-close or retire them, or validate an immutable main-reachable SHA before candidate code; remove unused secret scope and persisted credentials. |
| 7 | P2 dormant integrity defect | `arcanos-deploy.yml` simulates deployment but can report and comment `Deployed successfully`; it has never run. | Retire the redundant workflow or rename every output to deployment-readiness simulation. |
| 8 | P2 scale/security architecture | Daemon state, confirmation capabilities, one-time tokens, rate counters, and implicit Trinity file memory are process-local; some are unbounded or synchronously persisted. | Establish explicit single-replica constraints now, then migrate one security/coordination primitive at a time to an atomic shared store before scaling. |
| 9 | P2 test/operations debt | The durable session suite is skipped in CI; advertised maintenance/audit commands are missing; scoped 100% coverage reaches only 94 of 808 `src` TypeScript files. | Wire the existing PostgreSQL service into the session suite, remove or restore misleading scripts, and expand coverage ownership around the ranked risk paths. |
| 10 | P2 product/data boundary, superseded in part below | Memory/session storage has no tenant owner, bulk cardinality is unbounded, and session pagination has no cursor. The earlier generic-job bearer-capability wording was later promoted to P1 after public job-ID disclosures were found. | Resolve intended single-tenant versus multi-tenant contracts before schema/auth changes; independently add safe request bounds. Follow the superseding P1 job-locator sequence below for generic job reads. |
| 11 | P2 maintainability | Large orchestrators, triplicated CLEAR builders, boolean-parser drift, and overdue compatibility decisions concentrate change risk without forming dependency cycles. | Take only one behavior-preserving, already characterized extraction or pure-helper consolidation per authorization. |

The continuation's focused security pass ran 20 Jest suites with 220 tests
passing. Those tests ran under local Node `24.13.0`, not the authoritative
Node `20.19.0`; the terminal post-merge CI evidence above remains the
Node-parity signal. The architecture pass separately reported passing boundary
checks and zero Madge cycles. At that checkpoint, the maintained documentation
audit passed all 291 checks with zero warnings, and a report-specific evidence
check resolved all 77 then-present explicit `path:line` references within their
current files. A final, larger reference and documentation pass is recorded
below. No live provider, production, database migration, or Railway environment
was invoked during these residual passes.

### Route, configuration, and test completeness pass — 2026-07-29

This is a live audit checkpoint on the clean current-main source worktree at
`7252172181962148bb0cb192d2398c366a4541b7`, whose source tree matches the
post-merge `origin/main` tree captured above. The findings below supersede the
corresponding narrower entries in the preceding ranking. They were established
from source, focused tests, executable configuration, and CI definitions; no
live HTTP request, provider call, database operation, Railway mutation, or
production action was used.

#### P1 / SEC-CONTROL-INGRESS-002 — Public compatibility routes bypass protected control-plane and persistence boundaries

Five independently reachable route families perform paid, persistent, or
synchronous filesystem work without establishing caller identity:

- `POST /dispatch` is mounted at `src/routes/register.ts:148` and receives the
  broad application JSON parser at `src/app.ts:256`. A caller can select
  `target: "dag"`, a DAG action, DAG execution mode, or a high-confidence
  auto-classification path at `src/routes/dispatch.ts:272-378`; the handler
  directly calls `arcanosDagRunService.createRun` at lines 226-234. The service
  persists an initial run and launches background execution at
  `src/services/arcanosDagRunService.ts:2497-2516` and `:2623-2650`.
  `tests/dispatcher-priority.route.test.ts:67-73` mounts no authentication
  middleware, and lines 234-255 explicitly prove that the anonymous-style
  request creates a run and returns `202`. This is an alternate admission path
  around the canonical `/api/arcanos/dag` boundary, which authenticates,
  requires an operator and operation scope, and applies client and principal
  rate limits at `src/services/controlPlane/dagHttpBoundary.ts:163-225`.
  The internal default four-active-run reservation at
  `src/services/arcanosDagRunService.ts:170` and `:1523-1533` limits concurrent
  damage but does not establish authority and lets an anonymous caller occupy
  every scarce run slot.
- `POST /status` is mounted with the public health group at
  `src/routes/register.ts:144`. It accepts any non-empty JSON object and calls
  `updateState` after only the ordinary `confirmGate` at
  `src/routes/status.ts:147-163`. Manual `x-confirmed: yes` is approval, not
  authentication (`src/transport/http/middleware/confirmGate.ts:165-196` and
  `:261-270`), and `tests/status.route.test.ts:96-123` proves that this header
  alone reaches the mutation. `src/services/stateManager.ts:10-17` permits
  arbitrary state keys, while lines 47-58 merge and synchronously rewrite
  `systemState.json`. Daily-summary prompt construction consumes that state at
  `src/services/dailySummaryService.ts:51-62` and `:78-108`, but no production
  scheduler was found; the operation is reached through the protected
  `/devops/daily-summary` route or a CLI entry point. GPT-sync also places the
  file in model context at `src/services/stateManager.ts:95-104` and
  `src/services/gptSync.ts:33-48`, but repository-wide source inspection found
  no caller of that service. Shared-state integrity, event-loop blocking, and
  disk-write effects are direct; downstream model-context contamination is
  indirect and trigger-dependent, with GPT-sync currently appearing dormant.
- `POST /heartbeat` uses the same bare confirmation boundary at
  `src/routes/heartbeat.ts:43-55`. Lines 23-40 synchronously create the log
  directory and append the caller-controlled payload to `logs/heartbeat.log`.
  The route has no route-specific body cap or admission limiter, so it inherits
  the default `10mb` parser configured at `src/platform/runtime/config.ts:64-67`
  and applied at `src/app.ts:256`. Repeated anonymous confirmed requests can
  block the event loop and consume the instance filesystem. `docs/API.md:169-171`
  documents both legacy writes as confirmation-only, and no focused heartbeat
  route test was found.
- `/backstage/*` is mounted at `src/routes/register.ts:170` with no preceding
  identity boundary. Its five POST handlers use only ordinary confirmation at
  `src/routes/backstage.ts:20-78`. The underlying service inserts events,
  performs one upsert per caller-supplied roster item, writes story beats and
  memory snapshots, calls the provider, and saves generated storylines at
  `src/services/backstage-booker.ts:503-675`. In particular,
  `POST /backstage/update-roster` accepts an unchecked array and fans it out
  through `Promise.all` database upserts at lines 522-550, while
  `/backstage/book-gpt` both invokes provider work and persists its result.
- `POST /commands/research` is mounted at `src/routes/research.ts:3-6` and uses
  only ordinary confirmation plus shallow validation at
  `src/routes/_core/researchRoute.ts:9-21` and `:55-80`. `topic` is bounded, but
  `urls` has no item-count or item-length bound. Every retained URL can trigger
  an outbound fetch and provider summary before synthesis, an optional audit,
  and persistent memory/source writes at `src/services/research.ts:232-365`.
  This is request-to-work amplification, not an SSRF finding:
  `src/shared/webFetcher.ts:305-327`, `:349-393`, `:633-653`, `:694-743`, and
  `:760-790` enforce scheme, credential, internal-address, DNS, redirect, proxy,
  timeout, and byte safeguards.

**Impact:** public compatibility behavior is not merely missing a preferred
authentication style. It creates alternate paths around newer, purpose-bound
control-plane composition and permits anonymous callers to consume DAG/provider
capacity, mutate shared database or memory state, poison persisted runtime
context, and drive synchronous disk writes. Exact exploitability still depends
on network reachability and deployment-edge controls not represented in this
repository; those controls were not assumed absent or present.

**Safest isolated sequence:** first close the `/dispatch` DAG bypass while
preserving its GPT branch. The existing `dagHttpBoundary` cannot simply be
mounted on `/dispatch`: it recognizes only `/api/arcanos/dag/*` path shapes and
would authenticate or reject the GPT branch. The implementation must either
apply purpose-equivalent operator, `mcp:invoke`, client/principal-limit, and
`no-store` controls to all four parsed-body DAG selections, or explicitly retire
the compatibility lane and direct clients to `/api/arcanos/dag/runs`. Second,
retire or protect `POST /status` and `/heartbeat` with narrow pre-parser bounds
and the existing operator boundary. Third, decide whether `/backstage/*` is a
public product surface, then separate read/generation behavior from persistent
mutations and add operation-specific validation. Harden `/commands/research`
cardinality as its own small route-local slice rather than coupling it to a
cross-route limiter. Fixed filesystem destinations and an ephemeral Railway
filesystem limit some persistence effects but do not establish authority. Each
slice needs focused anonymous-denial and authorized-success tests plus unchanged
GPT-compatibility characterization.

#### P1 / SEC-PROVIDER-INGRESS-002 — The unbudgeted provider surface is broader than the canonical GPT route

The earlier provider-ingress finding remains valid but was incomplete.
Credential-free provider work also includes:

- `POST /api/openai/prompt`, mounted at `src/routes/api/index.ts:92` and defined
  without route authentication or admission middleware at
  `src/routes/openai.ts:6-7`;
- `POST /arcanos-pipeline` at
  `src/routes/openai-arcanos-pipeline.ts:9-36`, which performs four sequential
  Trinity/provider stages and can add a fallback stage at
  `src/services/arcanosPipeline.ts:75-148`;
- `POST /api/reusables` at `src/routes/api-reusable-code.ts:55-82`, which calls
  provider generation and can add a repair call at
  `src/services/reusableCodeGeneration.ts:249-318`;
- `/dispatch` GPT fallback, `/siri`, and `/backstage/book-gpt`, all of which
  rely on compatibility semantics rather than a shared ingress budget;
- `/commands/research`, which can fan one array with no route-level item-count
  bound into one fetch and provider summary per URL plus synthesis, optional
  audit, and durable writes;
- default-enabled legacy aliases `/arcanos`, `/write`, `/guide`, and `/sim`,
  plus dynamic `/modules/:route` and `/queryroute`, which call
  `routeGptRequest` directly rather than re-entering `/gpt` middleware
  (`src/platform/runtime/legacyRouteMode.ts:5-21`,
  `src/routes/arcanos.ts:15-25`, `src/routes/ai-endpoints.ts:25-70`,
  `src/routes/modules.ts:46-109` and `:143-196`, and
  `src/routes/_core/legacyGptCompat.ts:29-64`); and
- `/api/vision`, `/api/transcribe`, and `/image`, which do have process-local
  route limiters but still have no deployment-wide ceiling
  (`src/routes/api-vision.ts:17-18`,
  `src/routes/api-transcribe.ts:16-17`, and `src/routes/image.ts:8-20`).

The strongest demonstrated amplification is the unauthenticated
`/arcanos-pipeline`: one accepted request ordinarily produces four sequential
provider stages. This completeness pass therefore broadens rank 1 from
canonical `/gpt/:gptId` plus caller-selected session-key bypasses to a
repository-wide provider-admission defect. The first behavior-preserving slice
should still be a shared ingress-derived budget and deployment-wide ceiling
that cannot be reset by rotating caller metadata; authentication/product
contract changes should remain separate decisions.

`/commands/research` additionally needs a small URL count, per-URL length, and
aggregate work budget as a separate route-local input-hardening slice. The
shared provider budget is a distinct cross-route concern, and it must cover the
internal compatibility-dispatch seam or every alias; mounting it only on
`/gpt` would be bypassable. Provider timeouts, circuit breaking, response
bounds, and existing process-local media limits cap parts of an individual
request but do not establish caller authority or a deployment-wide budget.
Setting `LEGACY_GPT_ROUTES=disabled` and keeping the separate legacy `/brain`
switch at its default `ASK_ROUTE_MODE=gone` are immediate deployment
mitigations, but changing a Railway variable remains a separately authorized
external action. Preserve the existing URL-fetch hardening.

#### P1 / SEC-PUBLIC-DIAGNOSTICS-001 — Public status projections publish job locators and recent user/model content

The earlier conclusion that generic job reads were protected by impractical UUID
enumeration is no longer supportable. Multiple unauthenticated projections
publish reusable locators:

- `GET /api/diagnostics/queues` returns `lastJobId` through
  `src/routes/api-session-system.ts:211-220`,
  `src/services/sessionApiSchemas.ts:38-89`, and
  `src/services/sessionSystemDiagnosticsService.ts:123-177`.
- `GET /worker-helper/status`, `/worker-helper/health`, and
  `/worker-helper/jobs/failed` are public at
  `src/routes/worker-helper.ts:96-154` and `:195-230`. Their projections retain
  latest and failed job IDs at `src/services/workerControlService.ts:434-469`,
  `:993-1030`, and `:1147-1168`; worker snapshots also retain `activeJobs` and
  `currentJobId` at lines 152-165 and 727-751. The failed-job query can return up to 100
  non-local-agent IDs (`src/core/db/repositories/jobRepository.ts:3040-3086`).
  `tests/worker-helper-route.test.ts:890-913` explicitly preserves anonymous
  access to a failed ID.
- Public `GET /trinity/status` republishes recent failed-job snapshots at
  `src/routes/trinity.ts:24-31` and
  `src/services/trinityStatusService.ts:340-404`.

Any retained non-local-agent ID can then be supplied to unauthenticated
`GET /jobs/:id`, `/result`, or `/stream` at `src/routes/jobs.ts:141-241` and
`:351-415`. Completed, failed, and expired projections return retained
`job.output`, and failures can return raw `job.error_message`, at
`src/shared/gpt/gptJobResult.ts:135-209` and `:248-268`. Local-agent jobs are
correctly excluded, and public helper summaries redact credential-shaped
errors, but the generic read path makes the disclosed ID sufficient to recover
ordinary prompt-derived output. `/api/diagnostics/queues` already sets
`no-store`, and generic job JSON is capped at 32 KiB by
`src/shared/http/clientResponseCommon.ts:3-8` and `:108-111`; those are useful
response mitigations but do not repair the confidentiality chain. The generic
JSON helper itself does not set `no-store`, and the SSE route uses `no-cache`
rather than `no-store`.

A second conditional disclosure exists in the same status family.
`GET /workers/status` publicly embeds the full in-process worker runtime and an
absolute directory at `src/routes/workers.ts:80-128`. Runtime bookkeeping
retains a 120-character caller-input preview and the complete most-recent
Trinity result/error at `src/platform/runtime/workerConfig.ts:48-60` and
`:544-605`; `/worker-helper/status` republishes it. The shared redactor at
`packages/arcanos-runtime/src/redaction.ts:46-104` removes known credential
patterns and sensitive keys but intentionally preserves ordinary prompt and
model-output text. Railway web roles commonly disable in-process workers, so
these fields may be empty in a particular deployment; source does not guarantee
that state, and other runtime modes populate them.

**Impact:** anonymous callers can obtain current or recent job locators and use
them to read retained model output and raw failure text; when in-process work
has run, public status can directly expose recent input and full model output.
External gateway controls remain unknown and were not assumed present or
absent.

**Safest isolated sequence:** first remove all reusable job IDs, active-job
locators, caller previews, results, errors, and absolute paths from public
health/status projections, protect `/worker-helper/jobs/failed`, and add
`no-store`. Preserve detailed operator visibility behind the existing
`/gpt-access/workers/status` `workers.read` boundary at
`src/routes/gpt-access.ts:1129-1140` and `:1200-1213`. In a separate product
decision, bind generic job reads to a principal or issue a cryptographic read
capability; do not combine that compatibility change with the projection fix.

#### P2 / SEC-DIAGNOSTICS-002 — Public verbose diagnostics expose more operational detail than health clients need

`GET /api/openai/status` is public through `src/routes/openai.ts:6-7` and
`src/routes/api/index.ts:92`. Its controller returns exact model identifiers,
credential configured/source state, client timeout and configured base URL,
circuit/cache state, confirmation configuration, trusted GPT IDs, token prefix
and TTL, automation-bypass header name, and Railway environment at
`src/transport/http/controllers/openaiController.ts:400-428` and
`src/transport/http/middleware/confirmGate.ts:368-379`.

Public `/health` returns full dependency check objects and can surface stored
database connection error text through `src/routes/health.ts:47-56`,
`src/platform/resilience/unifiedHealth.ts:357-378`, `:507-545`, and `:667-679`,
and `src/core/db/client.ts:362-367`. Neither route explicitly sets `no-store`.
Public Backstage POST failures and `/trinity/status` can also reflect raw
unexpected error text at `src/routes/backstage.ts:21-78`,
`src/shared/http/errors.ts:49-51`, and `src/routes/trinity.ts:34-44`.

No credential value was proven exposed, so this remains P2 rather than P1.
Trusted-ID and automation-header metadata also appears intentionally in ordinary
confirmation challenge responses at
`src/transport/http/middleware/confirmGate.ts:296-333`; changing only the OpenAI
status projection would not make it private. First decide which confirmation
metadata is a supported public challenge contract. Keep public health to fixed
codes/booleans, move verbose diagnostics behind an existing operator-read
scope, replace raw dependency/route errors with fixed public codes, sanitize
configured URLs, and add `no-store`.

#### P2 current / P1 when defaults are relied upon / CFG-ENV-MUTATION-001 — Startup validation mutates configuration and changes later runtime behavior

`validateEnvironment()` is not observational. Seven optional checks define
defaults at `src/platform/runtime/environmentValidation.ts:107-120`,
`:178-200`, and `:224-242`, and lines 353-370 write absent defaults into
`process.env`: `NODE_ENV=development`, `PORT=8080`, `AI_MODEL=gpt-4o`,
`RAILWAY_ENVIRONMENT=production`, `RUN_WORKERS=true`,
`ARC_LOG_PATH=/tmp/arc/log`, and `WORKER_API_TIMEOUT_MS=60000`. Normal preflight
invokes it through `createStartupReport()` and then directly at
`src/core/startup.ts:35-38`; the nested call is at
`src/platform/runtime/environmentValidation.ts:517-521`.

This creates concrete cross-consumer drift:

- the listener resolves the absent port as local `3000` before preflight at
  `src/server.ts:291-304`, while later internal base-URL resolution reads the
  injected `PORT=8080` at `src/platform/runtime/env.ts:265-292`;
- the synthetic Railway marker makes
  `src/platform/runtime/unifiedConfig.ts:229-235` report Railway and changes the
  unset DAG artifact backend from filesystem to database at
  `src/dag/artifactStore.ts:76-91`, contrary to
  `.env.example:313-315` and `:413-419`;
- injected `AI_MODEL=gpt-4o` outranks both the documented final
  `gpt-4.1-mini` fallback and the active template's
  `OPENAI_MODEL=gpt-4o-mini` at `docs/CONFIGURATION.md:182-188`,
  `.env.example:17-20`, and
  `src/platform/runtime/unifiedConfig.ts:329-334`; and
- the injected 60-second worker timeout overrides the documented unified
  30-second default at `docs/CONFIGURATION.md:41`.

A fresh isolated child process using the current built server import graph
confirmed `AI_MODEL=gpt-4o`, `RAILWAY_ENVIRONMENT=production`, `PORT=8080`,
`WORKER_API_TIMEOUT_MS=60000`, default model `gpt-4o`, Railway detection,
bridge-enabled reporting, database artifact selection, and internal base URL
`http://127.0.0.1:8080/`. A separate repeat-validation proof changed from valid
with no OpenAI requirement to invalid after the injected Railway marker made
the second pass require a key
(`src/platform/runtime/environmentValidation.ts:269-285`). No network or
external dependency was used. Existing tests explicitly expect isolated
mutation at `tests/environment-validation.test.ts:98-106` and
`tests/openai-integration.test.ts:312-330`, but no fresh-process startup
composition test catches its consequences.

The pre-resolved listener remains bound to its correct local host/port, and the
`NODE_ENV`, local worker, and log-path defaults mostly match intended local
behavior; those mitigations do not repair the split configuration. The safest
isolated correction is to make validation side-effect free, centralize
canonical defaults, and add a fresh-process repeated-preflight test covering
listener/internal URL agreement, platform identity, model precedence, worker
timeout, bridge reporting, and artifact backend.

#### P2 current / P1 when enabled / CFG-GPT-ACCESS-001 — The documented worker-recovery scope can fail production startup

`src/services/gptAccessScopes.ts:1-14` defines `workers.recover` as a recognized
GPT Access scope, the gateway implements it, and
`docs/CONFIGURATION.md:36`, `:422`, and `:577` instruct operators to add it for
confirmed worker recovery. Startup maintains a second allowlist at
`src/platform/runtime/environmentValidation.ts:29-41` that omits
`workers.recover`; its validator rejects any omitted value at lines 96-102.
Production requires `ARCANOS_GPT_ACCESS_SCOPES` at lines 287-307, and
`src/core/startup.ts:37-44` aborts startup when validation fails.

This is a concrete code/config drift defect: following the maintained recovery
instructions can prevent the web process from starting. It also makes the
gateway's unset-scope default at
`src/services/gptAccessGateway.ts:612-639` unreachable in normal production,
despite the documented unset behavior. The smallest repair is to import one
canonical scope list into validation and add a production-preflight test for
every runtime-recognized scope; then align the docs on whether production
requires an explicit list or actually permits defaults.

#### P2 / CFG-INERT-AUTH-001 — The active environment template advertises authentication controls with no executable consumer

`.env.example:432-440` advertises `AGENT_AUTH_MODE` and
`BACKEND_TRUSTED_GPT_IDS`, but repository-wide source inspection found no
runtime consumer. `src/routes/gptRouter.ts:1078-1110` classifies the presence of
headers/cookies as request metadata; it does not implement either advertised
policy. These inert variables can create false confidence that GPT-route caller
authentication is enabled. Remove them from the active template until a
verified boundary exists, or implement the intended policy as a separately
authorized contract change with denial/success tests. Lower-priority stale
controls also include `ARCANOS_OWNER_EMAIL(S)`, two `ADMIN_DB_*` limits, and the
ineffective debug-GPT toggle; the shared legacy-route `Sunset` date expired
2026-07-01 while legacy routes remain enabled by default. These P3 cleanup items
should not be bundled with authentication work.

#### P2 conditional / SEC-CONFIRM-002 — An undocumented global switch can disable ordinary confirmation

`src/transport/http/middleware/confirmGate.ts:85-104` treats either
`TRUSTED_GPT_IDS=*` or `ALLOW_ALL_GPTS=true` as allow-all mode, and lines
188-193 plus 261-270 approve every ordinary `confirmGate` request without a
confirmation header. `docs/CONFIGURATION.md:201` says trusted membership alone
never bypasses confirmation, while `.env.example:431-436` documents the same
presence-token expectation. Neither location documents `ALLOW_ALL_GPTS`, and
`SECURITY.md:53` tells responders to review trusted IDs and the automation
secret but not the allow-all switch.

This does not bypass the newer `requireChallengeToken: true` control-plane
routes, and the audit has not established that the switch or wildcard is
currently configured in any deployment. It is nevertheless a high-impact
latent safety/configuration hazard. It does not add authority to the anonymous
legacy routes because any caller can already self-assert `x-confirmed: yes`;
on authenticated routes it removes a human-consent step without bypassing
authentication. The safest isolated correction is to remove
allow-all from production semantics or fail closed outside explicit local/test
mode, document the behavior, and add tests proving challenge-only routes remain
unaffected.

#### P2 / TEST-REALITY-001 — Several green tests do not exercise the behavior named by the suite

`tests/api-vision.test.ts:3-14`,
`tests/api-transcribe.test.ts:3-14`, and
`tests/api-update.test.ts:3-14` construct `createApp()` but never give that app
to Supertest or a listener. Their 14 tests call global `fetch`, while
`installMockFetch` supplies hand-written route behavior inside each test file.
They therefore verify their own mock handlers rather than Express routing,
middleware order, validation, provider adapter calls, or response behavior.
The actual request assertions are at `tests/api-vision.test.ts:43-104`,
`tests/api-transcribe.test.ts:41-115`, and
`tests/api-update.test.ts:41-101`; the real routers are at
`src/routes/api-vision.ts:75-130`, `src/routes/api-transcribe.ts:58-106`, and
`src/routes/api-update.ts:32-96`. The real canonical `/api/update` success path
does have separate composition coverage at
`tests/api-daemon-auth-composition.test.ts:195-209`; Vision and transcription
still lack real route coverage. No focused `/image` route test was found, and
`/api/ask-hrc` has service-only coverage at `tests/hrc.test.ts:23-44`. This is
directly relevant to the provider-ingress review because two of the falsely
covered routes perform live provider work.

Additional high-risk suites and checks fall into three categories:

- both ActionPlan PostgreSQL migration suites skip unless special variables are
  set (`tests/integration/action-plan-execution-migration.integration.test.ts:10`
  and `:39-57`; `tests/integration/action-plan-execution-migration.pg18.integration.test.ts:7-11`);
  the general integration job sets no database URL at
  `.github/workflows/ci-cd.yml:137-144`, and the PostgreSQL job at lines
  395-438 sets variables only for local-agent, job-claim, and DAG snapshot
  tests; and
- `tests/job-runner-runtime.test.ts:482-515` asserts critical worker
  cancellation ordering through line-ending-sensitive source substrings rather
  than executing the lifecycle. Its newline assertions at lines 504-505 fail
  on this Windows CRLF checkout, while Linux CI can pass without proving the
  behavior; CI starts the web process, not the root worker lifecycle.
- `tests/gate-r1-projector-session.test.js:23` and `:399` plus
  `tests/gate-r2-projector-session.test.js:25` and `:439` skip their real
  process-session checks except on Windows. Root Node CI runs on Ubuntu, and
  the Windows job runs Python only. Both suites passed locally (57 tests), but
  under Node `24.13.0`, not authoritative Node `20.19.0`.

Replace one self-mocking HTTP suite at a time with Supertest against the real
router mounted on an isolated Express app, mocking only the provider seam; start
with Vision, then handle transcription, image, HRC, and redundant Update
coverage separately. Do not inject `DATABASE_URL` into the broad 554-suite CI
leg. The two ActionPlan suites require separately disposable databases named
`arcanos_phase2e_*`, the PG18 suite additionally requires
`ACTION_PLAN_EXECUTION_PG18_INTEGRATION=1`, and the durable-session suite writes
the full application schema and a worker heartbeat. Run focused exact-path,
serial commands against separate databases or dedicated matrix jobs, then wire
those jobs into `All Checks Complete`. Replace worker source-text assertions one
invariant at a time with executable characterization.

This gap should not be generalized into a weak-test-suite claim. Jest discovery
found 554 suites, including 12 integration-pattern suites; no Jest/Node
`.only`/`.todo` or pytest `xfail` markers were found; conditional skips do exist.
Authoritative CI runs the full root Jest suite and full daemon pytest on
Windows; Linux runs two focused sandbox suites rather than full daemon pytest.
It also runs real PostgreSQL local-agent/claim/DAG tests and standalone
runtime/Redis admission tests. The job named `unit` invokes `npm test` across
all 554 suites, while the integration leg repeats the 12 filename-matched
integration suites; this is redundancy/mislabeling, not an omitted root suite.

The focused critical-path batch covered 11 suites and 121 tests: 10 suites were
fully green with 91 tests, while `job-runner-runtime` had 29 passing assertions
and one CRLF-sensitive failure, for 120 passing and one failing overall. All 14
self-mocking API tests were green, conditional database execution produced 22
passing and 30 skipped tests, and 57 Windows projector tests passed. Coverage
percentages were not treated as behavior evidence: the configured threshold
covers 94 unique existing files out of 808 `src` TypeScript files. The 19
sampled risk files outside that list were `gptRouter`, `jobRunner`, `trinity`,
`controlLoop`, `selfHealingV2`, `selfHealingLoop`, runtime `security`,
`naturalLanguageMemory`, `dispatch`, `arcanosDagRunService`, `jobs`,
`gptJobResult`, `worker-helper`, `workerControlService`,
`environmentValidation`, `status`, `heartbeat`, `backstage`, and `research`.

#### Updated repository-health verdicts

This table supersedes the narrower 2026-07-29 judgment at
“Historical pre-#1411 repository-health judgment” above.

| Dimension | Evidence-based current verdict |
| --- | --- |
| Maintainability | **Qualified, not clean.** Executable package/protocol/CEF boundaries, zero cycles in the current root-`src` Madge graph, and broad tests make the repository generally navigable. Madge skipped three CLI package-export imports, so cross-workspace cycle freedom is not proven. A few very large orchestrators, duplicated policy/default catalogs, source-text tests, inert controls, and split configuration ownership make high-risk changes expensive. |
| Scalability | **Unproven at measured scale.** Database-backed queue and DAG mechanisms are solid foundations, but no tracked load/stress/benchmark harness or CI job establishes throughput, latency, resource ceilings, multi-replica behavior, failover, or partition tolerance. Process-local security/admission state, provider work without a shared ceiling, missing explicit research/bulk cardinality limits, synchronous file state, pagination/retention gaps, and incomplete worker-lifecycle execution evidence block a confident horizontal- or tenant-scale verdict. |
| Security | **Not currently demonstrably secure at the repository boundary.** Newer canonical memory, DAG, CEF, operator, and GPT Access boundaries are substantive, but P1 compatibility aliases still admit anonymous paid/persistent work, public projections publish reusable job locators and recent content, provider ingress lacks a shared abuse ceiling, and ordinary confirmation has a latent global bypass. Deployment-edge controls were not inspected and cannot be credited or assumed absent. |
| Testing | **Broad but not uniformly trustworthy.** Authoritative CI covers root Jest, full Windows daemon pytest, focused Linux sandbox tests, PostgreSQL, runtime, and Redis paths. No `.only`, `.todo`, or pytest `xfail` marker was found, but conditional skips remain. Three green HTTP suites test their own mocks, important ActionPlan/session database suites skip in CI, the root worker lifecycle is not executed end to end, and Windows-only Node behavior lacks Node 20 CI parity. |
| Documentation | **Structurally strong, semantically incomplete.** Maintained/generated documentation checks and core build/deploy descriptions align well, but they miss the mutable environment validator, duplicated scope catalog, inert authentication variables, confirmation bypass, expired legacy sunset, and the previously confirmed served-OpenAPI defect. |
| Spaghetti-code assessment | **No repository-wide spaghetti-code finding, but not completely free of localized spaghetti risk.** The main GPT router, Trinity orchestration, and root worker lifecycle are oversized state machines; extraction should remain characterization-led and one seam at a time. |

#### 2026-07-29 ranking, superseded by the post-#1412 continuation

| Rank | Current priority | Finding | Safest isolated next move |
| ---: | --- | --- | --- |
| 1 | P1 | Public compatibility routes admit anonymous DAG execution, shared-state/database writes, synchronous filesystem writes, and unbounded research amplification; newer canonical boundaries do not cover the aliases. | Characterize all four `/dispatch` DAG selectors, then either reject/redirect the compatibility DAG lane to the canonical endpoint or add a purpose-built equivalent boundary; handle status/heartbeat, research bounds, and Backstage as separate follow-up slices. |
| 2 | P1 | Public diagnostic/status projections publish reusable job IDs and can expose retained job output, raw failure text, recent prompts, and full model results. | Remove sensitive fields and locators from public projections, protect failed-job listing, preserve detailed scoped diagnostics, and add `no-store`; decide principal/capability binding separately. |
| 3 | P1 | Provider ingress has no shared abuse budget or deployment-wide ceiling across `/gpt`, OpenAI compatibility routes, multi-stage pipeline, code generation, research, media, Siri, dispatch, and Backstage. | Add one ingress-derived shared budget/ceiling without changing anonymous product compatibility in the first slice; add explicit research cardinality/work bounds. |
| 4 | P1 governance | `main` requires only non-strict `docs:check`; authoritative CI, current-head status, conversation resolution, and administrator enforcement are not protected. | Apply the already specified external settings bundle with zero required approvals for the single-human-maintainer topology. |
| 5 | P2 current / P1 before multi-writer memory rollout | Same-session, same-second natural-language saves can overwrite distinct data. | Add frozen-clock sequential/concurrent characterization, then collision-resistant entropy while preserving explicit keys and retry deduplication. |
| 6 | P1 conditional | The older self-heal loop can report mitigation that Trinity never consumes. | Add an effect-level characterization and make one existing mitigation owner authoritative. |
| 7 | P1 contract defect | The served Custom GPT bridge OpenAPI document is semantically invalid or misleading. | Repair only the YAML and parsed contract tests. |
| 8 | P2 current / P1 when defaults are relied upon | Environment validation writes defaults into `process.env`, can synthesize Railway identity, overrides model/timeout choices, splits listener and internal URLs, and can make its second pass fail. | Make validation observational, centralize defaults, and add a fresh-process repeated-preflight composition test. |
| 9 | P2 current / P1 when enabled | The documented `workers.recover` scope is rejected by production startup validation. | Make the runtime scope catalog the single validation owner and add production-preflight coverage. |
| 10 | P2 current / P1 latent | Manual workflows execute caller-selected refs with persisted write credentials. | Validate an immutable main-reachable SHA, or fail-close/retire the workflows and remove excess credentials. |
| 11 | P2 conditional | Ordinary confirmation can be globally disabled by an undocumented switch or wildcard; this removes approval, not authentication. | Fail closed outside explicit local/test mode and prove challenge-only routes remain unaffected. |
| 12 | P2 test/config/operations debt | Some green HTTP suites test only local mocks; database suites are skipped in CI; worker tests are source-text/line-ending sensitive; template controls can be inert. | Convert one highest-risk suite at a time to executable characterization, use separate disposable databases for skipped suites, and remove misleading config independently. |
| 13 | P2 scale/data/maintainability | Process-local security/coordination state, tenant and collection bounds, oversized orchestrators, verbose public diagnostics, and misleading maintenance scripts remain. | Preserve the previously ranked isolated sequence; do not combine these concerns with ingress remediation. |

Risk rank and executable order are deliberately separate. The rank-1
`/dispatch` fix needs a dispatch-aware adapter because
`dagHttpBoundary` recognizes only canonical DAG paths. Before changing behavior,
characterize all four DAG-selection paths (`target`, action, execution mode, and
automatic classification), explicit-GPT precedence, anonymous denial, an
authorized `202`, and the invariant that denial never calls `createRun`. The
compatibility-preserving option is to keep GPT dispatch public while applying
purpose-equivalent control-plane operator, `mcp:invoke`, client/principal-rate,
bounded-body, and `no-store` controls only to the resolved DAG lane. Rejecting
or redirecting every DAG selection to `/api/arcanos/dag/runs` is the simpler,
safer contract if compatibility is not required, but that is a product decision.

The recommended first executable production-code slice is therefore the
rank-2 public worker-diagnostics projection containment. It is a smaller,
deterministic P1 correction that breaks a demonstrated locator-to-result
confidentiality chain without requiring the `/dispatch` compatibility decision:

1. introduce one allowlist-based public worker-health projection that retains
   only aggregate health, counts, normalized states, and timestamps;
2. remove `latestJob`, `recentFailedJobs`, `activeJobs`, `currentJobId`,
   `lastError`, `workerIds`, `lastInputPreview`, `lastResult`, and the absolute
   `workersDirectory` from `/worker-helper/status`, `/worker-helper/health`,
   `/workers/status`, and `/trinity/status`;
3. protect `/worker-helper/jobs/failed` with the existing privileged worker
   authentication boundary while preserving full operator detail through
   `/gpt-access/workers/status`;
4. add `no-store` to affected JSON responses and to the job SSE response,
   without changing `/api/diagnostics/queues`, which already sets `no-store`;
5. test public serialized responses against known UUID, prompt, result, error,
   and absolute-path sentinels, and prove the authenticated operator projection
   retains its intended detail.

Keep principal binding or cryptographic capabilities for generic `/jobs/*`
reads as a separate product-contract slice. The focused verification set should
cover the worker-helper route/auth suites, worker route-security suite, Trinity
status service, session-system diagnostics service, session integration, and
jobs route before `type-check` and `lint`. It needs no live provider, database,
Railway, or production operation.

The lowest-risk green implementation, if a later thread should make no
production behavior change yet, is to rewrite only
`tests/api-vision.test.ts`: mount the real Vision router on an isolated Express
app, use Supertest, mock only `getOpenAIClientOrAdapter`, and prove validation,
oversized input, provider-unavailable, success, mounted limiter/headers, and
provider-failure behavior. That test-only slice improves the evidence base but
does not mitigate the higher-ranked runtime findings.

### Final pre-implementation handoff review — 2026-07-29

At `2026-07-29T21:57:37Z`, the route/security, critical-test, documentation,
configuration, and Git/worktree reviews were reconciled into the superseding
findings above. Read-only GitHub revalidation found:

- remote `main` at merge commit
  `481a1fb3e9f935699a2fcf685841e34edb04012e`;
- PR #1411 merged at `2026-07-29T19:52:32Z`, with head
  `7252172181962148bb0cb192d2398c366a4541b7` and that same merge commit;
- zero open pull requests; and
- branch protection still requiring only non-strict `docs:check`, with zero
  required approvals, no required conversation resolution, no administrator
  enforcement, and no repository rulesets.

The clean audit checkout at
`C:\pbjustin\Arcanos-memory-auth-forward-fix` remains clean at the PR #1411
head, and its tree `539b384e1b2dc6ef2400fab4acd2b998f19902d7`
matches `origin/main` exactly. That clean tree, not the historical report
checkout, is the evidence source for current code findings.

The historical checkout at `C:\pbjustin\Arcanos` is intentionally 0 commits
ahead and 9 behind `origin/main`, with 16 pre-existing tracked edits and this
untracked audit directory. It is not an exact copy of merged PR #1410:
`tests/mcp-http-transport-deps.test.ts:3` again imports
`StreamableHTTPServerTransport` eagerly, defeating the reviewer-mandated
entrypoint isolation present on current `main`. Never bulk-stage, rebase, merge,
or implement from this dirty checkout. Start the implementation task in a new,
clean `codex/` worktree and branch based on the freshly fetched `origin/main`,
then copy no historical workspace changes by default.

The broader local inventory contains 35 registered worktrees, 17 of them dirty.
One unrelated temporary worktree reports 1,649 tracked deletions. Ownership of
those states was not established, so no worktree cleanup is part of this
handoff. `docs/README.md:167-169` also still describes this report as covering
only PRs #1408 and #1409; because that index is already part of the historical
dirty change set, align it in a separately reviewed documentation update rather
than silently absorbing it into the first code slice.

This final pass revalidated repository source, tests, configuration,
documentation, local/remote Git refs, current GitHub pull-request state, and
GitHub branch protection. It did not re-query Railway, provider, temporary-GPT,
database, live-memory, or production state. Their earlier snapshots remain
historical evidence, not a claim about current live state.

Final artifact validation after these edits passed:

- `npm run docs:check`: 292 of 292 checks passed with zero warnings, and all
  generated indexes were current;
- `npm run docs:links -- --local-only`: 163 local targets passed with zero
  failures; 25 external URLs were discovered but intentionally not queried;
- the report-specific scanner found 194 explicit full-path line-reference
  occurrences representing 185 unique anchors, with no missing file or
  out-of-range line; and
- the report has no trailing whitespace and ends with a newline, the clean audit
  checkout remains clean, and the historical checkout's 16 tracked edits plus
  one untracked audit directory remain preserved.

#### Implementation handoff decision

The audit is ready to hand to an implementation task. Begin with exactly the
public worker-diagnostics projection containment specified above. Do not combine
it with generic job-read ownership, `/dispatch`, shared provider admission,
research cardinality, environment validation, workflow governance, or
documentation cleanup. Establish failing sentinel-based characterization first,
make the smallest shared-projection/auth/cache-policy change, and run the
focused suites plus `type-check` and `lint` before considering a commit.

### Current authorization boundary

The user asked this task to finish the report review and then stop so a separate
task can begin implementation. Accordingly, this task made no source change.
The intended next task is the single local implementation/test slice above;
staging, committing, pushing, opening or updating a pull request, deploying,
changing Railway or provider state, invoking live memory operations, applying
database changes, and mutating production remain outside this handoff unless
the user explicitly authorizes the particular action in that task.

## First remediation implementation and PR #1412 — 2026-07-30

This section supersedes the pre-implementation handoff decision and
authorization boundary immediately above for the work it records. The earlier
text remains intact as the historical audit boundary that controlled the start
of implementation.

At the final pre-merge checkpoint on 2026-07-30—after final commit
`cd368d89` at `2026-07-30T07:21:18Z` and before the PR merge at
`2026-07-30T08:23:30Z`—the implementation, review remediation, disposable
Railway proof, future cleanup configuration, and then-understood
production-readiness precondition described below were complete. Work occurred
only on branch
`codex/worker-diagnostics-containment` in the isolated worktree
`C:\pbjustin\Arcanos-worker-diagnostics-containment`, which began from verified
`main` commit `481a1fb3e9f935699a2fcf685841e34edb04012e`.
PR [#1412](https://github.com/pbjustin/Arcanos/pull/1412), “Contain public
worker diagnostics and secure job continuations,” is the delivery vehicle.

The user first authorized the single public worker-diagnostics containment
slice, then explicitly authorized closing its remaining risks, publishing it as
a draft pull request, using a production-shaped disposable Railway environment,
configuring safe future preview cleanup, addressing and resolving the Copilot
review, and clearing the final production-configuration blocker. Those later
authorizations expanded the implementation beyond the original instruction to
keep generic `/jobs/*` capability design separate. The expansion is recorded
explicitly here rather than being retroactively attributed to the original
slice.

### Public worker-diagnostics containment delivered

The public diagnostics work implemented the audit’s recommended allowlist
projection:

- `src/shared/http/workerHealthProjection.ts` now owns a strict aggregate
  projection containing normalized health state, counts, and timestamps rather
  than spreading internal objects into public responses.
- `/worker-helper/status`, `/worker-helper/health`, `/workers/status`, and
  `/trinity/status` use that public projection. Their serialized responses omit
  `latestJob`, `recentFailedJobs`, `activeJobs`, `currentJobId`, `lastError`,
  `workerIds`, `lastInputPreview`, `lastResult`, and the absolute
  `workersDirectory`.
- `/worker-helper/jobs/failed` now uses the existing privileged worker
  authentication boundary. Intended operator detail remains available through
  authenticated `/gpt-access/workers/status`.
- The pre-merge record then claimed that affected worker, Trinity, GPT Access,
  session-diagnostic, and generic job JSON responses used the shared
  `noStoreResponse` middleware or equivalent explicit headers. The post-merge
  audit below disproved the generic job JSON portion: only generic job SSE
  retained `no-store`, `no-cache`, and `no-transform`.
  `/api/diagnostics/queues` was not changed because it already had the required
  cache policy.
- Session-system diagnostics no longer publish the reusable `lastJobId`
  locator.
- Sentinel characterization uses known UUID, prompt, result, error, worker-ID,
  job-ID, and absolute-path values. Public serialized responses omit those
  values and prohibited keys, while authenticated operator or
  capability-authorized responses retain their intended detail.

The implementation also retained error-envelope and normalized-state
compatibility where public minimization did not require a deliberate contract
change. The final Copilot correction in `cd368d89` makes the `/workers/status`
aggregate internally consistent when auto-heal data is absent: runtime fallback
state `degraded` now counts unavailable workers as degraded instead of emitting
`workers.status: "degraded"` with `workers.degraded: 0`.

### Generic async-job continuation risk then claimed closed; disproved below

After the user authorized the remaining risk work, the branch added a
job-specific read-capability contract for generic asynchronous continuations:

- `src/shared/jobs/jobReadCapability.ts` issues deterministic, job-bound
  `v1` HMAC capabilities from the dedicated
  `ARCANOS_JOB_READ_CAPABILITY_SECRET`.
- Generic async ask/GPT creation responses return `jobReadToken` metadata.
  Status, result, and stream reads require exactly one
  `x-arcanos-job-read-token` header bound to the path job ID.
- Persisted job provenance limits capability reads to recognized public ask/GPT
  creation surfaces. Protected GPT Access jobs do not become generic
  continuation targets.
- Missing, malformed, duplicated, incorrect, and cross-job capabilities use
  non-disclosing not-found semantics. An unavailable verification key fails
  closed with the bounded `JOB_READ_AUTH_UNAVAILABLE` response, and creation
  fails before enqueueing when no valid current signing key exists.
- `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` is verification-only for a
  bounded rotation overlap. New tokens always use the current key, and
  purpose-bound credential collision checks prevent reuse across application
  security boundaries.
- Production and Railway startup validation require a valid current key.
  Test/local execution may omit it, but route-local generic job creation then
  remains unavailable rather than silently issuing unprotected continuations.
- GPT idempotency keys are namespaced by creation surface, and authenticated
  routes derive actor scope from established credentials rather than raw
  caller-selected values.
- TypeScript CLI and Python daemon clients carry the capability only through
  explicit continuation APIs, send it as a header, reject redirects or
  cross-origin continuation URLs, and avoid printing it in normal human output.
- OpenAPI, backend/CLI contracts, environment examples, runtime authentication
  peer lists, maintained documentation, and focused tests were updated with the
  same capability and rotation semantics.

No capability bearer value is stored in the jobs table, placed in a URL,
committed, or written to this report.

### Local and CI verification

The implementation was characterized and verified in progressively broader
layers:

- focused local validation covered 14 Jest suites and 417 tests;
- the committed live-E2E/fixture/cleanup harness characterization covered 3
  suites and 76 tests;
- the final Copilot regression batch covered
  `workers-status-projection`, `public-worker-health-projection`,
  `workers-route-security`, and `workers-route-inventory`: 4 suites and 31
  tests passed;
- `npm run type-check`, `npm run build`, `npm run validate:railway`,
  `npm run docs:check`, and `npm run sync:check` passed;
- `npm run lint` passed with zero errors and 76 pre-existing warnings;
- the production-only dependency audit reported zero vulnerabilities; and
- the session database integration suite reported one suite/test skipped
  because database variables were deliberately cleared. No local configured
  database was contacted by that check.

The exact local Windows `npm test` run still reaches the unrelated existing
CRLF-sensitive source assertion in `tests/job-runner-runtime.test.ts`; this is
the same test-reality defect recorded earlier in the audit, not a runtime
failure introduced by PR #1412. Authoritative Linux CI at final head
`cd368d89cefd037e2dd8822c25fe4d84ebbab27a` passed the full unit suite in
10 minutes 45 seconds, the separate `build-test` job in 10 minutes 18 seconds,
and every other reported check.

The final GitHub rollup contained 22 successful check/status entries, including
lint/type-check, root build, unit and integration suites, convergence,
PostgreSQL fencing/local-agent concurrency, standalone Redis admission, Windows
Python CLI, security audit, Railway compatibility, deployment readiness,
documentation, API endpoint tests, Codecov patch coverage, `All Checks
Complete`, and both Railway native preview services. No check was failed,
cancelled, skipped, or pending in the final audit.

### Production-shaped disposable Railway E2E

Commit `80ad4b70fe4ce25d36b4b815d15ef02f2f09adc2` added a committed,
repeatable worker-diagnostics E2E harness and fixture/cleanup tooling:

- `scripts/worker-diagnostics-preview-e2e.mjs`;
- `scripts/worker-diagnostics-preview-fixture.mjs`;
- focused characterization for both scripts;
- package scripts for the fixture, proof, and cleanup flow; and
- a close-cleanup workflow with fail-closed project/workspace/environment
  identity checks.

The live proof used the isolated Railway environment
`worker-diagnostics-pr-1412-e2e`, the normal production launcher, fresh
PostgreSQL and Redis volumes, private-only data services, purpose-bound
credentials, no configured provider-key aliases, and a loopback-only mock
provider. It did not call OpenAI or another live model provider.

The harness passed 15 of 15 checks over 14 HTTPS requests. It proved:

- Railway control-plane and deployed-commit identity;
- provider-free dispatch;
- aggregate-only output from all four public worker projections;
- privileged failed-job listing;
- retained authenticated operator detail;
- capability-protected generic job status and result reads;
- terminal SSE behavior and cache directives; and
- absence of the known sensitive sentinels from every public serialization.

The tagged database fixture was seeded only into the disposable database.
Cleanup removed its job, events, runtime state/snapshot, and liveness rows.
The disposable environment and both fresh volumes were then deleted. A
post-teardown comparison showed the production and native PR-preview deployment
IDs, domains, and start commands unchanged.

The native `Arcanos-pr-1412` Railway preview remained the passive,
health-only PR environment configured by the repository. Both its web and
worker preview statuses passed at final head. The full E2E was intentionally
run in the separate production-shaped environment rather than weakening the
native preview’s passive isolation.

### Future PR-preview cleanup configured

The initial cleanup workflow used a credential broader than necessary. Commit
`7810ab71` replaced that design with a dedicated Railway token scoped only to
the pinned Arcanos workspace and hardened
`.github/workflows/railway-worker-diagnostics-preview-cleanup.yml` around exact
repository, event, actor, pull-request, project, workspace, environment-name,
and empty-target checks.

The dedicated token is stored write-only as GitHub Actions repository secret
`RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN`. Its value was never printed or
committed. The exact Node 20.19.0 GraphQL program:

- was rejected when it attempted account-identity access, proving the
  workspace boundary;
- deleted a separate exact empty synthetic environment;
- verified that environment’s UUID and name were absent afterward; and
- passed an idempotent no-target rerun.

The short-lived proof token and synthetic environment were removed. One
dedicated workspace-scoped token and the GitHub secret remain for future close
cleanup. Because the workflow itself first becomes available from `main` after
PR #1412 merges, its first real default-branch close event remains an
operational confirmation for a later PR; the current native preview remains
subject to Railway’s native PR-environment lifecycle.

### PR template, review, and final correction

PR #1412 was opened from the isolated branch using the repository’s pull
request template. Its body records the deliberate API/security behavior
changes, rollout and rollback steps, disposable E2E evidence, cleanup
credential boundary, local Windows test caveat, and production-only audit
result.

Copilot reviewed 109 of 110 changed files and produced one actionable inline
comment in `src/routes/workers.ts`. The comment correctly identified the
fallback degraded-count inconsistency. Commit `cd368d89` fixed the projection
and added a route-level regression using one unavailable worker inventory
module with no auto-heal summary. The focused regression, adjacent suites,
type-check, and lint all passed. A reply with the exact fix and validation
evidence was posted, the thread was marked resolved by `pbjustin`, and the
final thread-aware audit found one resolved/outdated thread and zero unresolved
threads.

The PR evidence was then corrected without changing code:

- both stale CI-head references now name `cd368d89`;
- focused local validation now says 417 rather than 416 tests;
- the live E2E checkbox names its actual deployed commit
  `80ad4b70fe4ce25d36b4b815d15ef02f2f09adc2` rather than implying it was
  rerun at the final head; and
- the obsolete “remaining draft notes” heading now says “remaining rollout
  notes.”

### Production signing-key readiness blocker cleared

The final merge-readiness audit found one real deployment blocker even though
GitHub was green: Railway production had no
`ARCANOS_JOB_READ_CAPABILITY_SECRET` in shared, web, or worker scope, while the
new web startup preflight requires that key in production.

With explicit user authorization, a fresh 48-byte cryptographically random
value was encoded as a 64-character base64url secret and configured only on the
production `ARCANOS V2` web service. The Railway GraphQL
`variableUpsert` used `skipDeploys: true`, so the existing application version
was not restarted merely to stage a key it does not consume.

Read-back validation established, without printing the value, that the key:

- is present on `ARCANOS V2`;
- satisfies the 32–4096 character bound;
- has no leading, trailing, or embedded whitespace;
- is not placeholder-form text;
- does not collide with any of the six configured purpose-bound peer
  credentials visible to the web service;
- is absent from shared scope and `ARCANOS Worker`, preserving least
  privilege; and
- has no configured previous-key companion, which is correct for the first
  rollout.

The production web deployment
`08b0ee90-1d6f-4da8-b21e-2b7e1e9f65cd` and worker deployment
`9a3f4927-2ffc-4b59-abd1-cecfdbdc5ebc` both remained unchanged and in
`SUCCESS` state after configuration. No production code deploy, restart,
provider call, database mutation, or live-memory operation was performed as
part of clearing this blocker. The next web deployment will receive the
configured signing key.

### Final state and remaining boundaries

The final read-only GitHub and local audit found:

- PR #1412 open, no longer a draft, `MERGEABLE`, and
  `mergeStateStatus: CLEAN`;
- head `cd368d89cefd037e2dd8822c25fe4d84ebbab27a`, six commits ahead and
  zero behind `main`;
- 110 changed files, 10,475 additions, and 729 deletions;
- all 22 reported check/status entries successful;
- zero unresolved review threads, no requested reviewers, and no
  `CHANGES_REQUESTED` review;
- branch protection still requiring only non-strict `docs:check`, with no
  approval, conversation-resolution, merge-queue, signed-commit,
  linear-history, or administrator-enforcement requirement; and
- a clean isolated worktree whose local head, remote branch, and PR head are
  identical.

At that pre-merge checkpoint, PR #1412 was assessed as technically and
operationally merge-ready. The post-merge continuation below disproves the
operational-readiness portion through the cache, workflow, client, deployment
tooling, and cutover findings; this paragraph is preserved as the historical
assessment, not current evidence. An independent human review remained prudent
because this authorized expansion produced a security-sensitive 110-file diff,
but GitHub did not require one and none was represented as having occurred. The
production current-key value was expected to remain stable through the
retained-job window after rollout. A future rotation was expected to move the
old current key to
`ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET`, install a new distinct current
key, wait for retained jobs to expire, and then remove the previous key.

The close-cleanup workflow’s first real default-branch event, the existing
Windows CRLF-sensitive source assertion, weak branch protection, and all other
ranked audit findings remain follow-up evidence or work; they do not block this
PR under the current repository policy. No `/dispatch`, provider-admission,
research-cardinality, audit-ranked environment-validation redesign,
branch-governance, migration, or unrelated dependency remediation was folded
into PR #1412.

This `progress.md` remains an untracked artifact in the intentionally dirty
historical checkout. The user’s request to update it authorized a narrow edit
to this file only. No historical source file, Git index, branch, worktree
registration, staged state, commit, or pull request was changed by this report
update. Merging PR #1412, deploying its code to production, changing branch
protection, and beginning another ranked remediation slice remain outside this
documentation update unless separately authorized.

## Post-merge PR #1412 read-only audit continuation — 2026-07-30

This section supersedes current-state and closure assertions in
“First remediation implementation and PR #1412” above without erasing that
section’s historical implementation, authorization, review, or live-proof
record. The user directed this task to resume the repository audit read-only
after the merge and authorized updates to this report as the sole repository
write exception.

### Merged source and CI reconciliation

Read-only GitHub and local inspection established:

- PR [#1412](https://github.com/pbjustin/Arcanos/pull/1412) merged at
  `2026-07-30T08:23:30Z`;
- remote `main` is merge commit
  `2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021`;
- the clean audit worktree at
  `C:\pbjustin\Arcanos-worker-diagnostics-containment` remains at PR head
  `cd368d89cefd037e2dd8822c25fe4d84ebbab27a`; its tree
  `7a0a9e7de5f75398050fe48bc217ac11963d2baf` exactly equals the merge commit’s
  tree, so it is the current source-evidence checkout without requiring a
  fetch; and
- the historical report checkout remains intentionally dirty with 16 tracked
  edits and this untracked audit directory. No existing local change was
  staged, discarded, rebased, merged, or copied into the clean audit worktree.

All 22 PR check/status entries were successful. The post-merge authoritative
`CI/CD Pipeline` run
[30526507002](https://github.com/pbjustin/Arcanos/actions/runs/30526507002)
also succeeded, including all 13 reported jobs. Documentation Audit and
repository registration succeeded.

One **P2 operational** post-merge workflow nevertheless regressed:

- `Analyze Documentation Updates` run
  [30526507079](https://github.com/pbjustin/Arcanos/actions/runs/30526507079)
  failed in `Run documentation analysis`;
- `.github/workflows/auto-update-documentation.yml:55-79` starts the server
  with `NODE_ENV=production` but does not provide
  `ARCANOS_JOB_READ_CAPABILITY_SECRET`;
- `src/platform/runtime/environmentValidation.ts:329-363` now requires that
  secret for production startup; and
- the workflow log records
  `Required environment variable ARCANOS_JOB_READ_CAPABILITY_SECRET is not set`
  followed by the server exiting before it became healthy.

The manually dispatched `.github/workflows/arcanos-pr-assistant.yml:91-103`
has the same latent production-mode startup omission. The authoritative startup
job in `.github/workflows/ci-cd.yml:211-218` does provide a dedicated CI-only
fixture and passed. The safest correction is to supply a distinct CI-only
fixture to every production-mode local-start workflow and add a source-level
inventory test so a future required startup credential cannot silently strand
another workflow.

Railway Auto Deploy run
[30527331386](https://github.com/pbjustin/Arcanos/actions/runs/30527331386)
completed its policy path while production deployment remained skipped under
the coordinated-writer hold. This continuation did not re-query Railway or
change the previously staged production signing key; the earlier Railway
statements remain dated operational evidence rather than a fresh live-state
claim.

### PR scope integrity and reviewability correction

PR #1412 was coherent but not an isolated worker-diagnostics slice. Its six
commits changed 110 files with 10,475 additions and 729 deletions. A complete,
mutually exclusive primary-purpose classification of the final range is:

| Primary purpose | Files | Diff |
| --- | ---: | ---: |
| Requested public worker-diagnostics containment | 16 | +1,400 / -292 |
| Separate generic job capability, authentication, idempotency, client, contract, and documentation expansion | 79 | +4,326 / -433 |
| Railway E2E and close-cleanup automation | 11 | +4,721 / -0 |
| Generated indexes | 4 | +28 / -4 |

The later user authorization recorded above permitted the expansion, so this is
not an authorization finding. It is a scope-integrity and reviewability
finding: three independently reviewable programs landed together even though
the pre-implementation handoff explicitly required generic `/jobs/*`
capabilities to remain a separate product-contract slice. The breadth
demonstrably reduced reviewability and may have contributed to a cache-policy
regression and missed public diagnostic route surviving otherwise strong
focused tests and 22 green PR checks.

### Worker-diagnostics closure is partial, not complete

The core requested slice is credible:

- `/worker-helper/status`, `/worker-helper/health`, `/workers/status`, and
  `/trinity/status` rebuild their public responses through the closed
  allowlist in `src/shared/http/workerHealthProjection.ts:210-270`;
- those four responses are `no-store` and omit the known job, prompt, result,
  error, worker-ID, and absolute-path sentinels;
- `/worker-helper/jobs/failed` authenticates before query validation and
  database access at `src/routes/worker-helper.ts:314-338`;
- `/gpt-access/workers/status` remains authenticated, scope-bound, `no-store`,
  and preserves intended sanitized operator detail; and
- Trinity’s unexpected-error response is fixed and non-reflective.

Repository-wide closure cannot yet be claimed:

1. **P1 / High — generic job JSON responses lost their promised cache
   containment.** `GET /jobs/:id`, `GET /jobs/:id/result`, and
   `POST /jobs/:id/cancel` at `src/routes/jobs.ts:259-535` do not mount
   `noStoreResponse`. Their common sender at `src/routes/jobs.ts:110-120` flows
   through `src/shared/http/sendBoundedJsonResponse.ts:6-26` and
   `src/shared/http/sendPreparedJsonResponse.ts:5-14`, which set response-size
   headers but no cache policy. Only SSE retains the middleware and stronger
   directives at `src/routes/jobs.ts:538-576`.

   Commit `80ad4b70` removed
   `router.use('/jobs', noStoreResponse)` and deleted the corresponding JSON
   assertions from `tests/jobs.route.test.ts`. The runtime now contradicts
   `contracts/backend_cli_contract.v1.json:108-150`,
   `contracts/job_status.openapi.v1.json:9-112`,
   `contracts/job_result.openapi.v1.json:9-97`, and `docs/API.md:478-483`.
   The live E2E checks SSE cache directives but not the sensitive JSON
   responses. Because the read bearer is carried in a custom header and the
   GET responses contain retained output and errors, an intermediary cache is
   not safely constrained by the application contract. No deployed
   intermediary was inspected or shown caching these responses, and no actual
   disclosure was reproduced; cross-caller leakage would additionally require
   an authorized priming response, a cache that ignores the custom header, and
   knowledge of the job UUID. This remains a P1 pre-promotion security-contract
   regression rather than evidence of an observed incident.

2. **P2 / Medium — an alternate credential-free worker-status route was
   missed.** Production mounts `/api/arcanos/workers/status` through
   `src/routes/api-arcanos.ts:57`, `src/routes/api/index.ts:85-88`, and
   `src/routes/register.ts:159`. The handler at
   `src/routes/api-arcanos-verification.ts:243-291` has only a caller-resettable
   process-local rate limit and returns worker IDs, per-worker active-job
   counts, and heartbeat timestamps without authentication or `no-store`.
   `src/shared/types/arcanos-verification-contract.types.ts:134-151` and
   `tests/api-arcanos-verification.route.test.ts:192-206` explicitly preserve
   that detailed credential-free shape. It does not publish job UUIDs, prompts,
   or results, so it does not recreate the original locator-to-result chain,
   but it prevents a repository-wide aggregate-only claim.

3. **P2 / Medium — two authenticated worker-helper detail reads remain
   cacheable.** `/worker-helper/jobs/latest` and
   `/worker-helper/jobs/:id` return full job snapshots, including output, at
   `src/routes/worker-helper.ts:275-299` and `:353-378`. Neither route nor
   `src/transport/http/middleware/workerHelperPrivilegedAuth.ts:143-165` sets
   `no-store`. The shared `/jobs/latest` URL and custom authentication header
   make explicit cache containment important even though caller authentication
   is otherwise correct.

`SEC-PUBLIC-DIAGNOSTICS-001` is therefore **partially closed**. The dangerous
public job-locator, recent prompt/result, raw failure-text, and absolute-path
chain was removed from the four intended projections, while the three narrower
cache/projection gaps above remain.

### Job-read capability design is sound; production rollout is not ready

The new job-read primitive itself is well designed. It uses a purpose-bound
HMAC credential canonically bound to the normalized job ID, issues with only
the current key, verifies against current and previous keys with timing-safe
comparison, rejects collisions, checks the capability before storage access,
and retains a distinct ownership/confirmation requirement for cancellation.
The relevant implementation is in
`src/shared/jobs/jobReadCapability.ts:48-176` and
`src/shared/security/purposeBoundCredential.ts:73-132`.

That positive design evidence does not make the merged change ready for
production promotion. In addition to the P1 cache regression and P2 auxiliary
workflow-startup regression recorded above, the rollout has these compatibility
and cutover gaps:

1. **P1 rollout risk — retained pre-cutover jobs have no read-token migration
   path, and a time-only drain is insufficient.** Tokens are deterministic but
   are returned only by new creation responses at
   `src/shared/jobs/jobReadCapability.ts:83-184`. Existing callers never
   received one, cannot derive one without the server secret, and have no
   trusted reissue endpoint. Completed GPT jobs use a default 24-hour retention
   window (`docs/API.md:181`), but the database re-audit below found no cleanup
   for completed or cancelled `ask` rows. Before promotion, operators must
   inventory every retained public ask/GPT row and explicitly choose compatible
   access, accepted unreadability, or bounded exact-type cleanup/retention. A
   public token-reissue endpoint would weaken the boundary and is not the safe
   answer.

2. **P2 contract compatibility — required headers changed without a version
   decision.** The status and result contracts remain version `1.0.0` at
   `contracts/job_status.openapi.v1.json:5` and
   `contracts/job_result.openapi.v1.json:5`; the Custom GPT bridge remains
   `1.2.0` at `openapi/custom-gpt-bridge.yaml:4`. Requiring
   `x-arcanos-job-read-token` and narrowing which jobs are readable are breaking
   changes. The secured contract needs an explicit new version, or maintainers
   must deliberately approve and document a breaking-v1 cutover with
   compatibility tests.

3. **P2 client continuation gaps remain.** Native browser `EventSource` cannot
   send the required custom header declared at
   `openapi/custom-gpt-bridge.yaml:348`, and no browser fetch-stream helper is
   present. CLI human output discards the returned token and directs the user
   to repeat the request with `--json` at
   `packages/cli/src/commands/humanOutput.ts:16` and
   `packages/cli/src/commands/query.ts:44`; anonymous GPT retries receive a new
   random idempotency scope at `src/routes/gptRouter.ts:1830`, so that advice
   can duplicate work instead of recovering the original continuation. The
   Python client sends the read token but additionally refuses transport
   without a separate backend credential at
   `daemon-python/arcanos/backend_client/__init__.py:313`, which is stricter
   than the server’s capability-only status/result contract.

4. **P2 Ask cancellation semantics are not demonstrated.** Ask creation stores
   no owner scope at `src/routes/ask/index.ts:1191`, while unscoped jobs are
   cancellable only by internal actors at `src/routes/jobs.ts:459`.
   `docs/API.md:140` instead describes a retained session/internal check. There
   is no focused Ask cancellation test to resolve the discrepancy.

5. **P3 the Railway E2E command is historical rather than reusable.**
   `scripts/worker-diagnostics-preview-e2e.mjs:29-34` hard-codes the project,
   services, repository, and now-merged
   `codex/worker-diagnostics-containment` branch, with validation rejecting a
   different branch near line 612. `package.json:61` nevertheless exposes it as
   a general command. It should either be archived as dated evidence or have
   only its trusted ref/commit input generalized while preserving exact target
   attestation.

Initial production rollout normally has no previous capability key to retain,
so `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` should remain unset. Later
rotations must retain the previous key until every token-bearing public job
issued under it has expired or been removed under an explicit per-type
retention policy; the current source does not support a universal 24-hour
assumption. Even after the code blockers are corrected, production promotion
still requires exact web-service secret attestation, removal of old web and
worker consumers, the retained-job inventory/decision, native Railway deploy
verification, and coordinated generic-consumer plus DAG-writer authorization.
The deployment hold should remain active until those gates pass.

### Highest-priority residual control ingress remains unchanged

The post-merge source re-audit found PR #1412 byte-equivalent to its base across
the audited control-ingress files. `SEC-CONTROL-INGRESS-002A` remains the
highest-priority pre-existing production-code residual:

- `/dispatch` is mounted without control-plane authentication or
  `confirmGate` at `src/routes/register.ts:148`;
- `src/routes/dispatch.ts:272-400` selects the persistent DAG lane through four
  independent mechanisms: `target: "dag"`, a `dag.*` action, explicit
  `executionMode: "dag"`, or automatic classification at or above `0.85`;
- `target: "dag"` outranks an explicit GPT ID, while an explicit GPT ID outranks
  action, execution-mode, and classifier selection when the target is not
  already decisive;
- the DAG lane calls `arcanosDagRunService.createRun` at
  `src/routes/dispatch.ts:188-250`, reserving capacity, persisting the run, and
  launching background execution without the canonical control-plane
  principal or `mcp:invoke`; and
- the canonical `/api/arcanos/dag/*` boundary at
  `src/services/controlPlane/dagHttpBoundary.ts:104-258` already demonstrates
  the missing bearer, operator, scope, client/principal rate-limit, and
  `no-store` controls, but it cannot be mounted unchanged because `/dispatch`
  multiplexes public GPT and protected DAG traffic in one parsed body.

The safest isolated implementation remains a shared pure dispatch-lane
resolver consumed by both the handler and a DAG-only compatibility boundary.
Apply canonical-equivalent controls only after the resolver chooses DAG, leave
the GPT lane and fixed MCP/tool rejection unchanged, and characterize all four
selectors plus precedence, anonymous and wrong-scope denial, authorized `202`,
`no-store`, and zero `createRun` calls on denial. Because the selector lives in
the mixed public body, this compatibility-preserving slice cannot move
authentication before the broad parser without a separate product decision.

Related routes should remain separate slices: `POST /status` and
`POST /heartbeat` are P2 local-file mutations behind ordinary confirmation;
Backstage contains unbounded database/provider paths; and
`POST /commands/research` has robust SSRF defenses but no URL cardinality,
per-item length, or aggregate-work bound.

### Shared provider admission and rate-limit identity remain P1

The repository-wide re-audit confirms `SEC-PROVIDER-INGRESS-002` and
`SEC-RATE-001` remain **open at P1**. PR #1412 improved established-principal
identity for GPT idempotency (`src/platform/runtime/security.ts:257-280` and
`src/routes/gptRouter.ts:1833-1848`) and bridge identity
(`src/routes/bridge.ts:92-100`), but did not add a provider-work admission
boundary.

Purposeful application-level provider admission remains absent from anonymous
`/gpt/:gptId`, `/api/openai/prompt`, `/arcanos-pipeline`, `/api/reusables`, and
the GPT lanes within `/dispatch`. Confirmation-only routes—where confirmation
is approval rather than authentication—include `/siri`,
`/backstage/book-gpt`, `/commands/research`, and the default-enabled
`/arcanos`, `/write`, `/guide`, and `/sim` compatibility routes. The
default-enabled `/modules/:route` and `/queryroute` paths also call
`routeGptRequest` directly at `src/routes/modules.ts:46-109,143-196`.
`LEGACY_GPT_ROUTES` defaults to enabled at
`src/platform/runtime/legacyRouteMode.ts:5-21`.

Some other surfaces do have local limiters, and authenticated GPT Access,
Custom GPT bridge, MCP, RAG, AFOL, assistant synchronization, and self-heal
provider probes should not be mischaracterized as anonymous. That does not
close the shared ceiling because:

- `getRequestActorKey` accepts session values from headers, body, and query at
  `src/platform/runtime/security.ts:289-303` and gives that caller-selected
  identity precedence at lines 338-342;
- an unverified raw `Authorization` value can create another attacker-selected
  bucket at lines 358-360;
- raw first-hop `x-forwarded-for` is consumed at lines 225-232 and 311-315,
  whose exploitability depends on unverified edge rewriting behavior; and
- each limiter owns a separate process-local `Map` at lines 424-468, so
  middleware instances, processes, and replicas do not share a ceiling, while
  unique-key rotation can grow active-window cardinality without a cap.

`tests/security-rate-limit.test.ts:95-117` explicitly preserves separate
budgets for two caller-selected sessions. No full-application regression proves
cross-route exhaustion or resistance to rotated session, authorization, or
forwarded-address metadata.

Per-request amplification increases the consequence:

- `/arcanos-pipeline` performs four sequential Trinity executions and can
  attempt a fifth fallback at `src/services/arcanosPipeline.ts:75-148`;
- `/commands/research` accepts an unbounded URL array at
  `src/routes/_core/researchRoute.ts:9-20,55-73`, then performs roughly `N`
  fetches, `N` summaries, synthesis, optional audit, and approximately `N+1`
  writes at `src/services/research.ts:255-357`;
- `/api/reusables` can perform generation followed by repair at
  `src/services/reusableCodeGeneration.ts:249-321`; and
- nested `/api/sim` and `/api/vision` request shapes forward caller-selected
  `maxTokens` without a route-level cap at
  `src/services/arcanos-sim.ts:91-105,158-192` and
  `src/routes/api-vision.ts:24-30,122-130`.

A prior statement that `/commands/research` has no counters at all is corrected:
because the bridge, HRC, and image routers each install pathless limiter
middleware at `src/routes/bridge.ts:38-39`,
`src/routes/hrc.ts:10-11`, and `src/routes/image.ts:9-10` before falling
through to research, that route accidentally traverses three unrelated
process-local counters. This is P2 hidden route-order coupling, not a dependable
research policy; all three counters remain caller-key bypassable.

The first behavior-preserving slice is one explicit shared public-provider
admission middleware instance, mounted before provider, queue, database, or
fetch work on the listed public surfaces, with a constant instance-wide
hard-ceiling key that caller metadata cannot rotate. Full-app tests must prove
cross-route exhaustion, rotated-metadata resistance, exactly-once accounting,
and exclusion of health/control paths. Existing route-specific fairness
limiters can remain unchanged in that slice. Both P1 findings remain open until
a later atomic shared-store ceiling enforces the policy across replicas.
Research cardinality, pipeline policy, media token caps, and pathless middleware
scoping should each remain separate follow-ups.

### Governance and contract residuals revalidated

Current `main` branch protection still requires only non-strict `docs:check`.
It has no required pull-request review, conversation resolution, administrator
enforcement, restriction, or repository ruleset. PR #1412 had no `APPROVED`
review. The two successful `require-approval` runs did not establish a human
approval: their logs show an empty PR-label list, `needsApproval: false`, and
`No approval required for this PR by policy.` The workflow at
`.github/workflows/require-approval.yml:27-36` activates only when a mutable
`requires-human-approval` or `autonomy-2`/`autonomy-3` label is present, and no
tracked workflow automatically assigns one.

The Custom GPT bridge contract defect also persists after PR #1412:

- `openapi/custom-gpt-bridge.yaml:18-20` still serves
  `https://YOUR-RAILWAY-DOMAIN` through
  `src/routes/introspection.ts:96-103`;
- `BridgeRequest.action` remains required at YAML lines 360-365 even though
  `src/services/customGptBridgeService.ts:72-85` defaults it to `query`; and
- the status and result polling operations at YAML lines 207-270 still declare
  headers but no response content schemas.

`tests/introspection-openapi-contract.route.test.ts:180-215` continues to use
substring assertions and does not parse or locally resolve the contract, so all
three defects stay green.

### Test and CI evidence is broad but still permits false-green conclusions

The post-merge root run passed 6,584 tests, and its dedicated PostgreSQL, Redis,
and Python jobs are substantive. The correct conclusion is not that testing is
weak; it is that line-count breadth and green workflows overstate endpoint and
rollout proof in several specific areas:

1. The generic-job cache regression is a demonstrated false-green. The route
   suite at `tests/jobs.route.test.ts:1062-1109` asserts cache containment only
   for SSE. The live harness validates job status and result JSON at
   `scripts/worker-diagnostics-preview-e2e.mjs:1367-1421` but invokes its cache
   directive check only for SSE at lines 1438-1467. Its mock returns JSON with
   no cache header at
   `tests/worker-diagnostics-preview-e2e.test.js:386-412`, yet the acceptance
   test passes.

2. The 2,412-line live/fixture probe is valuable characterization, not
   continuous live E2E proof. Its acceptance test at
   `tests/worker-diagnostics-preview-e2e.test.js:762-828` uses a fully mocked
   fetch implementation from lines 276-442. The script derives a read token
   locally from the signing secret at
   `scripts/worker-diagnostics-preview-e2e.mjs:1140-1145` instead of proving the
   deployed creation-response-to-client-polling chain. No workflow continuously
   invokes the real probe, and the one recorded Railway proof targeted commit
   `80ad4b70`, not final head `cd368d89`.

3. The post-merge cleanup run
   [30526508848](https://github.com/pbjustin/Arcanos/actions/runs/30526508848)
   started after the PR merged and reported
   `No disposable Railway environment exists for PR 1412.` It therefore proves
   the default-branch trigger/token context and safe no-target path, but it
   could not gate the merge or exercise the deletion and verification branch at
   `.github/workflows/railway-worker-diagnostics-preview-cleanup.yml:400-445`.
   Behavioral tests cover token rejection and absent-target success at
   `tests/worker-diagnostics-preview-cleanup-workflow.test.js:158-269`; most
   deletion safety checks at lines 92-155 are source-substring assertions.

4. The authoritative run reported four skipped integration suites and 30
   skipped tests. Dedicated database jobs cover local-agent, claim fencing, and
   DAG snapshot fencing, but durable sessions
   (`tests/integration/session-system.integration.test.ts:39-64`), the
   ActionPlan local migration suite
   (`tests/integration/action-plan-execution-migration.integration.test.ts:10-58`),
   and the ActionPlan PostgreSQL 18 suite
   (`tests/integration/action-plan-execution-migration.pg18.integration.test.ts:7-11,966-973`)
   are absent from CI. `scripts/test-env.mjs:15-63` deliberately clears the
   ordinary `DATABASE_URL`, so each needs a dedicated disposable target/job
   rather than an unsafe broad-job export.

5. Source-text and self-mocking tests still substitute for behavior.
   `tests/job-runner-runtime.test.ts:482-515` verifies cancellation ordering
   through source substrings and assumes LF despite all 2,053 lines in this
   checkout using CRLF. The Vision, transcription, and update suites construct
   the real app but issue requests through a mocked global `fetch` that
   implements the behavior being asserted instead of exercising the app.

The enforced 100% threshold covers 94 of 811 `src` TypeScript files; only two
of PR #1412’s 30 changed `src` TypeScript files are threshold-owned. Codecov
upload is non-blocking at `.github/workflows/ci-cd.yml:127-133`. Coverage is
useful evidence of execution, not proof that every public contract or failure
mode is characterized.

### Maintainability re-audit: strong boundaries, localized coordination defects

The post-merge maintainability verdict remains calibrated: ARCANOS is **not
repository-wide spaghetti code**, but several locally spaghetti-like
orchestrators rely on mutable state and implicit ordering. The most important
new result is behavioral rather than a file-size proxy:

1. **P1 conditional control defect — a predictive “do not execute” result can
   authorize a separate real reactive action.** Production starts the
   self-healing loop at `src/server.ts:332-335`, and each tick invokes predictive
   evaluation through
   `src/services/selfImprove/selfHealingLoop.ts:1145-1158,3773-3778`.
   Predictive feature flags constrain that engine’s execution request at
   `src/services/selfImprove/predictiveHealingService.ts:3231-3253`; the engine
   can return `refused`, `unsupported`, `cooldown`, `skipped`, `dry_run`, or
   `failed` without acting at lines 2618-2702.

   The adapter at `src/services/selfImprove/selfHealingLoop.ts:531-563`
   nevertheless maps every non-`none` predictive decision to `decision: "heal"`
   while merely copying `safeToExecute` and the execution status. At lines
   3818-3864, every status except exact `executed` can fall through to the
   separate reactive `executeAction` path. That executor checks its own
   independent cooldown maps at lines 2924-2993, not the predictive result’s
   disposition or `safeToExecute`.

   The important scope qualification is that the fall-through executes the
   reactive `diagnosis.actionPlan`, not necessarily the predictive action, and
   the reactive loop intentionally predates the predictive layer. The defect is
   not that predictive flags must disable all reactive healing; it is that a
   predictive result explicitly marked not to execute becomes the causal final
   approval for a real reactive actuation and can bypass the predictive
   refusal, cooldown, and dry-run boundary.

   `tests/self-healing-loop.test.ts:102-105` mocks the predictive module. Its
   skipped-result cases at lines 393-402 and 1726-1763 use only
   `action: "none"`; there is no non-`none`/no-execute coordinator matrix.
   Before changing behavior, add table-driven characterization for every
   disposition, decide explicitly which may approve an independent reactive
   action, and isolate that decision in one pure policy function.

2. **P2 medium-high — route ownership and policy depend on registration
   order.** `src/app.ts:124` installs global path boundaries;
   `src/routes/api/index.ts:54-89` mounts selected control/read routes before a
   global memory-consistency gate and writing routes afterward; leaf routers
   repeat some boundaries; and
   `src/platform/runtime/dispatchPatterns.ts:10-68` separately maintains route
   predicates and exemptions. `src/routes/register.ts:144-181` then mounts many
   root routers sequentially. Characterization explicitly preserves two
   response owners for `/audit` and three for `/health` at
   `tests/reusable-code-audit-routing-coverage.characterization.test.ts:497`.
   Remove only one characterized duplicate owner per slice, and add
   production-composition coverage rather than relying on isolated leaf-router
   tests.

3. **P2 medium-high — `gptRouter` retains an implicit asynchronous recovery
   state machine.** Its POST handler begins near
   `src/routes/gptRouter.ts:1232` and spans about 2,200 lines. Mutable queued-job
   and pending-response variables at lines 1264-1269 are assigned across
   distant branches and later drive timeout/error recovery at lines
   3255-3276 and 3389-3407; priority-slot ownership is manually transferred or
   released across multiple returns at lines 2363-2539. Existing tests are
   substantial, so the safe extraction is only the async enqueue/continuation
   branch into a finite function returning an explicit recovery-state object.

4. **P2 medium — worker and DAG orchestration lack finite seams.**
   `src/workers/jobRunner.ts:1185-1920` combines the infinite consumer slot,
   claim/backoff, cancellation, heartbeat, provider execution, terminal
   persistence, metrics, and recovery, then starts itself at lines 2043-2052.
   Critical lifecycle ordering is partly verified by source-index assertions in
   `tests/job-runner-runtime.test.ts:461-515`. Separately,
   `src/services/arcanosDagRunService.ts:1387-3800` combines mutable registries,
   retention, admission timers, persistence conflicts, detached execution,
   long polling, cancellation rollback, and execution; lifecycle tests often
   reach private state with `(service as any)`. The first safe seams are a
   finite “process one claimed job” function and one defaulted DAG
   persistence/clock port, never a combined redesign.

Positive counterevidence is material. The Madge cycle gate, CEF layer policy,
and routing-boundary checks are executable through
`scripts/check-boundaries.js`, `scripts/check-cef-layer-access.js`, and
`scripts/check-routing-boundaries.js`; they participate in build, type-check,
and CI. The hotspots have meaningful tests. The finding is concentrated change
amplification and ambiguous coordination policy, not absence of engineering
discipline.

### Scalability and backpressure re-audit: correctness foundation, unproven envelope

Database claim fencing, `FOR UPDATE SKIP LOCKED` claiming, guarded terminal
writes, non-overlapping timers, idle backoff, coalesced snapshot writes,
batch-bounded event cleanup, and the separate Redis/BullMQ admission tests are
strong foundations. Sustained retention, multi-slot budgets, mass recovery,
polling fan-out, and non-sticky web replicas remain uncharacterized:

1. **P1 — successful non-GPT terminal rows have no retention path.**
   `cleanupExpiredGptJobs` handles only GPT rows at
   `src/core/db/repositories/jobRepository.ts:2789-2838`, while
   `cleanupRetainedFailedJobs` handles only failed rows at lines 2847-2903.
   No cleanup was found for completed or cancelled `ask` or `dag-node` rows and
   their JSONB input/output. `getJobQueueSummary` continues to scan all
   non-local-agent rows at lines 2490-2550, coupling permanent data growth to
   increasingly expensive health, planning, and worker operations. Define
   explicit per-type terminal retention first, then add deterministic bounded
   cleanup that preserves GPT polling windows, local-agent reconciliation rows,
   and recent results.

2. **P1 — multi-slot budget accounting can omit the work it is intended to
   limit.** Worker slots use lease IDs such as `async-queue-slot-1` but share
   base statistics ID `async-queue` at
   `src/workers/jobRunnerRuntime.ts:491-507`. Each slot evaluates the budget
   before claiming at `src/workers/jobRunner.ts:1215-1239` and
   `src/services/workerAutonomyService.ts:1009-1029`. The repository query at
   `src/core/db/repositories/jobRepository.ts:2750-2763` matches only exact
   `last_worker_id = $2 OR worker_id = $2`; producers commonly persist IDs such
   as `api`, while claimed rows record the suffixed slot. Those rows therefore
   need not count against the shared base-ID budget. The query also filters
   `updated_at` without a matching index in `src/core/db/schema.ts:653-660`.
   Existing tests assert a shared base ID while mocking the repository.
   Establish whether the budget is deployment-wide or worker-group-wide in a
   real repository test, then query/persist that exact identity and add the
   matching time-window index.

3. **P1/P2 — stale recovery can lock an unbounded outage batch.**
   `recoverStaleJobs` selects every stale running row `FOR UPDATE` and updates
   them sequentially at
   `src/core/db/repositories/jobRepository.ts:1950-2112`; worker-specific
   recovery repeats the pattern at lines 2162-2366. There is no limit, order, or
   `SKIP LOCKED`. Inspector recovery defaults to every 30 seconds, a separate
   watchdog defaults to 10 seconds, and the inspector invokes watchdog again at
   `src/workers/jobRunner.ts:1084-1139` and
   `src/services/workerAutonomyService.ts:666-696`. Under a mass outage,
   replicas can contend while holding large row sets and accumulating result
   arrays. Recover one deterministic `ORDER BY ... LIMIT N FOR UPDATE SKIP
   LOCKED` batch per cycle and prove excess rows remain for later cycles.

4. **P2 — completion polling fans out linearly with waiters.** Each SSE client
   calls `getJobById` every 500 ms for up to 60 seconds at
   `src/routes/jobs.ts:582-630`. Queue-and-wait services poll every 250 ms by
   default for up to 30 seconds at
   `src/services/queuedJobCompletionPolling.ts:104-156`. A single valid
   capability can open many concurrent readers. A behavior-preserving per-job,
   per-replica coalescer with reference-counted cleanup should make many
   subscribers produce one database observation per tick.

5. **P2 — daemon coordination is replica-local and partly unbounded.**
   `src/routes/daemonStore.ts:55-60` keeps heartbeats, commands, results, token
   mappings, and pending confirmations in five process-local maps. Results are
   never evicted, unacknowledged commands can persist indefinitely, and expired
   actions are removed only when presented at lines 150-312. Without verified
   sticky single-replica routing, related API calls can reach different
   processes. Actual replica count and affinity were not inspected, so this is
   a scaling blocker rather than proof of a current incident. Characterize the
   current store behind an interface before adding one shared TTL/atomic-consume
   implementation.

No tracked load, stress, or benchmark harness establishes throughput, latency,
resource ceilings, recovery-batch behavior, or polling fan-out. The evidence
supports “thoughtfully engineered for correctness at modest scale,” not a
measured horizontal-scale claim.

### Maintained documentation remains detailed but operationally incomplete

The documentation pass found no new material migration-specific or
workspace-package guidance defect. Its security explanations are unusually
detailed, but several omissions prevent it from being a reliable production
runbook:

- `docs/RAILWAY_DEPLOYMENT.md:6-10,84-117` and
  `docs/CI_CD.md:24-32` omit
  `ARCANOS_JOB_READ_CAPABILITY_SECRET` from their deployment/startup
  inventories even though `docs/CONFIGURATION.md:65-70` correctly marks it
  mandatory for production and Railway. This drift is the documentation half
  of the failed workflow finding.
- Rotation guidance at `docs/CONFIGURATION.md:88-94` says to retain the
  previous key through the maximum job-retention window, but the lifecycle
  variables read at `src/shared/gpt/gptJobLifecycle.ts:19-89`—including
  completed, failed, cancelled, idempotency, pending-age, and compaction
  durations—are absent from `.env.example` and maintained configuration tables.
  Operators therefore cannot derive the promised overlap from canonical docs.
- `docs/GPT_ASYNC_DOCUMENTATION_WORKFLOW.md:95-104` directs automation to the
  credential-free `/api/arcanos/workers/status` and `/workers/queue` routes,
  while `docs/API.md:459-495` documents only the four newly sanitized public
  projections and does not state the alternate routes’ authentication, cache,
  or disclosure contract.
- The unchanged Custom GPT bridge and machine-contract version defects recorded
  above remain the highest-impact served-contract drift.
- The branch-pinned Railway probe remains exposed as reusable root tooling and
  described as a generic future-PR procedure in
  `docs/RAILWAY_DEPLOYMENT.md:43-58`.

The smallest documentation slice should accompany—not precede—the corresponding
behavior decision: synchronize the workflow/runbook secret inventory with the
startup fix; document lifecycle defaults and an exact rotation formula with the
retention decision; then document or protect the two alternate worker routes.

### Database and migration breadth closure changes the rollout bundle

The database layer has substantive claim/snapshot fencing, idempotency,
compare-and-swap, rollback, and PostgreSQL integration work. The re-audit found
one P1 omission in the coordinated rollout plan plus four narrower defects or
risks:

1. **P1 rollout blocker — generic queue consumer/recovery writers need the same
   coordinated cutover as DAG writers.** New generic claims increment
   `claim_generation`, and heartbeat, retry, deferral, and terminal writes
   require the matching generation at
   `src/core/db/repositories/jobRepository.ts:959-1000,1634-1655,1775-1786,1819-1843,1885-1902`.
   A pre-fencing worker’s terminal update did not carry owner, generation, or
   lease predicates, so it can overwrite a job reclaimed by a new worker.

   The current runbook and deployment hold inventory and attest only DAG
   writers at `docs/DATABASE_MIGRATIONS.md:164-185` and
   `.github/workflows/railway-auto-deploy.yml:15-24,31-61`. The historical
   checklist under “Perform the coordinated production rollout” repeats that
   narrower scope. That checklist is now superseded: the exact-target
   inventory, drain, restart prevention, compatible schema/code deployment,
   rollback boundary, and deployed-revision verification must include the
   dedicated worker, any API process with `RUN_WORKERS=true`, every
   inspector/watchdog recovery writer, and every DAG snapshot writer. Pure
   additive producers do not require a drain unless they can boot a consumer.
   Exact production roles, revisions, and replica counts remain unknown and
   must be reverified immediately before authorization.

2. **P2 current / P1 before multi-writer memory — conversation-session
   find-or-create is racy.**
   `src/services/naturalLanguageConversationSessionStore.ts:75-110` promises
   one durable session per memory key but performs a lookup followed by an
   independent insert. Creation uses a fresh UUID at
   `src/core/db/repositories/sessionRepository.ts:329-406`; lookup masks
   duplicates with `ORDER BY ... LIMIT 1` at lines 549-586; and the only
   memory-key index at `src/core/db/schema.ts:675-678` is non-unique. The route
   tests mock this store, while durable-session PostgreSQL coverage is skipped
   in canonical CI. Add a repository-level, transaction-scoped advisory-lock
   find-or-create operation and a two-connection race test without changing the
   public session-create contract; reconcile any existing duplicates
   separately.

3. **P2 — failed-job cleanup is unbounded and can run from every inspector.**
   `cleanupRetainedFailedJobs` ranks the complete failed set, deletes every
   eligible row, aggregates every deleted ID, and recounts all failures at
   `src/core/db/repositories/jobRepository.ts:2864-2903`. It has no limit or
   `SKIP LOCKED`, and current indexes at `src/core/db/schema.ts:653-660` do not
   match the failed-row ordering. Each inspector can invoke it every default
   30-second cycle through
   `src/services/workerAutonomyService.ts:666-696` and
   `src/workers/jobRunner.ts:1117-1131`; production config enables it at
   `railway.json:66-68`. Add one deterministic bounded batch, matching partial
   index, and concurrent-cleaner PostgreSQL tests after the broader terminal
   retention policy is decided.

4. **P2 — the generic claim-fencing rollback does not validate the exact
   forward contract it claims to remove.**
   `migrations/20260727_job_claim_generation_v1.rollback.sql:12-48` checks the
   type and constraint expression but not `NOT NULL`, default `0`, or
   `convalidated`; it accepts a `NOT VALID` constraint.
   `docs/DATABASE_MIGRATIONS.md:138-141` describes an exact-contract refusal,
   and the DAG rollback at
   `migrations/20260727_dag_run_snapshot_generation_v1.rollback.sql:15-68`
   demonstrates the stronger pattern. Mirror those catalog checks and add
   nullable, changed-default, and unvalidated-drift tests in the disposable
   PostgreSQL 18 suite.

5. **P2 rollout/least-privilege risk — startup DDL is not coordinated across
   replicas.** API and worker startup both invoke the full schema initializer at
   `src/core/db/index.ts:207-250`, `src/core/startup.ts:119-139`, and
   `src/workers/jobRunner.ts:219-267`. `src/core/db/schema.ts:893-963`
   serializes only per process/pool and executes statements individually
   without a database advisory lock, transaction, or explicit lock/statement
   timeout. Web startup can continue in fallback mode after schema failure,
   while Railway probes `/health`; worker health is launcher-only. This proves
   DDL privileges and simultaneous-start contention risk, not a reproduced
   two-replica failure. First add a disposable PostgreSQL concurrency
   characterization; add a database lock/timeout only if that demonstrates the
   harmful race. A verify-only production startup role is a later
   least-privilege decision.

### Cross-language protocol and client conformance is not yet reliable

The schema-first structure and sampled schemas are broadly coherent. The
runtime clients and capability truth nevertheless have three confirmed gaps:

1. **P2 supported-client defect / P1 before releasing or deploying a Python
   async-job consumer — normalization loses object-valued output from the exact
   live route shape.** `/jobs/:id` sends the flat status object built at
   `src/shared/gpt/gptJobResult.ts:248-268`, while
   `/jobs/:id/result` sends a flat completed lookup whose top-level `result` is
   the user output at lines 135-151 and `src/routes/jobs.ts:356-384`.
   `daemon-python/arcanos/backend_client/chat.py:151-178` treats *any*
   mapping-valued `payload.result` as a nested compatibility envelope. A status
   lookup can therefore replace the status record with the user output; a
   completed object result can then read `raw_lookup.get("result")` from that
   user object and return `None`.

   `daemon-python/tests/test_backend_client_chat.py:244-333` supplies a wrapper
   plus a separate top-level `output` that the live `/jobs/*` routes do not
   emit, masking the defect. The TypeScript client correctly discriminates an
   envelope by job/status fields at
   `packages/cli/src/client/backend.ts:583-661`. Mirror that discriminator in
   Python and fixture exact flat status/result responses with object, scalar,
   and null outputs. An independent read-only `python -B` reproduction using
   the exact flat shapes returned the user object instead of the status record
   with no lifecycle, and returned `None` for the completed object result. The
   daemon is optional and no live production Python consumer was established,
   so this blocks cross-language parity and any Python-client release; it is not
   independently a Node web/worker promotion blocker unless exact topology
   inventory finds such a consumer.

2. **P2 — capability discovery advertises three commands that neither default
   dispatcher implements.** `task.create`, `plan.generate`, and
   `control-plane.invoke` are classified as implemented at
   `packages/protocol/src/commands.ts:34-47`, and
   `docs/SCHEMA_PROTOCOL_GUIDE.md:31-48` promises dispatcher behavior. The CLI
   defaults to the Python protocol transport at
   `packages/cli/src/protocolCli.ts:33-49`; the Python schema loader discovers
   every request/response pair and capability handling reports all of them at
   `daemon-python/arcanos/protocol_runtime/schema_loader.py:75-90` and
   `handlers.py:259-267`. Python dispatch lacks all three at
   `handlers.py:123-150`, and the local TypeScript dispatcher lacks them at
   `packages/cli/src/dispatcher.ts:118-128`. The transport test’s
   `arrayContaining` assertion at
   `packages/cli/__tests__/transport-matrix.test.ts:83-96` permits unsupported
   extras. Derive advertised commands from the actual handler registry and
   assert exact equality before reclassifying or separately implementing each
   command.

3. **P2 — the Python ActionPlan executor ignores required compatibility
   negotiation.** The capability schema requires exact `schema_versions` and
   endpoint `locations` at
   `packages/protocol/schemas/v1/action-plan/execution-capability.schema.json:69-127`;
   TypeScript emits them at
   `src/services/actionPlanExecution/service.ts:155-187`; and the ownership
   contract says malformed or mismatched capability is incompatible. The
   Python parser at
   `daemon-python/arcanos/action_plan_execution_protocol.py:298-327` validates
   version, role, operations, and identity but never reads either required
   object. `action_plan_execution_runner.py:69-87` can then mark the executor
   `READY`; focused Python tests contain no `schema_versions` or `locations`
   case. Require the exact shared version constants and route templates in the
   parser, with missing/mismatch tests, without changing the server contract.

Two current non-writing validators explain why these gaps stayed green.
`node scripts/cross-codebase-sync.js` exited 0 on this tree with 0 errors,
0 warnings, and 5 informational findings; it incorrectly reported no Python
tests because `scripts/cross-codebase-sync.js:565-579` scans the
`daemon-python/` root rather than `daemon-python/tests/`.
`node scripts/validate-backend-cli-contract.js` also returned `PASS`.
That validator checks only four required endpoints, route literals, and Python
`def method(` substrings at
`scripts/validate-backend-cli-contract.js:26-35,145-210`; the offline validator
has the same file/symbol character. These commands remain useful drift hints,
not behavioral contract proof. Fix the client/capability behavior first, then
strengthen the gates.

### Waiver removal remains correct; deployment supply-chain gates do not

No dependency manifest or lock dependency changed in PR #1412. The strict npm
policy remains fail-closed, CI and release require raw npm audit plus repository
policy success, and pinned `pip-audit` runs without ignores. The prior
production npm/Python zero-finding evidence remains applicable to this exact
tree; the 16 high development-only ESLint/Madge transitive records remain
tooling debt, not a production exception. **Do not restore or extend a waiver.**

The current supply-chain findings are:

1. **P1 before the deployment path executes / P2 while the hold remains active
   — every deploy-job step would receive the production Railway token.**
   `.github/workflows/railway-auto-deploy.yml:75-81` places both Railway token
   aliases in job-wide `env`. Floating `actions/checkout@v4` and
   `actions/setup-node@v4` execute at lines 85-92, then line 95 installs the
   unversioned latest `@railway/cli` before it inspects and deploys production
   at lines 152-167. The job has no protected GitHub `environment:` and checkout
   persists credentials. The coordinated hold currently prevents the deploy
   job from running automatically, but this path must be hardened before the
   hold is lifted: commit-pin the Actions, pin and verify an exact CLI artifact,
   and scope a least-privileged token only to the exact CLI invocation steps.
   No compromise was demonstrated. Disabling the separate read-only persisted
   checkout credential is P2 defense in depth; a protected production
   environment and approval policy require a separately verified
   single-maintainer-compatible topology decision.

2. **P2 current / P1 latent — unchecked-ref manual workflows remain unsafe.**
   `.github/workflows/arcanos-code-analysis.yml:4-44` and
   `.github/workflows/arcanos-deploy.yml:4-54` accept caller-selected refs,
   expose `OPENAI_API_KEY`, grant write permissions, persist checkout
   credentials, and run selected-code `npm ci` before proving a full immutable
   main-reachable SHA. The deploy workflow performs no deployment at lines
   117-128 but writes and can comment `Deployed successfully` at lines
   129-138 and 171-186. Retire/fail-close the false deploy workflow first; any
   retained analyzer must validate trust from default-branch code before
   candidate checkout and secret exposure.

3. **P2 — immutable Action policy covers release only.** A static inventory
   found 68 of 74 external `uses:` entries on mutable major tags; only the six
   release-workflow Actions are commit-pinned. Floating Codecov and Gitleaks
   execute at `.github/workflows/ci-cd.yml:129,252`, and floating setup-node
   executes before the Railway deletion token is used in
   `.github/workflows/railway-worker-diagnostics-preview-cleanup.yml:32-56`.
   Extend the release workflow’s existing allowlisted-SHA test across
   privileged, provider-, token-, artifact-, and `pull_request_target` jobs
   first, then ordinary CI.

4. **P2 reproducibility/provenance debt remains.** Main and validator
   Dockerfiles use mutable Node tags; CI uses mutable PostgreSQL and Redis tags;
   the local-agent image resolves current apt/Python ranges despite a
   digest-pinned base; and `Dockerfile:35-41` downloads the native Railway
   binary without checksum/signature verification. The current validator checks
   filename and `--version`, while its test accepts the checksum-free pattern.
   No runtime-image SBOM or artifact attestation is generated. Add Railway
   archive checksum enforcement first, then digest-pin images, then emit an SBOM
   tied to commit and image digest in separate slices.

5. **P2 packaging/reproducibility — Python has two contradictory authorities.**
   Root `pyproject.toml:6-17` declares package `arcanos` version `0.0.0`, Python
   `>=3.8`, and no dependencies, while canonical
   `daemon-python/pyproject.toml:6-45,65-66` declares the same package at
   `1.1.2`, Python `>=3.10`, and the real dependency graph.
   `.github/workflows/ci-cd.yml:330-341` installs a hand-selected unpinned
   subset rather than the canonical package. Confirm and remove or neutralize
   the stale root definition, make CI install canonical daemon metadata, and
   introduce platform-specific hashed constraints later.

Node/npm version drift remains P3: `.nvmrc` and authoritative CI use Node
20.19.0, main Docker uses 20.18.1, ancillary workflows float on Node 20, and
`package.json` permits any npm `>=8`.

### Residual deployment-edge and observability audit

Four additional current-tree gaps are now confirmed:

1. **P1 before the next production promotion / P2 while the hold remains
   active — Railway can activate live-but-unready web and worker revisions.**
   `railway.json:15-24` configures `/health` as the shared deployment
   healthcheck. `scripts/validate-railway-compatibility.js:28,183-185` encodes
   that choice as an invariant and rejects a different path. The worker
   launcher returns unconditional HTTP 200 on `/health` as soon as its
   launcher listener exists at
   `scripts/start-railway-service.mjs:673-681`; its separate `/readyz` correctly
   stays 503 until the child emits the bootstrap marker and a provider is
   configured at lines 561-619 and 684-688. Database bootstrap retries are
   indefinite by default at
   `src/workers/jobRunnerRuntime.ts:405-424`, so an unready worker can remain
   deployment-healthy without claiming work.

   The web `/health` handler similarly derives its HTTP status only from
   required-GPT registry completeness at `src/core/diagnostics.ts:62-92` while
   merely projecting startup and Redis state. Its `/readyz` route requires
   OpenAI, configured database and Redis, and startup readiness at
   `src/routes/health.ts:35-45`. The automatic deploy workflow waits for
   Railway `SUCCESS` at
   `.github/workflows/railway-auto-deploy.yml:169-199` but performs no
   application-readiness request. Railway's current
   [healthcheck documentation](https://docs.railway.com/deployments/healthchecks)
   says the first 200 makes the new deployment active and the old deployment
   inactive, and that the path is not continuously monitored afterward. Thus
   a code, credential, schema, or dependency regression can pass activation
   before either role is ready.

   Read-only `git show` confirms the same tracked `/health` configuration,
   worker liveness/readiness split, and indefinite bootstrap retry in the
   deployed #1408 source baseline. The inherited live-settings capture found
   `/healthz` rather than `/health`; that differs from the repository but is
   still unconditional liveness for the worker; web `/healthz` is
   registry-gated but does not establish full role readiness. No failed
   production activation was reproduced, and this continuation did not re-read
   the current service setting. Before promotion, read back each exact role's
   effective deployment settings and use `/readyz` or a purpose-built
   role-aware activation endpoint; preserve `/health` for liveness monitoring.
   Update the static validator, runbook, and post-deploy gate together, and
   characterize transient-dependency behavior so deployment readiness includes
   only dependencies required for that role.

2. **P1 availability — arbitrary public unknown GPT IDs create unbounded
   Prometheus label series.** `unknown_gpt_total` labels by `gpt_id` at
   `src/platform/observability/appMetrics.ts:88-93`;
   `normalizeLabel` at lines 585-596 preserves every nonempty string; and both
   `recordUnknownGpt` and `recordDispatcherRoute` retain the caller-controlled
   value at lines 654-667 and 694-701. The public
   `POST /gpt/:gptId` route is mounted at `src/routes/register.ts:169`, accepts
   the path value at `src/routes/gptRouter.ts:1232-1234`, and records it on an
   unknown lookup at lines 1564-1591. The direct dispatcher repeats the same
   behavior at `src/routes/_core/gptDispatch.ts:1076-1093`.
   Read-only `git show` inspection confirms the same counter, public route, and
   unknown-ID recording path already exist in the deployed #1408 source
   baseline `f5c7826e`; this is not only a post-#1408 promotion regression.

   A read-only, in-memory `prom-client` reproduction created 1,000 distinct
   unknown IDs and retained exactly 1,000 metric series. Protecting `/metrics`
   does not contain this allocation because recording occurs on the public GPT
   request path. Repeated unique IDs can therefore grow process memory and
   scrape cost; no out-of-memory event or request-rate threshold was
   demonstrated. `tests/app-metrics.test.ts:74-77,142-143` positively asserts
   the raw `missing-core` unknown-ID label, so current unit coverage locks in
   rather than detects the unsafe cardinality. Map rejected identifiers to one
   bounded `unknown` label,
   permit only finite registered IDs in all other GPT labels, bound the route
   identifier itself, and prove with a high-cardinality regression that series
   count remains constant.

3. **P2 current / P1 before any rolling deployment with in-flight work —
   graceful shutdown is implemented but its Railway time budget is not
   reproducibly configured.** The launcher forwards `SIGTERM` to web and worker
   children at `scripts/start-railway-service.mjs:541-556,697-709`; the generic
   worker aborts local execution for lease recovery and flushes snapshots at
   `src/workers/jobRunner.ts:1308-1322,1779-1824,2023-2040`. Neither
   `railway.json` nor maintained configuration/runbook documentation sets
   `deploy.drainingSeconds` or `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`.
   Railway's current
   [deployment reference](https://docs.railway.com/deployments/reference)
   documents a zero-second default between `SIGTERM` and `SIGKILL`. Unless the
   uninspected live service setting overrides it, the platform can therefore
   kill the process before those behavior-preserving handlers finish.

   Read back the exact web and worker teardown settings before promotion. Then
   define a role-specific drain budget from measured request cancellation,
   claim recovery, provider abort, and snapshot-flush behavior; express it in
   reviewed config or a deliberately documented provider setting; and add
   validator/runbook tests. The coordinated migration's explicit writer drain
   can mitigate this rollout, but it does not close ordinary future web/worker
   deployments.

4. **P2 deployment reproducibility — the tracked and validated Railway build
   pipeline is not the pipeline a root Dockerfile selects.**
   `railway.json:4-13` declares `RAILPACK` and a
   `npm ci --include=dev ... && npm run build` command. The maintained runbook
   repeats that command at `docs/RAILWAY_DEPLOYMENT.md:32-38`, and
   `scripts/validate-railway-compatibility.js:163-170` requires the Railpack
   declaration and any nonempty build command. The same validator separately
   requires Dockerfile content at lines 291-327, while the repository root
   `Dockerfile:30-61` performs a different two-install build using
   `npm ci --omit=dev`, then `npm install --include=dev`, then production
   pruning.

   Railway's current
   [config-as-code reference](https://docs.railway.com/config-as-code/reference)
   states that a discovered Dockerfile is always used even when a different
   builder is declared. The repository therefore carries one documented and
   validator-green build path that is normally ineffective, plus a second
   behaviorally different path that actually governs the image. Confirm the
   effective builder in exact deployment metadata, choose one canonical
   pipeline, and make configuration, deterministic install strategy, tests,
   and the runbook describe only that pipeline. Direct read-only execution of
   `node scripts/validate-railway-compatibility.js` exited 0 on this exact tree,
   demonstrating the current false-green.

### Residual runtime ownership and activation audit

The canonical production worker owner is now clear, but the repository retains
one active alternate-runtime defect plus several conditional activation paths:

| Runtime or path | Current ownership and deployment evidence |
| --- | --- |
| `src/workers/jobRunner.ts` and supporting `src/workers/*` | Canonical database-backed Railway worker launched by `scripts/start-railway-service.mjs:647-664`; broadly covered by focused root Jest suites. |
| `src/platform/runtime/workerConfig.ts` | Alternate in-process runtime started by `src/app.ts:96-104`; suppressed for the canonical Railway web role, but enabled by default for direct non-test `npm start`. |
| `workers/` | Always compiled by the root build, but no root or Railway launcher invokes its entrypoints; current ownership is manual/dormant. |
| `arcanos-ai-runtime/` | Separately tested BullMQ runtime with its own authentication and shutdown policy; not compiled or launched by the root build or Docker start path. |
| `src/platform/runtime/workerBoot.ts`, the autoscaling prototype cluster, and `src/server/bootstrap.ts` | Root-compiled compatibility/prototype code with no tracked runtime caller. |
| `legacy/` | Excluded from Railway and Docker and has no production import; external unpublished consumers cannot be disproved statically. |
| `Procfile` | Historical direct start path that is behaviorally different from the canonical Railway launcher. |

1. **P2 outside the canonical Railway web role — the in-process “worker
   pool” multiplies rather than distributes each request.**
   `WorkerTaskQueue.dispatch` iterates and awaits every registered listener at
   `src/platform/runtime/workerConfig.ts:143-187`. Startup registers four
   identical Trinity-backed handlers by default at lines 24-35, 224-235, and
   396-400; predictive scale-up registers still more listeners at lines
   608-665. Two common callers retain only `dispatchResults[0]` at
   `src/routes/workers.ts:288-289`,
   `src/routes/sdk/shared.ts:193-198`; worker-control service callers instead
   preserve the complete result array. A default direct-runtime request through
   either first-result caller can therefore perform four sequential
   provider/Trinity executions while discarding three results, and every
   “scale-up” increases cost and latency rather than throughput.

   The canonical Railway web launcher explicitly sets
   `ARCANOS_PROCESS_KIND=web` and `RUN_WORKERS=false` at
   `scripts/start-railway-service.mjs:527-539`, so this is not evidence of that
   role currently multiplying requests. Plain `npm start` has no process role,
   however, and `src/platform/runtime/unifiedConfig.ts:247-278` defaults
   workers on outside tests. Ensemble execution is a theoretical alternative
   interpretation, but no aggregation policy documents it and the callers
   discard later outputs. First freeze two-listener invocation count, order,
   retry, and caller projection in a characterization test; then separately
   choose single-consumer/round-robin semantics or explicitly aggregate and
   document ensemble results.

2. **P2 conditional — `Procfile` bypasses the role and lifecycle contract.**
   `Procfile:1-2` starts the web server and job runner directly, bypassing the
   canonical launcher's role validation, web `RUN_WORKERS=false`, preview
   isolation, and worker health listener. Both direct entrypoints do install
   their own signal handlers, so this is not a claim that Procfile shutdown is
   wholly unhandled. Tracked Railway config and Docker use the canonical
   launcher, so no current Railway execution of the Procfile was established.
   Before any external Procfile deployment, make retained entries delegate to
   that launcher and add them to passive deployment validation; delete the file
   only after confirming that no external platform still owns it.

3. **P3 current / P2 activation blocker — dormant runtime contracts are
   internally incomplete or mutually incompatible.**
   `src/platform/runtime/workerBoot.ts` claims server-startup ownership but has
   no tracked caller, initializes database state before honoring disabled
   workers at lines 61-78, prefers root `dist/workers` through
   `src/platform/runtime/workerPaths.ts:120-132`, and expects a named
   `startScheduling` export at `workerBoot.ts:148-166`. The separately compiled
   `workers/src/worker-planner-engine.ts:25-42` exports only a default scheduled
   object, while its manual worker entrypoints process one environment payload
   and then hold standard input open without a health or shutdown contract.
   The standalone `arcanos-ai-runtime/package.json:2-10` is not marked private,
   points `main` at nonexistent `index.js`, and provides no start command; the
   root build omits its compilation even though Docker copies its source.

   These paths are activation and maintainability debt, not evidence that the
   canonical database worker lacks authentication or claim fencing. Decide
   ownership before consolidation: characterize the resolver and entrypoint
   contract in build-shaped tests, retire unreachable loaders/prototypes only
   after external-consumer confirmation, and separately make the standalone
   manifest/package/start contract truthful before any rollout.

### Residual privacy, logging, and HTTP-surface audit

The security-best-practices continuation found substantial purpose-bound
controls, bounded prompt-debug tracing, and structured redaction, but it also
confirmed that older observability paths do not consistently inherit those
policies:

1. **P2 current / P1 before confidential-prompt production use unless exact
   live retention and access controls close the exposure — default audit and
   feedback sinks retain user/model content.**
   Trinity audit entries store up to 100 characters of both the user prompt and
   final model output after whole-string credential-pattern redaction, plus raw
   memory keys, at
   `src/core/logic/trinityStages.ts:765-788`,
   `src/core/logic/trinity.ts:526-548`, and
   `src/services/auditSafe.ts:193-200`. The redactor recognizes credential and
   connection-string shapes, not arbitrary personal or confidential prose.
   `logAITaskLineage` synchronously appends the JSON entry to `audit.log` and a
   metadata lineage entry to `lineage.log` at
   `src/services/auditSafe.ts:132-145`. Memory retrieval separately writes raw
   accessed keys to standard output at
   `src/services/memory/context.ts:69-92`.

   The default directory is `/tmp/arc/log` at
   `src/shared/logPath.ts:26-27,58-66`; these audit appenders specify no file or
   directory mode, byte cap, rotation, or TTL. The active-default Siri path,
   and compatibility Ask only when `ASK_ROUTE_MODE=compat`, call
   `logRequestFeedback` at `src/routes/siri.ts:28-37` and
   `src/routes/ask/index.ts:911,1551-1590`; Ask otherwise returns 410. The sink
   writes the first 500 characters of the validated, trimmed, but otherwise
   unredacted prompt to the overwrite-only `/tmp/last-gpt-request` snapshot at
   `src/transport/http/requestHandler.ts:83-100,175-200,386-405`. That snapshot
   is bounded to the latest request and is not a disk-growth finding, but it
   has no explicit file mode or retention policy. The focused audit test covers
   only secret-shaped redaction (`tests/audit-safe-redaction.test.ts:3-9`),
   while `tests/request-handler.feedback.test.ts:53-72` positively asserts
   unredacted prompt retention. Read-only `git show` confirms both default
   sinks already exist in the deployed #1408 source baseline.

   First attest the exact production data classification, log aggregation,
   filesystem/collector access, and retention behavior. Make metadata-only
   logging—length, keyed digest, categorical outcome, and safe identifiers—the
   default; put content behind an explicit short-lived operator mode; use
   restrictive file/directory modes; and cap, rotate, and expire every retained
   sink. Add sentinel prose/PII tests across files and standard output. The
   protected prompt-debug subsystem is a positive control: it defaults to
   metadata, bounds memory and disk, requires explicit persistence, uses a
   restricted file mode, and is not the source of this finding.

2. **P2 privacy, reached through the already-ranked public `/dispatch` P1 —
   verification DAG nodes log prompt and model-output previews.**
   `src/workers/taskRunners.ts:32-38,299-350` emits bounded, otherwise-unredacted
   verification-prompt and normalized model-summary previews of at most 240
   characters. The templates embed a caller goal directly at
   `src/dag/templates.ts:135-144,168-173,191-205`; public `/dispatch` transfers
   the caller prompt/goal into a created run at
   `src/routes/dispatch.ts:160-168,188-234`; and the canonical database worker
   calls the task runner at `src/workers/jobRunner.ts:583-611`. Structured
   logger redaction removes credential-shaped values but preserves ordinary
   prose, and `tests/task-runners.test.ts:109-152` positively asserts the
   model-summary preview, not the prompt preview. Closing the `/dispatch`
   authority bypass remains first. In a separate slice, replace the preview
   with length/digest/outcome metadata and prove sentinel prompt/output text is
   absent from default worker logs.

   The alternate in-process runtime similarly logs and retains a 120-character
   input preview at `src/platform/runtime/workerConfig.ts:143-175`,
   `:340-365`, and `:544-603`. Its active mutation routes are privileged, and
   current public worker projections omit the preview, so this is
   operator/internal P2 privacy debt rather than a new public disclosure.

3. **P2 configuration hardening — `/metrics` is public by default.**
   `src/app.ts:311-317` mounts the endpoint, and
   `src/platform/observability/appMetrics.ts:1520-1564` authorizes every caller
   when `METRICS_AUTH_TOKEN` is absent. Maintained configuration explicitly
   documents that default at `docs/CONFIGURATION.md:650-654`, while
   `tests/metrics.route.test.ts:108-128` asserts unauthenticated HTTP 200.
   Output includes route templates, model/source aggregates, queue and worker
   state, dependency/circuit state, and process health. No dedicated prompt or
   session field was found, but caller-controlled unknown GPT IDs and selected
   model values can appear as metric labels. The exact live variable and any
   edge allowlist were not inspected. Fail closed in production or require an
   explicit local-public opt-in, with tests for absent, collided, and correct
   credentials. This is separate from the P1 allocation finding: protecting
   the scrape endpoint does not bound in-process series growth.

4. **P2 privacy — the request logger records raw dynamic path values, IP, and
   user agent on every request.**
   `src/middleware/requestContext.ts:57-93,109-137,160-227` builds the base log
   path before route resolution and includes `req.ip` and the complete
   user-agent value in request-received output.
   `src/shared/requestPathSanitizer.ts:11-43` removes only the query string, so
   GPT IDs plus job, session, record, and other path-bound identifiers remain.
   The raw path is outside structured `data` redaction; IP and ordinary
   user-agent values pass through recursive credential-pattern redaction
   unchanged, although a credential-shaped user agent can be replaced. UUIDs
   may be only pseudonymous and exact aggregator access/retention is unknown,
   so no raw-secret claim is made. Normalize received paths, use route templates
   on completion, and hash, truncate, or omit network/client metadata according
   to an explicit privacy policy; prove it with path/IP/user-agent sentinels.

5. **P2 topology disclosure extends the existing
   `SEC-DIAGNOSTICS-002` finding.**
   Credential-free `/diagnostics` returns the live route table, registered GPT
   IDs and module map, latency/error aggregates, and top error routes through
   `src/core/diagnostics.ts:143-170`,
   `src/services/runtimeDiagnosticsService.ts:268-359`, and
   `src/services/runtimeRouteTableService.ts:120-167`.
   `/healthz` returns required/missing GPTs plus startup, Redis, and circuit
   detail at `src/core/diagnostics.ts:26-90`. Maintained documentation and tests
   deliberately preserve these public shapes; no prompt, current session ID,
   credential, or generic job locator was found. Keep public liveness/readiness
   minimal and stable, move detailed topology behind an operator-read boundary,
   and set `no-store` on every health/diagnostic success and failure response.

6. **P3 HTTP hardening — security headers are route-local rather than
   application-wide.**
   `securityHeaders` is actively used by protected, media, Ask, bridge, and GPT
   Access routers; it is not dead code. `src/app.ts` nevertheless has no global
   header middleware and does not disable Express `X-Powered-By`, leaving
   unwrapped health, diagnostic, metrics, fallback, and public GPT responses
   inconsistent. Proxy behavior may mitigate this and the JSON-API impact is
   low. Disable the framework fingerprint, centralize safe API headers, and
   test representative success/error/404 paths. Do not blindly globalize the
   current unconditional HSTS value: transport policy belongs at a confirmed
   HTTPS/trusted-proxy boundary.

### Cross-workspace architecture closure

The expanded multi-agent scan strengthens rather than weakens the “localized,
not repository-wide spaghetti” conclusion:

- the root Madge graph covered 835 TypeScript nodes with zero cycles;
- separate read-only graphs found zero cycles in protocol (63 nodes), the
  TypeScript CLI (37), shared runtime (5), shared OpenAI (15), `workers/` (21),
  and `arcanos-ai-runtime/` (36); these are graph-node counts, not claims about
  workspace-local file totals;
- the workspace dependency direction is one-way: CLI to protocol, OpenAI to
  runtime, worker runtimes to OpenAI/runtime, and root to the workspaces;
- all 92 production `@arcanos/*` import occurrences use declared package
  exports; no production deep import or source escape was found; and
- a static scan of 132 Python modules found no eager import cycle.

The expanded dependency/cycle scan adds two P3 prevention/maintainability gaps.
First,
`scripts/check-boundaries.js:20-30` commits only the root `src` cycle gate, so
the currently clean workspace state is not regression-enforced and unresolved
package-export skips are not asserted. Add explicit per-workspace Madge targets
without changing the already-correct dependency direction. Second, optional
Python daemon `ArcanosCLI.__init__` and the 210-line `handle_ask` coordinator at
`daemon-python/arcanos/cli/cli.py:94-178,369-578` combine startup side effects
and conversation rate admission, backend/local routing, fallback file I/O,
rendering, memory, telemetry, and speech. Its delegates have focused tests, but
`daemon-python/tests/test_cli_method_contracts.py:8-28` checks only method
presence and no real `handle_ask` characterization was found. Before a material
daemon routing/fallback change, freeze the coordinator with table-driven tests,
then extract only one route/fallback-result seam.

### Current six-dimension verdict

| Dimension | Post-#1412 evidence-based verdict |
| --- | --- |
| Maintainability | **Qualified, not clean.** Executable boundaries and tests prevent repository-wide spaghetti, but self-heal coordination, route-order policy, redundant/dormant runtime contracts, the alternate-worker fan-out, capability over-advertising, and large mutable orchestrators make high-risk changes expensive. |
| Scalability | **Not demonstrated at measured scale.** Queue correctness foundations are strong, but unbounded unknown-GPT metric series, terminal data growth, budget-accounting identity, unbounded recovery/cleanup, session deduplication races, readiness/drain ambiguity, and replica-local coordination block a confident horizontal-scale claim. |
| Security | **Not yet demonstrably secure at the whole public or delivery boundary.** Canonical controls are substantial, but generic job caching, `/dispatch` DAG admission, provider admission/rate identity, default prompt/log retention, public-by-default metrics, narrower diagnostic gaps, and mutable production-deploy tooling remain open. |
| Testing | **Broad and useful, but not uniformly behavior-proving.** Core CI passed 6,584 tests, while specific false-greens, skipped PostgreSQL behaviors, mocked “live” paths, source-text assertions, weak protocol validators, and missing high-cardinality, multi-listener, content-sink, and exact deployment-readiness regressions remain. |
| Documentation | **Structurally strong, operationally incomplete.** Maintained checks and detailed guides coexist with a false-green Railway builder description, startup/runbook drift, a DAG-only writer-drain plan, missing drain and content-retention policy, a semantically misleading served OpenAPI contract, and undocumented alternate routes. |
| Spaghetti-code assessment | **No repository-wide finding; localized risk is real.** Expanded scans found zero within-workspace TypeScript cycles, an acyclic workspace dependency DAG, and no eager Python import cycle across 132 modules; production package imports respect exports. Self-heal, GPT routing, worker lifecycle, DAG coordination, the Python Ask coordinator, and route registration still require characterization-led, one-seam-at-a-time work. |

### Current correction order and authorization boundary

Risk rank and executable order are deliberately separated. Production
promotion dependencies come first even when a repository P1 below is unrelated
to the held deployment.

#### A. PR #1412 and production-promotion blockers/dependencies

1. **A.1 is committed and published in open PR #1413; unmerged and
   undeployed.** The draft restores `no-store` across every generic job status,
   result, cancellation, validation, authorization, and repository-error
   response, with success, failure, and live-harness assertions. The
   dedicated-worktree and integrated-publication evidence is recorded below.
2. **A.2 is committed and published in open PR #1413; unmerged and
   undeployed.** The deploy workflow now commit-pins its Actions, pins and
   verifies the Railway CLI artifact, and step-scopes a dedicated project-token
   secret. The dedicated-worktree, integrated-publication, and still-external
   prerequisite evidence is recorded below. Checkout-credential persistence
   and a feasible protected-environment topology remain separate
   defense-in-depth/settings decisions.
3. **A.3 is committed and published in open PR #1413; unmerged and
   undeployed.** Tracked config, web and worker launchers, job-runner bootstrap,
   validator, exact-deployment workflow evidence, bounded live harnesses, and
   runbooks now agree on role-aware `/readyz` activation, timeout `300`, and a
   `60`-second drain ceiling. A.2/A.3 workflow composition is complete in the
   draft. Read-only live inspection still found `/health` and disabled teardown
   drain on both production roles, so promotion remains blocked pending an
   authorized deployment, exact effective web/worker setting readback, and a
   measured real drain rehearsal.
4. Expand the coordinated cutover from DAG writers to the dedicated generic
   worker, any API role with `RUN_WORKERS=true`, inspector/watchdog recovery
   writers, and old-replica restart prevention. The typed hold/attestation must
   cover generic claim fencing and DAG snapshot fencing together.
5. Inventory retained public ask/GPT jobs by type; define cleanup/retention and
   accepted compatibility before initial cutover and key rotation; resolve
   contract-version, browser/CLI/Ask continuation, exact secret, deployed
   revision, migration/rollback, and old-replica gates. A fixed wait is not
   sufficient while completed/cancelled Ask rows have no cleanup.
6. If exact topology or release scope includes a Python async-job consumer,
   correct its flat `/jobs/*` normalization first and fixture exact object,
   scalar, and null output shapes. Otherwise retain it as the first
   cross-language P2 client fix rather than a Node production blocker.
7. Repair the two auxiliary production-mode local-start workflows and add a
   startup-credential inventory regression before calling repository automation
   fully green. This is a P2 operational regression, not evidence that the live
   production secret is absent.

#### B. Current public/runtime P1 security and integrity work

1. Implement only the `/dispatch` DAG compatibility boundary described above.
2. Add the shared instance-wide public-provider admission ceiling, then plan a
   separately reviewed cross-replica shared-store ceiling.
3. Map rejected GPT identifiers to one bounded metric label, allow only finite
   registered IDs elsewhere, bound the route ID itself, and prove series count
   remains constant under high-cardinality input.
4. Characterize and correct the predictive-to-reactive self-heal disposition
   policy; separately resolve the older dual self-heal mitigation owner.
5. Define non-GPT terminal retention and repair worker-budget identity with real
   repository tests before batching failed/stale cleanup.
6. Repair the same-session natural-language key-overwrite defect with frozen
   clock sequential/concurrent tests while preserving explicit keys and retry
   deduplication.
7. Repair the served Custom GPT contract and structural contract tests.
8. Treat strict branch protection and required-check enforcement as a separate
   exact external settings change with a single-maintainer-compatible review
   policy.

#### C. P2 evidence, compatibility, and maintainability work

1. Decide whether `/api/arcanos/workers/status` and `/workers/queue` remain
   public; then protect or minimize/cache-contain them. Add `no-store` to the
   authenticated worker-helper detail reads separately.
2. Characterize the alternate in-process worker with two listeners, then decide
   and enforce single-consumer versus explicit ensemble semantics without
   changing canonical Railway worker ownership. Treat Procfile delegation as a
   separate conditional deployment slice.
3. Attest production prompt classification and log access/retention, then make
   the Trinity audit file, Siri snapshot and compatibility Ask snapshot when
   enabled, DAG verification log, in-process worker preview, request
   path/client metadata, and detailed diagnostics metadata-only or explicitly
   protected one sink at a time.
4. Fail metrics closed in production or require an explicit local-public mode;
   separately minimize public diagnostics and centralize safe API headers
   without blindly globalizing HSTS.
5. Choose one canonical Railway build pipeline and make the tracked builder,
   deterministic install, validator, tests, and maintained runbook agree.
6. Correct protocol capability truth and ActionPlan compatibility negotiation
   as two independent slices, then strengthen semantic cross-language gates.
7. Handle conversation-session find-or-create, bounded failed-job cleanup,
   exact rollback validation, and concurrent startup-DDL characterization as
   four separate database slices.
8. Fail-close or retire the unchecked-ref/fake-deploy workflows before
   expanding immutable-Action policy, Railway archive verification, image/SBOM
   provenance, or Python package/lock cleanup.
9. Improve proof one isolated concern at a time: exact-target cleanup
   simulation, dedicated session and ActionPlan PostgreSQL jobs, executable
   worker-cancellation characterization, and real route-level Vision coverage.
10. Treat dormant worker loaders/prototypes, standalone-runtime packaging,
    per-workspace cycle-gate expansion, and Python `handle_ask`
    characterization as P3 ownership/prevention slices, promoted only before
    activation, deletion, or material routing changes.

An independent coverage-gap review judged this evidence broad enough for the
current-tree comprehensive audit handoff: no materially unaudited production
boundary should delay the ranked isolated remediations above. The tracked-tree
runtime-ownership, cross-workspace dependency/cycle, deployment-edge, and
observability/privacy continuations are now complete and incorporated. They
added one current P1 availability issue plus bounded P2/P3 work without
displacing the existing P1 executable order. Remaining read-only work is
non-blocking and externally conditioned: treat the deferred GPT-OSS subsystem
as its own product program; attest exact live Railway topology, effective
settings, log retention/access, and edge controls; and confirm external owners
before deleting `legacy/`, `Procfile`, or dormant compatibility runtimes.

Provider-ingress, job-capability rollout, test/CI completeness, runtime
ownership, cross-workspace architecture, deployment-edge, privacy/logging, and
metrics re-audits are now reflected above, together with the
maintainability/coupling, scalability/backpressure, maintained-documentation,
database/migration, protocol/client, and supply-chain/workflow continuations.

Except for this report update, the continuation remains read-only. It made no
source, test, configuration, Git-index, branch, commit, pull-request,
deployment, database, live-memory, Railway, provider, or production mutation.
The explicitly recorded contract/sync and Railway compatibility validators,
the multi-workspace cycle scans, and the in-memory `python -B` normalization
and `prom-client` cardinality reproductions were read-only and created no
artifact; no artifact-producing local validation command was represented as
having run.

#### A.1 local implementation checkpoint — 2026-07-30

A.1 is implemented and validated locally, but it is not staged, committed,
merged, pushed, deployed, or exercised against a live service. Work occurred in
the dedicated `C:\pbjustin\Arcanos-job-cache-containment` worktree on
`codex/job-cache-containment`, created from the then-current verified
`origin/main` commit `2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021`
(tree `7a0a9e7de5f75398050fe48bc217ac11963d2baf`). The historical dirty checkout
was preserved; this report is its only authorized implementation-continuation
edit.

The characterization-first evidence was deliberately red:

- after adding generic-job route and harness assertions but before changing
  runtime or harness behavior, the focused Jest run failed both suites with
  25 failed and 42 passed tests. Generic JSON responses had no
  `cache-control` header, and the mocked live harness still accepted cacheable
  job status and result responses;
- a production-composition malformed-JSON test then failed one of seven parser
  tests because `express.json` rejected the cancellation body before the jobs
  router could establish `no-store`; and
- one later combined run failed only because the new confirmation test matched
  `error` instead of the response's stable `code: CONFIRMATION_REQUIRED`.
  Correcting that test expectation required no runtime change.

The isolated correction is:

- `src/app.ts:125` mounts the path-scoped `/jobs` `noStoreResponse` immediately
  after request context and before CORS and broad body parsing, covering
  preflight, malformed/oversized JSON, parser, fallback, and error responses
  that never enter the jobs router;
- `src/routes/jobs.ts:44` restores the router-level `/jobs` policy, so the
  exported router itself covers status, result, cancellation, path validation,
  capability/authentication, confirmation, repository failure, truncation,
  not-found, conflict, accepted, and success responses without changing their
  bodies, status codes, or control flow. The existing SSE route still upgrades
  this to `no-store, no-cache, no-transform`;
- `scripts/worker-diagnostics-preview-e2e.mjs:1387-1433` now fails closed on
  cacheable generic job status/result JSON with stable
  `JOB_STATUS_CACHE_POLICY_INVALID` and
  `JOB_RESULT_CACHE_POLICY_INVALID` codes and records the checked directive;
  and
- `tests/jobs.route.test.ts`,
  `tests/action-plan-execution-app-parser.test.ts`, and
  `tests/worker-diagnostics-preview-e2e.test.js` cover representative success,
  failure, validation, capability/authentication, confirmation, repository,
  bounded-result, production-parser, and live-harness paths. The confirmation
  test snapshots and overrides import-time allow-all settings, then restores
  them, so inherited wildcard configuration cannot turn the test false-green.

Final local validation used the repository-required Node `v20.19.0`:

- focused Jest with deliberately hostile inherited
  `ALLOW_ALL_GPTS=true` / `TRUSTED_GPT_IDS=*`: **passed**, 3 suites and 75
  tests;
- `npm run type-check`: **passed**, including CEF, cycle, routing-boundary, and
  shared-package checks;
- `npm run lint`: **passed with 0 errors and 76 warnings**, all outside the six
  implementation-worktree files changed by A.1;
- `npm run build`: **passed**, including packages, workers, root TypeScript,
  alias repair/check, and asset copy; and
- `git diff --check`: **passed**.

The initial surface audit, an adversarial final-diff review, and a separate
production-composition review found no remaining A.1 issue after reconciliation.
The composition reviewer found both the pre-router parser seam and the inherited
confirmation-setting test instability; both were reproduced, corrected, and
re-reviewed. A real live/Railway harness run and live cancellation were
**skipped** because external mutations and live execution were not authorized.
No database, memory, provider, Railway, production, Git-index, commit, push,
pull-request, deployment, release, or external-settings mutation occurred. At
that checkpoint, correction A.2 and every unrelated audit item remained
untouched.

#### A.2 local implementation checkpoint — 2026-07-30

A.2 is implemented and validated locally, but it is not staged, committed,
merged, pushed, deployed, or exercised against Railway. Work occurred in the
dedicated `C:\pbjustin\Arcanos-railway-deploy-supply-chain` worktree on
`codex/railway-deploy-supply-chain`, created from and reverified against
`origin/main` and remote `main` commit
`2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021` (tree
`7a0a9e7de5f75398050fe48bc217ac11963d2baf`). The A.1 worktree and the
historical dirty checkout were preserved; this report is the historical
checkout's only authorized implementation-continuation edit.

The characterization-first evidence was deliberately red. Before changing the
workflow, focused Jest failed all three new A.2 tests:

- all four reusable Action references were mutable `@v4` tags rather than the
  repository's reviewed immutable commits;
- no verified CLI-install step existed because the workflow ran unversioned
  `npm install -g @railway/cli`; and
- the deploy job exposed one repository secret as both `RAILWAY_TOKEN` and
  broader `RAILWAY_API_TOKEN` aliases to every job step.

The isolated correction is:

- `.github/workflows/railway-auto-deploy.yml` pins both policy-job and
  deploy-job checkouts to
  `actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955`
  (`v4.3.0`) and both Node setup steps to
  `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`
  (`v4.4.0`);
- the workflow downloads the exact Railway CLI `4.30.2`
  `x86_64-unknown-linux-gnu` release archive over HTTPS, verifies SHA-256
  `e8bd57fd6517b5cf387a9c072ce79fdc069fc0b877c171b58e325b22e96c9000`
  before extraction, requires exact `railway 4.30.2` output, and publishes the
  binary path only after that check. This avoids the npm wrapper's unchecked
  postinstall binary download;
- the job-wide token aliases are gone. Configuration validation receives only
  the configured/unconfigured result for the dedicated
  `RAILWAY_PRODUCTION_PROJECT_TOKEN` secret. The actual value is mapped to the
  CLI-standard `RAILWAY_TOKEN` only on access verification, deployment, status
  polling, and post-deploy log inspection. `RAILWAY_API_TOKEN` is absent;
- the post-deploy step invokes
  `scripts/check-railway-timeout-regressions.js` directly instead of entering
  through npm lifecycle hooks; and
- `tests/railway-auto-deploy-supply-chain.test.js` inventories every
  secrets-context expression, requires the exact four credential-bearing
  steps, fixes every Action and CLI artifact identity, binds the complete
  download/checksum/extraction/version/PATH flow, and hashes the complete
  installer and token-bearing command bodies so appended commands cannot
  inherit trust or the token without explicit review.
  `docs/CI_CD.md` and `docs/RAILWAY_DEPLOYMENT.md` record the secret contract,
  immutable dependency flow, provider-scope prerequisite, and separately
  deferred controls.

Final local validation used the repository-required Node `v20.19.0`:

- focused Jest for the new supply-chain suite, coordinated-rollout guard,
  release-workflow pins, and Railway validator behavior: **passed**, 4 suites
  and 25 tests;
- `npm run type-check`: **passed**, including CEF, cycle, routing-boundary, and
  shared-package checks;
- `npm run lint`: **passed with 0 errors and 76 warnings**, all outside the A.2
  files; focused ESLint on the finalized new test also **passed** after
  adversarial hardening;
- `npm run build`: **passed**, including packages, workers, root TypeScript,
  alias repair/check, and asset copy;
- `npm run validate:railway`: **passed** without contacting or mutating
  Railway;
- `npm run docs:check`: **passed**, 294 checks with no failure or warning;
- `npm run docs:links -- --local-only`: **passed**, 165 local targets checked
  and 25 external URLs deliberately skipped;
- the workflow's install block passed `bash -n`; and
- `git diff --check`: **passed**.

Three independent adversarial reviews first identified false-green risks around
installer data flow, fail-open shell edits, alternate `secrets[...]` /
`toJSON(secrets)` syntax, and commands appended to credential-bearing steps.
The tests were strengthened to close each gap, and all three re-reviews found no
remaining in-scope A.2 defect.

This is step-scoped containment, not process-exclusive or arbitrary-ref trust:
the status step's Node subprocesses and the checked-in post-deploy script inherit
the step environment. Provider-side creation and verification of
`RAILWAY_PRODUCTION_PROJECT_TOKEN` as the intended project/environment token
remain an external deployment prerequisite. Deploy-checkout credential
persistence and a protected-environment/manual-ref topology remain the
separately ranked defense/settings decisions and were not changed. Live
workflow execution, Railway CLI calls, secret provisioning, and provider-side
scope inspection were **skipped** because external mutations and live execution
were not authorized. No database, memory, provider, Railway, production,
Git-index, commit, push, pull-request, deployment, release, or
external-settings mutation occurred. At that A.2 checkpoint, correction A.3
and every unrelated audit item remained untouched.

#### A.3 local implementation checkpoint — 2026-07-30

A.3 is implemented and validated locally, but it is not staged, committed,
merged, pushed, deployed, or exercised against a live application. Work
occurred in the dedicated
`C:\pbjustin\Arcanos-railway-readiness-drain` worktree on
`codex/railway-readiness-drain`, created from and reverified against
`origin/main` and remote `main` commit
`2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021` (tree
`7a0a9e7de5f75398050fe48bc217ac11963d2baf`). The A.1 and A.2 worktrees and the
historical dirty checkout were preserved; this report is the historical
checkout's only authorized A.3 edit. The A.3 worktree has 25 unstaged status
entries (22 tracked and three new files), with no package-manifest or lockfile
change.

Read-only Railway inspection before implementation confirmed the production
gap rather than assuming the tracked file described the live services. Both
the web and worker roles reported `/health`, timeout `300`, and disabled
teardown drain. Railway was not changed. Provider documentation and the
version-pinned CLI contract also established that the healthcheck is a
deployment-activation gate rather than continuous supervision, the platform
drain default is zero, config-as-code environment overrides take precedence,
and detached upload returns the exact deployment ID needed for attribution.

Characterization was deliberately red before each correction. The initial and
adversarial regressions proved that:

- tracked root and PR config used liveness activation and no drain budget;
- the web launcher and worker launcher could report ready without the intended
  role bootstrap boundary, while worker readiness depended on ordinary log
  output rather than a dedicated protocol;
- consumer-slot startup was not represented by one atomic all-slot barrier,
  and shutdown races could create a false ready transition;
- the workflow followed the service's latest deployment instead of the exact
  upload, buffered provider output, and lacked exact before/after attribution;
- the validator allowed provider-native drain-variable and named-environment
  overrides;
- the automatic and manual response verifiers accepted header lookalikes,
  unbounded or stalled input/body paths, redirects, and ambiguous targets; and
- the manual smoke helper changed local Railway environment selection and
  allowed an omitted public app origin.

The isolated correction is:

- `railway.json` configures `/readyz`, timeout `300`, and numeric
  `drainingSeconds: 60`. The validator requires those exact root values,
  constrains PR behavior, rejects readiness/drain redeclaration by every named
  environment, and rejects
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` throughout tracked runtime-variable
  maps;
- `scripts/start-railway-service.mjs` gives web and worker roles explicit
  no-store readiness state. Web shutdown turns readiness off before forwarding
  the signal. Worker readiness remains off until an exact stdout-only,
  newline-delimited bootstrap protocol reports the child ready; stderr,
  embedded marker-like text, log level, child failure, and shutdown races fail
  closed;
- `src/workers/jobRunner.ts` and `src/workers/jobRunnerRuntime.ts` emit that
  protocol only after database/autonomy/module-registry bootstrap, initial
  heartbeat, supported provider configuration, and every configured consumer
  slot's dispatcher-start write complete. Slot readiness is an atomic
  all-or-nothing barrier, and shutdown aborts provider work and prevents a late
  ready transition while preserving lease-based claim recovery;
- `.github/workflows/railway-auto-deploy.yml` captures the exact deployment ID
  from `railway up --detach --json`, polls deployment history for that ID, and
  requires it to be the active successful deployment immediately before and
  after verification. The selected service's variable projection streams
  directly into the bounded verifier under `pipefail`;
- `scripts/verify-railway-readiness-activation.mjs` verifies exact
  project/environment/service identity, rejects a conflicting live drain
  override, bounds standard input and response bodies, and requires a
  credential-free HTTPS `/readyz` request with no redirects, exact HTTP `200`,
  exact JSON media type, a bare `no-store` directive, and the role-specific
  response contract. A private worker retains the exact Railway activation
  result instead of gaining a public domain solely for this check;
- `scripts/railway-production-smoke-check.js` applies the same fixed readiness
  and bounded-response contract. It now fails before CLI access without an
  independently confirmed `--app-url`, requires that origin to belong to the
  selected app service, does not mutate local Railway link state, and
  explicitly scopes service reads to the named environment; and
- maintained API, configuration, CI, Railway, Redis, troubleshooting, script,
  and root guidance now distinguish liveness, dependency diagnostics,
  activation readiness, the platform drain ceiling, internal shutdown bounds,
  lease recovery, and the still-required measured rehearsal.

Three independent adversarial reviewers examined worker bootstrap/drain
semantics, exact deployment attribution, provider/config precedence, and the
automatic/manual verifier boundary. They initially found a concurrent
deployment-attribution window, substring-based header checks, incomplete named
environment containment, buffered variable JSON, the manual helper's local
environment mutation and ambient target, and documentation imprecision.
Characterization was strengthened and each finding was corrected. The final
re-reviews found no remaining local A.3 blocker.

Final local validation used the repository-required Node `v20.19.0`:

- focused Jest for launcher, worker runtime, route/live-harness, config,
  exact-deployment, activation-verifier, and adjacent fast-path behavior:
  **passed**, 8 suites and 149 tests;
- `npm run type-check`: **passed**, including CEF, cycle, routing-boundary, and
  shared-package checks;
- `npm run lint`: **passed with 0 errors and 76 pre-existing warnings**, none
  in the A.3 files; focused ESLint for the finalized JavaScript and tests also
  **passed**;
- `npm run build`: **passed**, including packages, workers, root TypeScript,
  alias repair/check, and asset copy;
- `npm run validate:railway`: **passed** without contacting or mutating
  Railway;
- `npm run docs:check`: **passed**, 294 checks with no failure or warning;
- `npm run docs:links -- --local-only`: **passed**, 165 local targets checked
  and 25 external URLs deliberately skipped;
- finalized script/test syntax checks and the deploy/wait workflow blocks'
  `bash -n` check: **passed**; and
- `git diff --check`: **passed**.

Production promotion is still open. A.2 and A.3 intentionally live in separate
worktrees based on the same `main` tree and both modify the deployment workflow.
Integration must preserve A.2's immutable Action/CLI identities and
credential-step containment, manually reconcile the workflow, and refresh
A.2's complete token-bearing step-body hashes. After an explicitly authorized
deployment, the exact effective web and worker values must each be read back as
`/readyz`, `300`, and `60`; then a measured deployment must exercise web
request cancellation, worker provider abort, lease-based claim recovery,
snapshot flush, database stalls, and the provider's termination deadline.
Those live checks were **skipped** because deployment and production mutation
were not authorized. No database, memory, provider, Railway, production,
Git-index, commit, push, pull-request, deployment, release, or
external-settings mutation occurred. Correction A.4 and every unrelated audit
item remain untouched.

#### A.1–A.3 draft-publication checkpoint — 2026-07-30

This checkpoint supersedes the earlier A.1, A.2, and A.3 Git-state statements;
their characterization and slice-specific validation evidence remains
historically accurate. After explicit user authorization to publish, the three
isolated corrections were integrated in the clean
`C:\pbjustin\Arcanos-repository-health-a1-a3-pr` worktree on
`codex/repository-health-a1-a3`, based on verified remote `main` commit
`2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021` (tree
`7a0a9e7de5f75398050fe48bc217ac11963d2baf`), as:

1. `da40f2a8` — `fix(jobs): restore no-store responses`
2. `26161339` — `ci(railway): contain deploy supply chain`
3. `5e4fb282` — `fix(railway): gate role readiness and drain`

The branch was pushed and initially opened as draft PR
[#1413](https://github.com/pbjustin/Arcanos/pull/1413), titled
“Harden job cache policy and Railway promotion gates”; it is now non-draft.
Before this report and
its documentation index were added, the clean integration diff contained
exactly those three commits and 32 implementation, configuration, test, and
maintained-documentation files, with no dependency-manifest or lockfile change.

The A.2/A.3 workflow overlap was reconciled explicitly. Immutable Action and
Railway CLI identities, checksum verification, and exactly four
credential-bearing steps were preserved. The A.3 wait step now invokes
`node scripts/validate-railway-compatibility.js` directly rather than invoking
an npm lifecycle under `RAILWAY_TOKEN`; none of the four credential-bearing
steps invokes npm. A.2's full credential-bearing step-body hashes were refreshed
against the composed workflow. Exact upload-deployment attribution, polling of
that deployment only, active-deployment bracketing around `/readyz` evidence,
role-aware worker activation, readiness-first shutdown, timeout `300`, and the
numeric `60`-second drain contract all remained intact.

Integrated validation used the repository-required Node `v20.19.0`:

- `npm ci`: **passed** without changing repository status; npm reported 16 high
  audit findings in the installed dependency graph, and this draft does not
  change dependencies;
- the first combined focused run, before shared packages had been built in the
  fresh worktree, passed 13 suites and 239 tests but failed one suite because
  `@arcanos/cli/client` was not yet resolvable; after the required package build,
  the same deliberately hostile inherited-environment matrix
  (`ALLOW_ALL_GPTS=true`, `TRUSTED_GPT_IDS=*`) **passed**, 14 suites and 243
  tests;
- `npm run type-check`: **passed**, including package builds and boundary
  checks;
- `npm run lint`: **passed with 0 errors and 76 pre-existing warnings**;
- `npm run build`: **passed**;
- `npm run validate:railway`: **passed** without contacting or mutating
  Railway;
- `npm run docs:check`: **passed**, 294 checks;
- `npm run docs:links -- --local-only`: **passed**, 165 local targets checked
  and 25 external URLs deliberately skipped;
- focused ESLint, Node syntax, workflow install/deploy/wait `bash -n`, and
  `git diff --check`: **passed**; and
- final adversarial integration validation: **passed**, 10 suites and 219
  tests.

The broad root suite did **not** pass completely. A completed parallel run
reported 557 passing suites, five skipped suites, one failing suite, 6,641
passing tests, 33 skipped tests, and one failing test:
`tests/gptoss-private-serving-durable-replay-migration-guard.test.ts`. The same
single expectation failure reproduced on the untouched clean audited base
worktree at commit `cd368d89cefd037e2dd8822c25fe4d84ebbab27a`, where that
focused suite reported seven passing and one failing test. Two diagnostic
serial retries timed out and their exact verified child processes were
terminated without leaving orphans. The failure is therefore recorded as
pre-existing and unrelated, not represented as a passing `npm test`.

Independent adversarial reviews of each slice and the final composed branch
found no remaining publication blocker. Git publication is the only external
state changed by this checkpoint. No deployment, release, Railway setting or
secret change, provider action, database operation, live-memory action, or
production mutation occurred. Production still reports the earlier effective
`/health`/disabled-drain state until an authorized deployment occurs. The
dedicated token-scope check, exact effective web/worker readback of `/readyz`,
`300`, and `60`, and the measured real drain rehearsal remain mandatory
promotion gates. Correction A.4 and every unrelated audit item remain
untouched.

#### Native PR contained-application E2E checkpoint — 2026-07-30

At the user's explicit request, the already-published draft PR was first
validated against its existing Railway-native preview without changing
Railway configuration. GitHub deployment evidence attributed both public
preview roles to exact PR head
`6c3cb52b21a3541357acea5265cbf4401e5de9f0` in environment
`Arcanos-pr-1413` (`73e443b6-a678-4315-8016-97f76825a432`):

- web deployment `1ba334c8-c6d6-4a54-9762-02ae6bf9db06` at
  `https://arcanos-v2-arcanos-pr-1413.up.railway.app`; and
- worker deployment `9132708a-d083-455d-9aa5-28365b1e24be` at
  `https://arcanos-worker-arcanos-pr-1413.up.railway.app`.

Twelve credential-free, read-only requests across liveness, readiness, and
unlisted routes **passed** with the expected passive-role bodies, status codes,
and `Cache-Control: no-store`. No redirect, cookie, authentication challenge,
or response-body disclosure was observed. This evidence proved the public
services serving that commit; it did not assert Railway control-plane
provenance beyond the independently checked GitHub deployment record.

That passive result was intentionally insufficient for application behavior.
The follow-up implementation therefore remains an isolated native-PR preview
slice in
`C:\pbjustin\Arcanos-pr-preview-application-containment` on
`codex/pr-preview-application-containment`, based on the exact published head
above. It replaces the native PR start override with the versioned
`--pr-preview-app-safe-v1` contract:

- the web launcher validates exact native-PR project, environment, service,
  deployment, source-commit, role, and public-domain identity before selecting
  a fixed `dist/start-native-pr-preview.js` child;
- that child receives an exact nine-name Linux environment rather than the
  parent environment, so database, Redis, provider, Railway, GPT-access,
  package-hook, proxy, and `NODE_OPTIONS` values do not cross the process
  boundary;
- the worker role remains passive;
- the contained web application imports the real generic status/result/cancel
  handlers through a dependency-injected router, but supplies only sealed,
  stateless synthetic fixtures and exposes an exact route/method allowlist;
- credential carriers, query strings, encoded paths, streams, bodies on reads,
  chunked/non-JSON/oversized cancellation bodies, and every unlisted
  application, memory, provider, diagnostic, control-plane, and worker route
  fail before routing;
- production `src/routes/jobs.ts` remains a thin adapter over the same router
  with the real repository, confirmation, actor, capability, metrics, and
  sleep dependencies; the pre-existing production route suite characterizes
  behavior parity;
- the build-blocking import checker uses an exact reviewed graph, binding-level
  high-impact built-in imports, listener ownership, a fixed preview-spawn AST
  contract, and mutation tests for unexpected modules, global network/timer
  effects, full-environment child spawn, extra listeners, and unsafe preview
  entrypoints; and
- the reusable E2E runner is dry-run by default, requires paired
  `--execute --allow-network`, exact independently confirmed PR hosts, the
  canonical repository root and `origin`, a completely clean tracked/untracked
  worktree, and local HEAD equality. It sends no credentials, follows no
  redirects, makes at most 50 sequential requests, and enforces request,
  response, aggregate-byte, and total-time limits.

The fixed 50-case contract covers both roles' health/readiness, denied surface,
exact success and failure payloads, pending and terminal states, result
lookups, repeat stateless cancellation, malformed-ID validation on status,
result, and cancellation, missing and unauthorized jobs, authorization
unavailability, lookup and cancellation repository failures, exact media
types, bounded-response declarations, `no-store`, and initial/final identity
stability. Readiness states the honest boundary:
`trustScope: trusted-pr-accidental-effects`,
`protectsMaliciousPr: false`, and
`requiresPlatformSecretIsolationForUntrustedCode: true`. Repository code cannot
protect inherited secrets from malicious PR code that can alter its own
launcher; fork or otherwise untrusted previews still require Railway/provider
secret isolation before code starts.

Final local validation used Node `v20.19.0`:

- focused production/preview Jest: **passed**, 5 suites and 131 tests;
- reusable runner contract: **passed**, 7 tests, with no network;
- `npm run type-check`: **passed**, including all boundary checks, the exact
  preview import gate, shared packages, and root TypeScript;
- `npm run lint`: **passed with 0 errors and 76 pre-existing warnings**;
- `npm run build`: **passed** after final hardening, including packages,
  workers, root TypeScript, aliases, and assets;
- `npm run validate:railway`: **passed** without Railway access or mutation;
- `npm run docs:check`: **passed**, 311 checks, and generated indexes were
  current;
- `git diff --check` and Node syntax checks: **passed**;
- an actual child-process sentinel tripwire plus six local launcher HTTP checks:
  **passed**; no parent secret or `NODE_OPTIONS` value reached or appeared from
  the contained child; and
- the complete runner against the actual compiled contained Express app and
  passive worker on loopback: **passed**, 50/50 checks and 10,648 aggregate
  response bytes.

Three adversarial reviewers examined the deployment/production adapter, the
runner/attestation contract, and import/runtime containment. Their findings
about partial payload checks, missing result/cancel validation, response media
types, dirty-worktree false attestation, ambient Git overrides, mutable fixture
proof, fail-open import growth, pre-entry loader coverage, CI wiring, Date
serialization, and launcher effect drift were reproduced and corrected. The
final reviews found no launch blocker.

The implementation was committed in the isolated worktree as
`dad3c00c836b72188843eb5cbebf82e2c7f30875` and cherry-picked onto the draft
PR branch as `8bbda94bb038a80612ed3adb7d44246ae893f9d2`, following audit-checkpoint
commit `a2813f2c`. The authorized push advanced the then-draft PR #1413 to that exact
head. GitHub deployment record `5685309669` then reached success for the
existing transient `Arcanos / Arcanos-pr-1413` environment. Exact commit
statuses identified successful web deployment
`53de1f9a-4846-4632-826c-f2001c45106a` and successful worker deployment
`dd4038c4-450e-4824-bb22-28c2a1a8b388`.

Both public readiness responses subsequently identified PR `1413` and source
commit `8bbda94bb038a80612ed3adb7d44246ae893f9d2`; the web reported
`native-pr-application-e2e-v1` with imported, sealed fixtures and protected
effects disabled, while the worker reported the expected passive role. The
runner's clean-exact-head no-network dry run **passed** with 50 requests
planned and zero attempted. The explicitly enabled live run then **passed
50/50** credential-free requests with 10,648 aggregate response bytes and
stable initial/final identity hashes. Its attestation remained honestly scoped
to served public identity and did not claim Railway control-plane provenance.

No Railway setting, variable, service, environment, database, provider,
memory, production, release, or manual deploy/redeploy control was mutated.
The authorized PR push triggered the repository's already-configured native
preview automation; all subsequent Railway and GitHub operations were
read-only observation plus the bounded public E2E requests.

Publication exposed one stale source-ownership pointer in the authoritative
GitHub `Lint & Type Check` job: `validate:backend-cli:contract` correctly
rejected the two generic job endpoints because
`contracts/backend_cli_contract.v1.json` still named the now-thin production
adapter instead of `src/routes/genericJobsRouter.ts`, where the route literals
and reusable handlers now live. A focused ownership test first reproduced that
failure. Updating only those two `tsRouteFile` fields made the focused test and
the real contract validator pass; the Python offline validator, sync check,
CEF/routing boundaries, type-check, native-preview import gate, and lint also
passed. This follow-up changes source ownership metadata and tests only; it
does not change a public contract shape or runtime behavior.

### PR #1413 merge-readiness remediation — workflow provenance

The post-publication merge-readiness review found that the privileged
`workflow_run` path trusted `head_branch == main` without proving a same-repo
push, checked out and executed the triggering head as rollout policy, and let
manual dispatch select another branch or tag. A fork PR whose source branch was
named `main` could therefore make untrusted policy code emit
`should_deploy=true`; an old queued or rerun event could also redeploy an
obsolete main commit.

The isolated correction now requires either an exact default-branch manual
dispatch or a successful same-repository push whose head SHA equals the
workflow's default-branch SHA. Policy code and the deploy ref are pinned to
that immutable SHA. After the deployment job acquires concurrency, but before
any Railway-token step, it reads the one exact live default-branch ref and
fails closed unless the live 40-hex SHA still equals the deploy ref. Fork,
pull-request, non-push, branch/tag dispatch, stale queued, and old rerun paths
are therefore rejected before production credentials or upload.

Characterization first failed on the untrusted policy checkout. The finalized
Node `v20.19.0` workflow suites **passed**, 3 suites and 22 tests; the new shell
body also passed `bash -n`. An independent adversarial review found the manual
ref and stale-event gaps, then the post-concurrency race, and approved the
final exact-ref guard with no remaining finding in this slice. No Railway,
production, deployment, variable, provider, database, memory, or release state
was read or mutated.

### PR #1413 merge-readiness remediation — detached deployment lifecycle

The release review then found two coupled production-gate defects. The
workflow used `railway up --detach --json` but observed the exact deployment
for only thirty ten-second attempts, no longer than the tracked five-minute
healthcheck allowance. It also configured
`cancel-in-progress: true`, so a newer GitHub run could terminate the observer
and post-deploy checks while Railway continued the already-created remote
deployment.

The isolated correction preserves detached upload because pinned Railway CLI
`4.30.2` returns the exact deployment ID in that mode. The production job is
now serialized without cancelling an active run and has a 60-minute job
limit. A fixed-purpose Node helper bounds upload to 10 minutes, observes the
exact ID against a monotonic 45-minute elapsed budget, limits every Railway
subprocess by time and output size, rejects duplicate IDs and unknown or
terminal statuses, and requires the exact active deployment to be
`SUCCESS` with `stopped === false` before and after readiness evidence. The
post-deploy log query is bounded to 30 seconds and 4 MiB. Its former Windows
`shell: true` fallback was removed.

The project token remains confined to the four reviewed Railway steps. Within
the combined observation/evidence step, token-independent validators run
under `env -u RAILWAY_TOKEN`; the observer, watchdog, variable-bearing
readiness verifier, and complete token-step bodies are normalized-SHA frozen
for explicit review. The helper uses only Node `20` built-ins and preserves
provider-compatible non-control environment names.

Characterization first failed on the missing helper, cancellable concurrency,
fixed-attempt loop, and absent watchdog bounds. The finalized Node `v20.19.0`
focused set **passed**, 5 suites and 77 tests. `npm run build`,
`npm run validate:railway`, focused ESLint, and `git diff --check` **passed**.
`npm run lint` **passed with 0 errors and 76 pre-existing warnings**.
`npm run docs:check` **passed** after this checkpoint with all 311 checks. Two
independent adversarial
reviewers reproduced the stale supply-chain contract, backward-clock,
environment-name, stopped-deployment, Windows-shell, and token-inheritance
gaps; all were reconciled, and both reviewers approved the final slice with no
remaining finding.

Detached remote work can still outlive an upload timeout before an ID is
returned, manual workflow cancellation, runner loss, or the 45-minute
observer budget. No safe exact-ID cancellation covers every Railway deployment
state, and `railway down` can target the wrong successful deployment, so those
cases remain documented operator-reconciliation obligations rather than an
unsafe cleanup mutation. No Railway, production, deployment, variable,
provider, database, memory, or release state was read or mutated.

At the start of this slice GitHub reported PR #1413 open, non-draft, and
mergeable at published head `a0c43cf6`; this supersedes earlier current-state
wording that still called the PR a draft. Other historical “draft-publication”
statements remain accurate for the time they describe. The remaining
merge-readiness findings are handled as separate corrections.

### PR #1413 merge-readiness remediation — reusable preview import/effect containment

Adversarial review of the reusable native-PR application-import gate found
that future otherwise-trusted changes could bypass its original syntactic
checks through capability aliases, mutable process carriers, rewritten spawn
inputs, transitive helper or constant drift, pre-validation import edges,
duplicated listeners, or output/readiness helper substitution. The issue was
in the reusable repository guard rather than an observed credential escape in
the current contained application.

The isolated correction now starts the compiled contained child directly,
without a loader hook, under the exact nine-name child environment. It
conservatively tracks mutable environment and argument values through aliases,
defaults, parameters, carriers, calls, iteration targets, legacy mutators, and
callback mutation paths. Reviewed process calls, listener owners, spawn inputs,
repository-root derivation, environment construction, readiness sources, and
output mirroring have exact declaration, occurrence, binding, argument, or
normalized AST/body contracts. The complete launcher and contained-child entry
files are additionally pinned by comment/format-normalized semantic digests,
so a semantic edit anywhere in either privileged entry requires a reviewed
digest and focused mutation-test update; harmless comments, formatting, and
line-ending changes remain accepted.

Final Node `v20.19.0` validation **passed**: the import-boundary suite passed
265/265; the three focused Jest suites passed 344/344; the credential-free,
no-network E2E harness passed 7/7; the real import/effect checker, focused
ESLint, `npm run type-check`, `npm run build`, `npm run validate:railway`,
`npm run docs:check` (311/311), and `git diff --check` all passed. Full
`npm run lint` passed with 0 errors and 76 pre-existing warnings. A local
loader-free compiled child first rejected the intentionally invalid
`HOST=127.0.0.1` setup and then passed with the exact `HOST=0.0.0.0` contract:
`/readyz` returned `200`, `Cache-Control: no-store`, `ready: true`, and the
expected contained mode before clean shutdown.

Three independent final reviewers reported no blockers. Their additional
adversarial matrices rejected all 42 tested child-import/listener,
launcher-root, and worker-output mutations while accepting seven harmless
comment/format controls. The implementation and audit checkpoint were
committed as `0b35bb16cc89f23a7c1b889213ad9240fc1cc5c5` and published to
PR #1413. That authorized GitHub push started the repository's existing
transient native-preview automation; no Railway control-plane command, manual
deployment/redeployment, setting or variable change, production action,
provider, database, memory, or release mutation was performed. Subsequent
GitHub review/thread and check observations were read-only.

## Commit appendix

### PR #1408 — 17 commits

1. `035de35a` — feat(gpt-access): add productivity and local-agent capabilities
2. `8678d16a` — fix(protocol): tolerate platform line endings in catalog check
3. `bf8ac3bd` — fix(local-agent): expose system admin tools in sandbox build
4. `5622d960` — fix(local-agent): separate requester and executor principals
5. `f52c95ca` — fix(local-agent): preserve patch stdin line endings
6. `f7948271` — fix(preview): invoke Railway CLI safely on Windows
7. `a1357af4` — fix(preview): align readonly verifier with public contracts
8. `8b9dada1` — docs(preview): record local-agent e2e evidence
9. `a92b0d75` — fix(gpt-access): satisfy Builder description limits
10. `770d0acb` — fix(gpt-access): align capability response schemas
11. `b2821e80` — docs(preview): finalize local-agent E2E evidence
12. `77d6e6c9` — docs(preview): anchor final deployed evidence
13. `87788342` — fix(local-agent): close merge-readiness risks
14. `a3d2251f` — fix: close merge-readiness security gaps
15. `0808eb1f` — test(local-agent): stabilize expiry clock assertion
16. `f7f3a2ca` — ci: require preview safety harness
17. `b20356c5` — docs: record PR merge readiness review

### PR #1409 — 32 commits

1. `d5b2186b` — fix: harden control-plane and runtime boundaries
2. `07095b48` — fix: harden GPT access sanitization and scripts
3. `d27d2e7a` — fix: harden sanitization routing and cycle checks
4. `d93c6ffc` — fix: normalize OpenAI Responses semantics
5. `570f80d9` — fix: enforce exact-origin CORS policy
6. `0d200839` — fix: harden AI response and failure semantics
7. `3315d3b5` — fix: sanitize public health diagnostics
8. `f58527e9` — fix: bound public queue diagnostics
9. `a51988c1` — fix: secure Custom GPT bridge health and errors
10. `3bf2123b` — docs: record public boundary hardening
11. `b45c13ef` — fix: contain legacy status failures
12. `ff0b6eeb` — fix: harden system-state and RAG control-plane access
13. `91428b07` — fix: secure DAG control-plane access
14. `4bb9c28b` — fix(security): patch vendored brace expansion
15. `b4187043` — fix(release): gate publication on validated source
16. `6a485a7c` — fix(self-improve): remove shell and path injection
17. `3169bfe1` — fix(cef): secure execution ingress and routing
18. `bf52947a` — fix(cef): require challenge-bound execution permits
19. `a7611fb3` — fix(reinforcement): secure HTTP ingress
20. `e6eb1b51` — fix(reinforcement): isolate prompt trust context
21. `975ef762` — fix(afol): secure decision and inspection routes
22. `12b46d4a` — fix(afol): minimize and serialize persisted records
23. `25a745a3` — fix(assistants): secure registry access and synchronization
24. `e42687d4` — fix(db): restrict retries to audited transient reads
25. `3b2f481e` — fix(jobs): fence claimed worker mutations
26. `33dc44e9` — fix(db): make collation checks passive
27. `1fa9b57e` — fix(db): serialize schema initialization
28. `7b174788` — fix(dag): fence persisted run snapshots
29. `0f114ecf` — fix(dag): harden lifecycle and cancellation
30. `fb2ccce5` — fix(ci): restore startup and coverage gates
31. `a183b04c` — fix: close merge-readiness blockers
32. `f932fc52` — fix: close final merge-readiness gaps

### PR #1410 — 2 commits

1. `ccb18b71` — security(deps): remove expired audit waivers
2. `aec39397` — test(mcp): isolate HTTP transport entrypoint load

### PR #1411 — 5 commits

1. `61c73816` — fix(memory): harden request containment
2. `1e06fe52` — docs(security): align memory containment contract
3. `286a9163` — fix(memory): isolate prompt extraction prototype
4. `0859697c` — chore(ci): retrigger Railway PR preview
5. `72521721` — fix(preview): accept current Railway PR names

### PR #1412 — 6 commits

1. `8c811160` — Contain public worker diagnostics and secure job continuations
2. `5dc8ddee` — Fix job capability CI fixtures
3. `ade1388f` — Provide job read key to startup CI
4. `80ad4b70` — Add isolated worker diagnostics E2E proof
5. `7810ab71` — Harden Railway cleanup credential scope
6. `cd368d89` — Keep degraded worker aggregates consistent

## Canonical references

- [Changelog](../../../../CHANGELOG.md)
- [Documentation index](../../../README.md)
- [CI/CD](../../../CI_CD.md)
- [Database and migrations](../../../DATABASE_MIGRATIONS.md)
- [Railway deployment](../../../RAILWAY_DEPLOYMENT.md)
- [Local-agent capability bridge](../../../LOCAL_AGENT_CAPABILITY_BRIDGE.md)
- [Preview E2E report](../../../PREVIEW_E2E_REPORT.md)
- [PR #1408 merge readiness](../../../MERGE_READINESS.md)
- [Deprecation register](../../../../DEPRECATION.md)
