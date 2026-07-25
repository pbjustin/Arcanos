# Security Review — PR 1408

## Review identity

- Review round: 2
- Reviewer: independent security reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed PR head: `87788342f862d59c60fa3ea830da47c39950dabf`
- Candidate reviewed: the PR head plus the uncommitted, architecture-preserving
  Round 2 hardening in the shared review worktree
- Scope: all 111 changed files, including source, generated protocol artifacts,
  tests, migrations and compensation, documentation, CI, Railway configuration,
  preview tooling, and deployment evidence
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.92)**
- Open Critical findings: **0**
- Open High findings: **0**

The Round 2 fixes described below must be captured in the final candidate
commit and that exact commit must complete the required preview validation
before the PR is made Ready for Review. The verdict does not approve a
production deployment.

## Executive assessment

The implementation preserves the intended authority boundary:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript authentication, tenancy, contracts, policy, confirmation,
     persistence, jobs, audit, and tracing
  -> existing PostgreSQL job lifecycle
  -> private outbound-only Python daemon
  -> fixed typed handler
  -> correlated bounded result
  -> tenant-bound /gpt-access job-result endpoint
```

No Python public API, direct Python PostgreSQL ownership, second queue, second
workflow engine, generic shell capability, parallel authentication system,
legacy module exposure, or `/gpt/:gptId` execution path was found.

The review reproduced and resolved four material Round 2 issues:

1. an unauthenticated SDK diagnostics path could disclose raw local-agent job
   material;
2. generic MCP job tools could disclose a local-agent result by UUID;
3. Windows alternate data streams could be created through patch handling;
4. Windows alternate data streams could be read through `repo.search`.

The first two were High findings because local-agent input or output can contain
private repository material. They are resolved by denying local-agent rows at
the generic repository, worker, diagnostics, and MCP boundaries and by adding
focused regression tests. The ADS findings are resolved by rejecting colon
syntax at the TypeScript contract, Python workspace-path, descriptor-safe file
open, and patch-policy layers, while forcing and validating
`core.protectNTFS=true`.

## Review method and coverage

The reviewer independently:

- inventoried the complete PR diff and all 111 changed files;
- inspected every changed-file category without assuming another reviewer
  covered overlapping behavior;
- reviewed GPT Access authentication, capability metadata, exact confirmation
  binding, challenge consumption, replay behavior, result polling, route
  isolation, and OpenAPI exposure;
- reviewed local-agent executor authentication, audience and scope separation,
  device registration, heartbeat, claim, lease, result, expiry, recovery,
  idempotency, and audit correlation;
- reviewed generic job routes, worker controls, MCP tools, system diagnostics,
  queue summaries, and recovery/cleanup paths for authority leaks;
- reviewed the Python handler registry, protocol runner, local journal,
  workspace registry, Git validation, patch validation/application,
  repository search, process execution, output sanitation, secret denial,
  symlink/reparse handling, and test sandbox;
- reviewed productivity schemas, lifecycle enforcement, tenancy derivation,
  confirmation policy, persistence, idempotency, events, and protected routing;
- reviewed all migration and compensation SQL, migration tooling, CI jobs,
  Railway configuration, preview verifier, preview report, and maintained
  security/setup documentation;
- ran focused TypeScript and Python security suites, broader capability and
  boundary suites, type checking, lint, build, protocol parity, migration
  planning, and passive Railway validation.

## Round 1 finding dispositions

| Round 1 concern | Disposition | Security evidence |
| --- | --- | --- |
| Git metadata, linked worktrees, alternates, local configuration, hooks, filters, or submodules could escape the registered workspace | Resolved with a documented compatibility limit | `daemon-python/arcanos/local_agent/secure_fs.py` requires a physical standalone `.git` directory, validates the reported worktree, git/common/object directories and alternates, rejects linked metadata and executable configuration, forces safe Git config, and revalidates repository identity. Linked worktrees and submodule roots using `.git` files fail closed. |
| Generic `/jobs/*` routes could reveal or control local-agent jobs | Resolved | Generic status, result, cancellation, streaming, worker claim, stale recovery, failed-job requeue, and cleanup paths exclude `job_type = 'local-agent'`. Tenant-bound reads remain under GPT Access. |
| `tests.run` did not have the same strict confirmation semantics as `patch.apply` | Resolved | Both mutating actions require direct capability execution and a one-time consumed challenge bound to authenticated actor, principal, workspace, method, path, exact action, and exact payload. Changes to the body or action invalidate the challenge, and replay fails closed. |
| Local-agent credentials shared broader ActionPlan executor authority | Resolved | Local-agent credentials use the separate `local-agent-protocol` audience, dedicated executor role, narrow heartbeat/claim/job-heartbeat/result scopes, device and instance binding, current/previous-key rotation, revocation, and timing-safe verification. |
| Advisory locks were the only logical-job idempotency boundary | Resolved | The additive `local_agent_job_idempotency` relation provides database-enforced tenant/device/action/key and job uniqueness. Same canonical requests return the original logical job/result; conflicting fingerprints fail closed. |
| Expiry reconciliation did not provide equivalent per-job observability | Resolved | Each expired job receives its own state transition and transactional event/audit context. Savepoint isolation prevents one failed candidate from collapsing the successful candidates. |
| Sanitized environment variables were being treated as a test sandbox | Resolved | `tests.run` has explicit disabled, sandboxed, and development-only modes. The production-capable mode uses a non-root disposable container, read-only base/source mounts, writable temporary workspace only, no network or host socket, dropped capabilities, no-new-privileges, bounded CPU/memory/PIDs/disk/time/output, sanitized environment, and fail-closed runtime checks. |
| Symlink and path validation lacked Linux execution evidence | Resolved for the required preview/CI environment; conditional residual remains on Windows | Linux container/CI evidence exercises descriptor-safe symlink and race cases. Windows uses pre/post reparse checks and dedicated tests but cannot provide a fully descriptor-relative directory walk through the Python standard library. |
| Python might become a competing public or data authority | Resolved | Python remains outbound-only, has no public listener for GPT Actions, does not connect to canonical PostgreSQL state, receives only server-created jobs, and exposes only the fixed handler catalog. |
| Productivity could inherit model-supplied tenancy or legacy routing | Resolved | Trusted execution context supplies principal/workspace; schemas reject authority aliases; writes are confirmation-gated; and `ARCANOS:PRODUCTIVITY` remains GPT-Access-only with legacy exposure disabled. |

## Round 2 findings and dispositions

### SEC-R2-001 — SDK diagnostics could expose raw local-agent job data

- Original severity: **High**
- Confidence: **high**
- Status: **resolved in the candidate worktree**

`GET /sdk/diagnostics` is not independently authenticated. Its latest-job
projection previously inherited raw job input/output and could select a
`local-agent` row. A recent local-agent result can include repository search,
diff, test, or patch material.

The fix is defense in depth at both sources:

- `getLatestJob`, queue summary, failed-job, detail, recovery, and cleanup
  repository queries exclude `job_type = 'local-agent'`;
- `runSystemDiagnostics` rejects local-agent rows again and projects only
  bounded metadata (`id`, `worker_id`, `job_type`, status, and timestamps),
  never raw job input or output;
- focused tests verify the repository and diagnostics boundary.

Evidence:

- `src/core/db/repositories/jobRepository.ts:1339`
- `src/core/db/repositories/jobRepository.ts:1612`
- `src/core/db/repositories/jobRepository.ts:1834`
- `src/core/db/repositories/jobRepository.ts:2056`
- `src/platform/logging/systemDiagnostics.ts:288`
- `tests/job-repository.local-agent-boundary.test.ts`
- `tests/system-diagnostics-local-agent-boundary.test.ts`

### SEC-R2-002 — Generic MCP job tools could disclose a local-agent result by UUID

- Original severity: **High**
- Confidence: **high**
- Status: **resolved in the candidate worktree**

Generic MCP `jobs.status` and `jobs.result` accepted a local-agent job UUID and
returned protected job state or output without the GPT Access
principal/workspace boundary.

The tools now return the same generic `ERR_NOT_FOUND` response used for an
unknown job when the row is local-agent-owned. Worker detail/summary paths
apply the same exclusion, and focused regression tests cover status, result,
detail, summary, and ordinary non-local jobs.

Evidence:

- `src/mcp/server/jobTools.ts:17`
- `src/mcp/server/jobTools.ts:31`
- `src/mcp/server/jobTools.ts:59`
- `src/services/workerControlService.ts:1066`
- `tests/mcp-job-tools.test.ts`
- `tests/worker-control-service.test.ts`

### SEC-R2-003 — Patch handling allowed Windows alternate data stream targets

- Original severity: **Medium**
- Confidence: **high**
- Status: **resolved in the candidate worktree**

On Windows, an exact-authorized `patch.apply` could create
`normal.txt:stream` while leaving the ordinary file and ordinary backup view
unchanged when repository configuration disabled NTFS protection. The reviewer
reproduced that behavior against a disposable repository before the fix.

Patch validation now rejects a colon in every path segment on all platforms.
The fixed Git argument set forces `core.protectNTFS=true`, repository validation
rejects a local setting that disables it, and the TypeScript CLI bridge applies
equivalent patch policy. Tests cover ordinary, secret-looking, nested, and
`::$DATA` stream forms, plus a repository with an explicit false setting.

Evidence:

- `daemon-python/arcanos/local_agent/secure_fs.py:215`
- `daemon-python/arcanos/local_agent/secure_fs.py:385`
- `daemon-python/arcanos/local_agent/secure_fs.py:501`
- `daemon-python/tests/test_local_agent_handlers.py:583`
- `daemon-python/tests/test_local_agent_handlers.py:857`
- `tests/gpt-access-gateway.test.ts:1828`

### SEC-R2-004 — `repo.search` allowed explicit Windows alternate data stream reads

- Original severity: **Medium**
- Confidence: **high**
- Status: **resolved in the candidate worktree**

The reviewer independently reproduced `repo.search` reading
`normal.txt:stream`. With `includeHidden=true`, `.env:stream` also bypassed the
ordinary secret-name predicate because the stream suffix changed the apparent
path.

The TypeScript public contract now rejects any colon in a repository-relative
path. Python rejects it during workspace resolution and again in the
descriptor-safe file opener. The generated TypeScript/Python capability
catalogs were regenerated and parity-checked. Cross-platform tests cover
stream syntax, and a Windows-specific test creates a real ADS and proves that
it cannot be read.

Evidence:

- `src/services/localAgent/contracts.ts:180`
- `daemon-python/arcanos/protocol_runtime/tools/repository_tools.py:637`
- `daemon-python/arcanos/local_agent/secure_fs.py:497`
- `daemon-python/tests/test_local_agent_handlers.py:247`
- `daemon-python/tests/test_local_agent_handlers.py:270`
- `daemon-python/tests/test_local_agent_sandbox_security.py:342`
- `tests/local-agent-module-contract.test.ts:111`

## Security-domain assessment

### Public routes, identity, and tenancy

- The two protected modules are discoverable and executable only through
  `/gpt-access/*`; legacy module routes, generic GPT routing, and public
  introspection exclude them.
- The public capability payload cannot select principal, workspace, device,
  repository root, authorization, confirmation, or executor identity.
- GPT Access result polling requires the exact GPT-created local-agent job and
  trusted principal/workspace; generic job surfaces treat local-agent jobs as
  nonexistent.
- The daemon's dedicated bearer credential cannot authorize GPT Access,
  ActionPlan execution, administrative control, unrelated queue access, or
  database administration.
- Device registration, capability membership, revocation, credential
  generation, audience, instance, and principal are validated before protocol
  operations.

### Confirmation and replay

- `tests.run` and `patch.apply` cannot execute through natural-language
  routing.
- A challenge binds the exact authenticated identity, HTTP operation, action,
  and canonical payload.
- The retry may add only the raw challenge ID as top-level
  `confirmation_token`; nested/model-provided confirmation flags are rejected.
- Consumption is one-time. A changed payload, changed action, different actor,
  workspace, or token replay fails closed.
- The service checks the consumed challenge binding again before creating the
  authorized job.

### Jobs, results, audit, and database correctness

- Local-agent work reuses `job_data`, `job_events`, existing transactions, and
  audit/trace infrastructure; the idempotency table is a uniqueness binding,
  not a second queue.
- Claims are atomic and lease-bound; expired/already-terminal jobs do not
  execute; exact duplicate terminal results are idempotent and conflicting
  results fail closed.
- Mutations with uncertain local outcomes require manual reconciliation and
  are not automatically replayed.
- Generic workers, generic job routes, MCP job tools, SDK diagnostics, and
  generic recovery/cleanup paths do not cross the local-agent result boundary.
- Sensitive payloads are not copied into event, operational log, or preview
  report projections reviewed here.

### Python execution and local filesystem

- The daemon polls outbound and dispatches only fixed catalog actions. There
  is no arbitrary shell action.
- Workspace roots are registered locally; server/model payloads cannot select
  a root.
- Paths are normalized; traversal, absolute paths, `.git` internals, secret
  names, colon/ADS syntax, links, reparse points, and escapes are denied.
- POSIX file reads walk from open directory descriptors with no-follow
  semantics and revalidate identities. Windows performs pre/post reparse and
  identity checks and documents its private-workspace assumption.
- Git operations use fixed argument vectors and sanitized environment, reject
  external metadata/configuration, and cap/clean output controls.
- Patch preview is non-mutating. Patch apply requires exact authorization,
  SHA-256 binding, policy validation, repository revalidation, and structured
  reconciliation on uncertain outcomes.
- Process execution uses fixed profiles, no shell expansion, timeouts,
  cancellation, process-tree cleanup, environment sanitation, and output
  limits.

### `tests.run` sandbox

- `disabled` is fail-closed.
- `sandboxed` requires the configured Docker/Podman runtime and immutable image
  reference to be available.
- `unsandboxed-development-only` requires an explicit second opt-in and is
  forbidden in production or Railway.
- The sandbox runs non-root with no network, no host socket, no privilege,
  read-only base/source, temporary writable workspace, dropped capabilities,
  no-new-privileges, resource/process/disk/time/output limits, and cleanup.
- The source is copied to a bounded snapshot before container execution, so
  tests do not run against the registered host workspace directly.

### Productivity

- TypeScript remains the sole productivity business-rule and persistence
  authority.
- The capability module exposes 24 fixed actions; read-only metadata is
  explicit and all writes require confirmation.
- Task/project transitions are validated against canonical state machines.
- Reads and writes are scoped by trusted principal and workspace.
- State change, event/outbox entry, and idempotency receipt are transactional;
  stale writes and conflicting replays fail closed.
- The module is separate from repository/command functionality and is not
  legacy-route-exposed.

### Migrations, CI, and preview tooling

- The local-agent hardening migration is additive, idempotent, and has a
  fail-closed compensation path.
- Migration tooling checks expected columns, constraints, indexes, and binding
  shape without printing credentials.
- The preview verifier uses shell-free argument execution, requires explicit
  project/environment/service/commit/deployment identities, rejects production
  and Phase 2E targets, requires isolated dependency references, hashes
  sensitive evidence, and calls only `/gpt-access/*`.
- Its challenge mode observes and records `CONFIRMATION_REQUIRED`; it does not
  approve or retry a mutation.
- The retained preview report documents an isolated historical preview and
  prior Linux/Windows sandbox evidence. It is not evidence for hardening added
  after that deployed commit.

## Commands and tests actually executed by this reviewer

| Command | Result |
| --- | --- |
| `git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214..87788342f862d59c60fa3ea830da47c39950dabf` | Passed |
| `node scripts/run-jest.mjs --testPathPatterns=tests/gpt-access-gateway.test.ts --testNamePattern="(allows patch\\.apply only\|allows tests\\.run only\|rejects replay of a consumed confirmation_token\|rejects a confirmation_token retry when the request body changes\|returns local-agent results only\|does not expose non-gateway)" --coverage=false --runInBand` | 6 passed |
| `node scripts/run-jest.mjs` over ActionPlan auth, generic jobs, device policy, local-agent protocol/repository/module/service/migration, protected routing, and productivity contract/parity suites | 12 suites, 101 tests passed |
| `node scripts/run-jest.mjs` over generic job repository, SDK diagnostics, worker-control, and MCP local-agent boundary suites | 4 suites, 18 tests passed |
| `node scripts/run-jest.mjs --testPathPatterns=tests/local-agent-module-contract.test.ts --testPathPatterns=tests/gpt-access-gateway.test.ts --testNamePattern="(validates action payloads\|denies unsafe ARCANOS:CLI)" --coverage=false --runInBand` | 8 passed, 148 not selected |
| `python -m pytest daemon-python/tests/test_local_agent_protocol_runner.py daemon-python/tests/test_local_agent_sandbox_security.py -q` | 41 passed, 7 skipped |
| `python -m pytest daemon-python/tests/test_local_agent_handlers.py daemon-python/tests/test_cli_policy_security.py -q` | 44 passed, 4 skipped |
| `python -m pytest daemon-python/tests/test_local_agent_handlers.py daemon-python/tests/test_cli_policy_security.py daemon-python/tests/test_local_agent_sandbox_security.py -q` | 65 passed, 10 skipped |
| `node --test scripts/preview-e2e.test.mjs` | 18 passed |
| `npm run type-check` | Passed, including boundary checks and package compilation |
| `npm run lint` | Passed with 0 errors and 84 warnings |
| `npm run build` | Passed |
| `node scripts/generate-local-agent-capability-catalog.mjs --check` | Passed |
| `node scripts/local-agent-hardening-migration.mjs --plan` | Passed; no shape/checksum issues |
| `npm run validate:backend-cli:offline` | Passed |
| `npm run sync:check` | Passed with 0 errors, 0 warnings, and 5 informational legacy notes |
| `npm run validate:railway` | Passed; no deployment performed |

The reviewer also ran disposable local reproductions for both ADS issues before
the fix and repeated them after the fix. Patch apply created an ADS before the
fix; after the fix it is denied. `repo.search` returned ADS content before the
fix; after the fix path resolution raises a fail-closed validation error.

Docker was not available in this PowerShell session's executable path, so the
reviewer did not claim a new local effective-container run. The retained CI and
preview evidence records successful Linux effective sandbox/link-race tests and
Windows container tests for the previously deployed commit. Exact-final-commit
preview execution remains an approval condition below.

## Residual risks and conditions

### 1. Exact-final-commit preview evidence

- Severity: **release-blocking condition**, not an open code vulnerability
- Confidence: high

The retained preview report names a commit older than the current PR head and
the Round 2 worktree fixes. Before Ready for Review, commit the candidate,
deploy that exact commit only to the isolated preview, rerun the authenticated
discovery/productivity/local-agent/idempotency/offline/expiry/sandbox/trace
matrix, and update `docs/PREVIEW_E2E_REPORT.md` with exact deployment evidence.
Any subsequent runtime change invalidates that exact-commit evidence.

### 2. Path-based patch mutation and a hostile concurrent local writer

- Severity: **Medium conditionally; Low in the required private daemon-owned fixture**
- Confidence: high

`git apply` cannot make every target mutation descriptor-relative and atomic
against a hostile local process that changes paths concurrently. Keep mutation
roots private and daemon-owned, use disposable fixtures for preview tests,
revalidate repository identity, and require manual reconciliation after
interruption or identity drift. Do not share a writable registered patch root
with an untrusted local user or process.

### 3. Windows descriptor-relative limitation

- Severity: **Low/Medium conditional**
- Confidence: high

Python does not expose a complete descriptor-relative Win32 directory walk.
Pre/post reparse and identity checks are defense in depth, not a kernel-level
race guarantee. Use private registered roots protected by Windows ACLs; keep
Linux descriptor-safe validation in CI; do not treat a shared hostile Windows
workspace as a supported threat model.

### 4. Test snapshot host resource pressure

- Severity: **Low**
- Confidence: medium-high

Sandbox snapshot staging is bounded but can copy up to the configured file and
byte limits before container execution. Add deadline/cancellation checks during
copy and consider lower deployment-specific quotas if host resource exhaustion
is in scope. This does not permit code execution outside the sandbox.

### 5. In-memory confirmation and rate-limit state

- Severity: **Low operational**
- Confidence: high

Confirmation challenges and pre-authentication rate buckets are process-local.
A restart or different replica can reject a legitimate retry, which is
fail-closed; rate limiting is not globally coordinated. A shared expiring store
would improve multi-replica reliability and abuse resistance without changing
the confirmation contract.

### 6. Bearer credential theft

- Severity: **Low/Medium conditional**
- Confidence: high

The dedicated credential is narrow, device-bound, rotatable, and revocable, but
there is no mTLS or hardware attestation. A stolen unexpired token can
impersonate its exact registered device until revocation. Keep preview and
production credentials separate, minimize token lifetime/exposure, rotate
regularly, monitor device/audit anomalies, and consider transport-bound
credentials for a later hardening phase.

### 7. Sandbox image supply-chain reproducibility

- Severity: **Low**
- Confidence: medium

The base digest and application lockfile are pinned, but some package-manager
resolution occurs during sandbox image construction. Preserve the deployed
image digest, publish an SBOM/provenance record, and pin Python/system package
inputs more tightly before broad production distribution.

### 8. Diagnostics-scope metadata visibility

- Severity: **Low**
- Confidence: medium-high

The job-event timeline omits payloads and is redacted, but a holder of broad
diagnostics authority can observe job IDs and principal/workspace/device
labels. The current gateway uses a controlled principal/workspace. If the
system becomes generally multi-tenant, scope diagnostic timelines to the
trusted tenant or move them behind a separate administrative policy.

### 9. Sandbox runtime availability

- Severity: **Low operational**
- Confidence: high

When Docker/Podman or the immutable sandbox image is unavailable,
production-capable `tests.run` fails closed. Deployment health/monitoring must
distinguish this expected unavailability from a successful sandbox execution.

### 10. Existing dependency advisory debt

- Severity: **unclassified external debt pending impact analysis**
- Confidence: medium

The preview report records existing npm audit advisories while its configured
security gate passed. This PR did not demonstrate exploitability of those
advisories, so this review does not relabel them as a PR Critical/High finding.
Track and triage them separately against reachable production code.

## Approval conditions

This reviewer approves with the following conditions:

1. Preserve and commit all Round 2 fixes and focused tests described above.
2. Rerun the required full build, lint, type check, TypeScript tests, Python
   tests, schema/catalog parity, migration validation, and preview validation
   on the final candidate.
3. Deploy only the exact final commit to the proven-isolated Railway preview;
   do not reuse production or the Phase 2E Redis validation service.
4. Update the preview and merge-readiness reports with exact final-commit,
   migration, deployment, E2E, sandbox, audit, and trace evidence.
5. Preserve the private-workspace operating condition for patch mutation and
   the fail-closed sandbox default.
6. Do not interpret this review as approval to deploy or migrate production,
   merge the PR, or alter the production Custom GPT.

## Final verdict

**APPROVE WITH CONDITIONS**

No Critical or High security finding remains open in the reviewed candidate.
The architecture and TypeScript/Python authority boundaries remain intact.
The required conditions are exact-candidate release verification and explicit
acceptance of the documented local-workspace/runtime limitations, not requests
for architectural expansion.
