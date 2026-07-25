# Local Agent Review — PR 1408

## Review identity

- Review round: 2
- Reviewer: independent Local Agent reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed PR head: `87788342f862d59c60fa3ea830da47c39950dabf`
- Candidate reviewed: the PR head plus the uncommitted, architecture-preserving
  Round 2 hardening in the shared review worktree
- Scope: all 111 files in the pull-request diff, including TypeScript and
  Python source, generated contracts, tests, SQL and compensation, maintained
  documentation, CI, Railway configuration, preview tooling, and deployment
  evidence
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.93)**
- Open Critical findings: **0**
- Open High findings: **0**

This verdict requires the reviewed remediation to be committed and the exact
resulting commit to pass fresh CI and isolated preview validation. It does not
approve a production deployment or the use of an unsandboxed local agent on a
machine containing sensitive data.

## Executive assessment

The implementation preserves the required authority and execution boundary:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript identity, tenancy, contracts, policy, confirmation,
     persistence, jobs, audit, and tracing
  -> existing PostgreSQL job lifecycle
  -> private outbound-only Python daemon
  -> fixed typed handler
  -> bounded structured result
  -> tenant-bound /gpt-access job-result endpoint
```

The Python daemon does not expose a public GPT API, connect directly to
canonical PostgreSQL state, create another queue or workflow engine, implement
a generic shell action, duplicate GPT Access authorization, or route
operations through `/gpt/:gptId`. `ARCANOS:LOCAL_AGENT` remains distinct from
`ARCANOS:PRODUCTIVITY` and is protected from legacy module routes.

The Local Agent implementation is production-capable when the daemon runs
against a private registered workspace with `tests.run` in the containerized
`sandboxed` mode. The capability registry, server-created job envelope,
dedicated executor identity, atomic claim semantics, database-enforced
idempotency, per-job expiry handling, result ownership checks, fixed command
profiles, path and secret controls, patch confirmation, and structured output
limits are internally consistent.

This review independently reproduced and resolved two High findings:

1. generic MCP `jobs.status` and `jobs.result` lookups could return
   local-agent jobs by UUID without the tenant-bound GPT Access result policy;
2. Windows NTFS alternate data streams could bypass ordinary path and secret
   filename controls through colon-bearing repository or patch paths.

Both are closed in the reviewed candidate with fail-closed boundary checks and
focused regression tests. No Critical or High Local Agent finding remains
open.

## Independent review coverage

The reviewer did not rely on another reviewer's coverage. The complete PR
inventory and current remediation diff were inspected across the following
areas:

- the TypeScript capability catalog, schemas, generated Python catalog,
  metadata, OpenAPI publication, protected module registration, and legacy
  route isolation;
- GPT Access authentication, trusted principal/workspace derivation, action
  allowlists, device scopes, direct-capability-only restrictions, exact
  confirmation binding, one-time challenge consumption, idempotency, and
  tenant-bound result polling;
- the dedicated local-agent executor audience, narrow endpoint scopes,
  device/instance binding, token rotation, revocation, heartbeat, atomic
  claim, lease renewal, result submission, and recovery;
- PostgreSQL job uniqueness, separate-connection concurrency behavior,
  replay/conflict semantics, expiry reconciliation, per-job event
  granularity, savepoint isolation, outbox/audit correlation, indexes,
  migration ordering, verifier, and compensation;
- the Python outbound poller, handler registry, protocol validation,
  expiration and allowlist checks, journal, crash recovery, uncertain mutation
  quarantine, and result sanitation;
- workspace registration, root resolution, path normalization, secret denial,
  symlink/reparse rejection, descriptor-safe reads, Git repository validation,
  Git configuration hardening, output control-sequence filtering, and
  repository search;
- fixed `git`, test, and patch command profiles; patch parsing, preview,
  authorization hash binding, application, rollback backup, manual
  reconciliation, and rejection of binary, symlink, gitlink, submodule,
  nested-repository, secret, traversal, and alternate-data-stream targets;
- the `disabled`, `sandboxed`, and
  `unsandboxed-development-only` test execution modes, including the
  non-root/read-only/no-network/no-socket/capability-dropped/resource-bounded
  container profile and immutable image requirement;
- all changed TypeScript, Python, migration, preview-validator, and deployment
  tests;
- environment examples, API and configuration documentation, database and
  migration documentation, local-agent setup and security review,
  `PREVIEW_E2E_REPORT.md`, CI workflows, Railway startup configuration, and
  the passive preview verifier.

## Architecture review

### Public authority

TypeScript remains authoritative for all public contracts and security
decisions. The public action metadata includes the action ID, description,
execution target, input and output schemas, risk, confirmation requirement,
idempotency behavior, timeout, required device scopes, read-only status, and
file-mutation status. Generated catalog parity prevents Python from defining a
competing protocol.

Caller-supplied payloads cannot select principal, workspace, device,
repository root, authorization decision, or confirmation state. The backend
constructs those fields from authenticated context and registered device
state. Python receives only a server-authorized execution job.

### Execution and queue reuse

Local-agent work uses the existing durable job lifecycle. It does not add a
second queue or ActionPlan implementation. Claims are atomic and
device-scoped; expired, completed, or already-claimed jobs fail closed.
Heartbeats, result submission, duplicate-result handling, recovery, and audit
attribution use the dedicated local-agent protocol endpoints.

### Python boundary

The daemon is outbound-only. It polls or posts to authenticated backend
endpoints and has no inbound public listener for Custom GPT Actions. Handler
dispatch is limited to the generated catalog and fixed registry. The current
CLI/voice surfaces and backend jobs reuse the same Python handler
implementations rather than maintaining duplicate repository, Git, test, or
patch logic.

### Productivity separation

No repository, Git, command, test, or patch capability was placed inside
`ARCANOS:PRODUCTIVITY`. Productivity remains a TypeScript-owned domain module,
while the local agent remains a separately protected device-execution module.

## Security review

### Authentication and device authority

Local-agent executors use a dedicated `local-agent-protocol` audience and
narrow heartbeat, claim, job-heartbeat, result, and recovery scopes. The
credential is bound to a registered device and instance, supports current and
previous-key rotation, supports revocation, and is separately attributed in
audit data. Reusing that credential as a GPT Access user credential fails
closed.

### Confirmation

Both `tests.run` and `patch.apply` are privileged, direct-capability-only
actions. They require a consumed GPT Access challenge bound to the
authenticated actor, principal, workspace, HTTP method, route, exact action,
and canonical payload. The retry changes only the top-level
`confirmation_token`; action or payload mutation invalidates the challenge,
and replay is rejected. The daemon never accepts a model-supplied
confirmation flag.

The Round 2 documentation now describes this behavior for both actions rather
than incorrectly singling out `patch.apply`.

### Workspace and file controls

Registered roots are resolved locally. Path handling rejects absolute paths,
traversal, paths outside the registered workspace, secret files, symlink or
reparse escapes, and colon-bearing path components on every platform. The
colon rule prevents Windows NTFS alternate data streams such as
`normal.txt:stream`, `.env:hidden`, and `::$DATA` from bypassing filename
policy.

POSIX reads walk from already-open directory descriptors with no-follow
semantics and verify the opened object. Windows performs normalization and
pre/post-open reparse and identity checks, with the documented limitation that
Python does not provide an equivalent descriptor-relative Win32 directory
walk.

Git operations require a physical standalone `.git` directory, validate
reported worktree and metadata locations, reject linked worktree/submodule
metadata, deny alternates and executable configuration, sanitize the
environment, and force protective Git configuration including
`core.protectNTFS=true`.

### Process and output controls

There is no generic shell capability. The daemon constructs fixed executable
and argument arrays, uses sanitized environments, enforces deadlines and
process-tree termination, and bounds output. ANSI and control sequences,
binary or oversized diffs, and secret-bearing output are sanitized or
rejected before result upload.

### Test sandbox

`tests.run` defaults to `disabled`. The production-capable mode is
`sandboxed`, using a disposable non-root container with:

- a read-only base filesystem and source input;
- only a temporary workspace writable by the test;
- no host socket, privileged mode, or inherited secret environment;
- dropped capabilities and no-new-privileges;
- disabled network access;
- CPU, memory, process-count, disk, execution-time, and output limits; and
- cleanup after completion, timeout, cancellation, or crash.

`unsandboxed-development-only` is separately gated and must remain disabled on
machines containing sensitive data. Environment sanitation by itself is not
treated as a sandbox.

## Job, database, and lifecycle review

The additive hardening migration creates database-enforced uniqueness for the
logical local-agent job scope. Tenant, workspace, device, action, and
idempotency-key scope is explicit. A repeat with the same canonical
fingerprint returns the original job or result; a reused key with a different
fingerprint returns a conflict. Advisory locking may reduce contention but is
not the authoritative uniqueness mechanism.

Job claims and results use one-time/terminal-state checks. Every expired job
receives its own state transition and event/audit context. Batch expiry uses
savepoint isolation so a failed candidate does not collapse successfully
reconciled jobs. Manual reconciliation is retained for uncertain mutation
outcomes rather than guessing whether a patch was safely applied.

The SQL is additive and ordered, includes supporting indexes and constraints,
has a verifier and preview-empty compensation path, and is documented for
preview-only application. No migration was applied by this reviewer.

## Findings and dispositions

| ID | Severity | Status | Finding and disposition |
| --- | --- | --- | --- |
| LA-R2-01 | High | **Resolved** | Generic MCP `jobs.status` and `jobs.result` called `getJobById` and could disclose local-agent job state or result by UUID outside the tenant-bound GPT Access result path. Both tools now return indistinguishable not-found errors for `job_type = 'local-agent'`, with focused status/result tests. Generic latest/failed/queue/worker/diagnostic surfaces also exclude or redact local-agent rows. |
| LA-R2-02 | High | **Resolved** | Colon-bearing paths allowed Windows NTFS alternate data streams to bypass normal repository and secret-file policy. TypeScript contracts, generated catalogs, Python workspace resolution, descriptor-safe reads, repository search, patch validation, and the CLI bridge now reject colon path components. Regression tests cover ordinary and secret ADS paths. |
| LA-R2-03 | Low | **Resolved** | The otherwise unused `RegisteredWorkspaceRegistry.resolve_relative` helper lacked the same ADS rule, leaving a future footgun. It now rejects colon path components, and protocol-runner tests cover ordinary and secret ADS forms. |
| LA-R2-04 | Low | **Resolved** | Documentation described exact consumed-challenge semantics for `patch.apply` but not `tests.run`. The setup and security documents now state that both actions require exact, one-time challenge binding. |
| LA-R2-05 | Low | **Resolved** | Adding confirmation tests pushed the gateway suite past a module-scoped rate-limit bucket, causing deterministic 429 failures and stranding a one-shot database mock that produced a secondary 501. The test harness now gives each `buildApp()` instance a unique socket identity while preserving same-app rate-limit tests and explicit trusted-proxy identities. The full gateway and unsafe-execution suites pass. Production rate limits were not weakened. |
| LA-R2-06 | Medium | **Accepted residual** | `patch.apply` cannot be descriptor-atomic against a hostile concurrent local writer. It revalidates roots and repository identity, binds the authorized patch hash, checks links before and after, keeps backups, and quarantines uncertain outcomes, but those controls cannot make a third-party patch utility transactional. Keep daemon workspaces private to the daemon account and use manual reconciliation for uncertainty. A descriptor-relative transactional patch writer would be an architectural expansion and is deferred for human acceptance. |
| LA-R2-07 | Operational condition | **Open until final validation** | The checked-in preview report and successful PR checks describe an earlier committed candidate. Round 2 fixes are currently in the shared worktree. Commit them, run required CI on the exact new head, deploy that exact commit only to an isolated preview, and refresh the evidence before changing the PR from Draft. |

## Validation evidence

### Commands executed and passed

| Command or group | Result |
| --- | --- |
| `python -m pytest daemon-python/tests/test_local_agent_handlers.py daemon-python/tests/test_local_agent_protocol_runner.py daemon-python/tests/test_local_agent_sandbox_security.py -q` | 80 passed, 11 skipped at the initial focused review point |
| `python -m pytest daemon-python/tests/ -q` | 546 passed, 18 skipped |
| `python -m pytest daemon-python/tests/test_local_agent_protocol_runner.py -q` after the registry-helper hardening | 29 passed, 1 expected Windows symlink-privilege skip |
| Local Agent TypeScript module, service, protocol, device, repository, migration, MCP, worker, diagnostics, OpenAPI, router, and isolation suites | 14 suites, 106 tests passed in the first focused groups |
| Additional changed TypeScript suites | 12 suites, 230 tests passed |
| Productivity suites, inspected independently for module separation and shared gateway behavior | 5 suites, 76 tests passed during this review point |
| `node scripts/run-jest.mjs --testPathPatterns=gpt-access-gateway --testPathPatterns=transport-unsafe-execution-gate --coverage=false --runInBand --silent` after test-harness isolation | 2 suites, 181 tests passed |
| `node scripts/generate-local-agent-capability-catalog.mjs --check` | Passed |
| `npm run validate:backend-cli:contract` | Passed |
| `npm run validate:backend-cli:offline` | Passed |
| `npm run sync:check` | Passed with 0 errors, 0 warnings, and 5 informational pre-existing items |
| `npm run type-check` on the current review worktree | Passed, including package builds and boundary checks |
| `npm run lint` on the current review worktree | Passed with 0 errors and 84 pre-existing warnings |
| `npm run build` on the current review worktree | Passed, including packages, workers, root TypeScript, alias verification, and assets |
| `npm run validate:railway` | Passed |
| `npm run test:preview-e2e` | 18 of 18 preview-validator tests passed |
| `npm run db:local-agent-hardening:plan` | Passed; manifest/checksum and migration plan verified without applying SQL |
| `git diff --check` | Passed; only line-ending conversion notices were reported |

### External CI evidence inspected

The committed PR head had successful checks for the root test matrix, lint and
type checking, documentation, build, approval gate, security audit, Linux
Local Agent sandbox, PostgreSQL Local Agent concurrency, Node 20.19 build,
unit/integration tests, convergence, Python CLI on Windows, Railway
compatibility, deployment readiness, and the final check aggregator.

Those results support the implementation but do not substitute for rerunning
the same required checks after the Round 2 remediation is committed.

### Skipped or not executed locally

- Docker was not installed in this Windows review environment, so the
  container E2E sandbox suite was not executed locally. The existing committed
  Linux CI evidence was inspected; fresh Linux CI remains a final condition.
- PostgreSQL migration application and separate-connection integration were
  not executed against a live database by this reviewer. The migration plan,
  unit tests, PostgreSQL integration test source, and existing successful CI
  evidence were inspected; fresh PostgreSQL CI/preview evidence is required.
- No Railway resource, variable, migration target, deployment, domain, or
  preview service was mutated by this reviewer.
- No production or preview Custom GPT configuration was changed.
- No privileged `tests.run` or `patch.apply` action was executed against a
  non-disposable repository.

## Residual risks and conditions

1. **Exact final commit:** commit all reviewed source, test, generated catalog,
   migration-documentation, and review-artifact changes before readiness.
2. **Fresh CI:** the exact final commit must pass the required Linux sandbox,
   PostgreSQL concurrency, Windows Python, build, type-check, lint, security,
   documentation, Railway, and aggregate gates.
3. **Fresh isolated preview:** deploy only that commit to an environment proven
   independent from production and the Phase 2E Redis validation service.
   Re-run API, daemon, productivity, local-agent, confirmation, idempotency,
   expiry, ambiguity, stale-state, audit, trace, offline, and recovery cases,
   then update `docs/PREVIEW_E2E_REPORT.md`.
4. **Sandboxed production mode:** keep
   `ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS=false` and require
   `sandboxed` mode with a verified immutable image for production-capable
   `tests.run`.
5. **Private daemon workspace:** do not permit hostile local writers in a
   registered workspace while `patch.apply` runs. Retain backups and manual
   reconciliation for uncertain mutation outcomes.
6. **Windows path limit:** accept the documented pre/post reparse validation
   limitation or provide an OS-native descriptor-equivalent implementation in
   a future, separately reviewed change.
7. **Operational cleanup:** monitor retained reconciliation/journal rows and
   apply explicit, audited cleanup rather than deleting uncertain records
   automatically.

## Merge recommendation

**APPROVE WITH CONDITIONS.**

The Local Agent architecture, security boundary, database lifecycle, Python
runtime, tests, migration, documentation, and deployment tooling are suitable
for the PR to become Ready for Review after the current remediation is
committed and the exact resulting commit completes fresh CI and isolated
preview validation. No Critical or High Local Agent finding remains open.

Do not merge the PR as part of this review, do not deploy to production, and
do not enable unsandboxed test execution on a machine containing sensitive
data.
