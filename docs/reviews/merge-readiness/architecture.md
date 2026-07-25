# Architecture Review — PR 1408

## Review identity

- Review round: final independent architecture and boundary review
- Reviewer: independent architecture reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed runtime head: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Scope: the complete base-to-head diff: 125 changed files, 35,999
  additions, and 312 deletions, plus the final review-only documentation
  corrections in the shared candidate worktree
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.95)**
- Open Critical findings: **0**
- Open High findings: **0**

No Critical or High finding is waived. This verdict approves the architecture
of the reviewed runtime candidate; it does not authorize merge, production
deployment, production migration, or production enablement.

## Executive assessment

The implementation preserves the required ARCANOS control boundary:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript identity, tenancy, contracts, policy, confirmation,
     persistence, jobs, audit, and tracing
  -> existing PostgreSQL job_data / job_events lifecycle
  -> private outbound-only Python daemon
  -> fixed typed Python handler
  -> correlated structured result
  -> tenant-bound /gpt-access job-result endpoint
```

The PR does not introduce:

- a Python public API;
- direct Python access to canonical PostgreSQL state;
- a second server queue or workflow engine;
- a generic shell capability;
- a parallel authentication or confirmation system;
- protected-module execution through a legacy route or `/gpt/:gptId`;
- repository, Git, test, patch, or command functionality inside
  `ARCANOS:PRODUCTIVITY`.

`ARCANOS:PRODUCTIVITY` and `ARCANOS:LOCAL_AGENT` remain separate protected
modules. The daemon's SQLite file is bounded crash-recovery evidence, not
canonical ARCANOS state or a competing queue.

## Review scope and method

The review independently inventoried and inspected every changed file from the
base through `f7f3a2ca`, including:

- TypeScript routes, capability contracts, services, confirmation middleware,
  executor authentication, repositories, worker controls, diagnostics, MCP
  boundaries, startup schema, and natural-language dispatch;
- all Python daemon handlers, protocol client, runner, journal, filesystem and
  Git validation, patch core, process runner, sandbox, CLI reuse points, and
  configuration;
- both generated capability catalogs and their generator;
- the productivity and local-agent migrations, compensation artifact,
  manifest, verifier, and database integration tests;
- all changed Jest, pytest, `node:test`, Linux sandbox, Windows, and PostgreSQL
  test coverage;
- OpenAPI generation, preview verifier, Railway configuration, CI changes,
  deployment evidence, maintained guides, and every merge-readiness review.

The final two commits were also inspected directly:

- `0808eb1f` changes only a test fixture to compare expiry against the mocked
  database clock rather than the application clock.
- `f7f3a2ca` adds the existing 18-test preview safety harness to the existing
  Deployment Readiness CI job.

Neither commit adds a runtime path or expands authority.

## Final finding dispositions

### ARCH-F-001 — Protected routing and job visibility

- Original severity: High where private local-agent job material was reachable
  through generic diagnostics or MCP inspection
- Status: **resolved**

Both modules set `gptAccessOnly: true` and `exposeLegacyRoute: false`.
Legacy module routes, `/queryroute`, the public legacy registry,
`/gpt/:gptId`, and public introspection cannot execute or enumerate them as
legacy modules. Generic job status/result/cancel/stream routes, generic
workers, stale recovery, failed-job tools, MCP job tools, worker controls, and
system diagnostics treat local-agent rows as unavailable.

The existing daemon registry can receive a metadata-only module snapshot for
prompt construction, and the public OpenAPI intentionally contains capability
metadata. Neither surface can execute a protected action or read job payloads.

### ARCH-F-002 — Cross-tenant event and result access

- Original severity: High
- Status: **resolved**

Local-agent result access requires a server-created GPT Access job whose
principal and workspace match trusted execution context. Timeline queries join
authoritative `job_data` and return local-agent events only when both trusted
tenant values match. Missing tenant context excludes all local-agent events.
Generic job and MCP surfaces do not provide an alternate result path.

### ARCH-F-003 — Confirmation authority and replay

- Original severity: High for any privileged-action bypass
- Status: **resolved**

`tests.run` and `patch.apply` require strict, one-time GPT Access challenges.
The challenge is bound to the authenticated actor, server-controlled principal
and workspace, HTTP method/path, exact action, and normalized payload. The
token is top-level transport metadata, is stripped before dispatch, and never
enters the daemon payload. Changed action, changed payload, changed resolved
natural-language plan, different identity, expiry, or replay fails closed.

Python receives only an already-authorized assignment and implements no
competing confirmation decision. Patch mutation also requires a
non-serializable in-process authorization sealed to the exact canonical
payload and expected patch hash.

### ARCH-F-004 — Executor authority separation

- Original severity: High
- Status: **resolved**

The local agent uses audience `local-agent-protocol`, role
`local-agent-executor`, and only heartbeat, claim, job-heartbeat, and result
scopes. Device, instance, principal, capability grant, heartbeat freshness,
revocation, and current/previous credential rotation are validated.
Configuration fails closed if a local-agent credential collides with GPT
Access or ActionPlan credentials. This identity does not grant ActionPlan,
user capability, administrative, unrelated queue, or database authority.

### ARCH-F-005 — Idempotency, expiry, and recovery semantics

- Original severity: High where advisory locking was the only correctness
  boundary
- Status: **resolved**

`local_agent_job_idempotency` provides database-enforced uniqueness across
principal, workspace, device, action, and key hash, plus a unique job binding.
Identical replay returns the original job/result; changed canonical payload
conflicts. Advisory locks remain only an optimization.

Claims are atomic and lease-bound. Terminal result replay is exact and
idempotent; conflicting results fail closed. Each expired job receives its own
transactional state transition and correlated event, with savepoints isolating
partial batch failure. Possibly-started mutations enter manual reconciliation
and are not automatically replayed.

### ARCH-F-006 — Python sandbox, filesystem, and Git boundary

- Original severity: High if sanitized host execution were considered a
  production sandbox
- Status: **resolved with documented operating constraints**

Production-capable `tests.run` requires the container sandbox: non-root user,
immutable image digest, no network or host socket, read-only base/input,
temporary writable workspace, dropped capabilities, no-new-privileges,
sanitized environment, and CPU, memory, PID, disk, time, cancellation, and
output limits. Disabled is fail-closed. Development-only unsandboxed execution
requires dual opt-in and is prohibited on Railway or in production.

Workspace paths reject traversal, absolute/drive paths, Git internals, secret
names, colon/ADS syntax, symlinks, reparse points, and root escapes. POSIX
reads use descriptor-relative no-follow access. Git commands use fixed
arguments, sanitized configuration, and contained standalone metadata.
Repository hooks, filters, alternates, external common/object directories,
submodule roots, and linked worktrees fail closed.

### ARCH-F-007 — Exact-head preview and release evidence

- Original severity: High release gate
- Status: **resolved for the reviewed runtime head**

The isolated preview API and worker both report `SUCCESS` for exact commit
`f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`:

- API deployment: `ce5a974e-a087-4634-9e74-992b4c44144e`
- Worker deployment: `87baaf0a-ac51-42a0-abdc-5044cd71f122`

The API's server-controlled metadata binds that worker deployment and SHA.
The authenticated read-only verifier passed against the exact pair, including
both capability catalogs, productivity reads, local-agent job completion,
tenant-bound six-event timelines, idempotent replay/conflict, and
non-mutating `patch.preview`. A separate challenge-only run returned
`CONFIRMATION_REQUIRED` for `patch.apply` and created no approved retry or
mutation job. The preview PostgreSQL suite passed all six concurrency and
tenant-isolation scenarios. Runtime log scans found no fatal event or actual
credential exposure.

This reviewer independently verified the Railway deployment IDs, statuses,
commit hashes, public health response, and OpenAPI module presence. The
authenticated calls were executed by the lead/operator using preview-only
credentials and are recorded, without secrets, in
`docs/PREVIEW_E2E_REPORT.md`.

The maintained bridge and security guides are corrected in the final
review-artifact candidate to distinguish completed isolated-preview evidence
from production work that remains unexecuted.

## Architecture boundaries

### TypeScript owns the public protocol

- The seven local-agent actions and all input/output/risk/confirmation/
  idempotency/timeout/device/file metadata are authoritative in
  `src/services/localAgent/contracts.ts`.
- The TypeScript generator produces both checked-in JSON catalogs; Python
  validates against the generated catalog and cannot define a competing public
  shape.
- The action set is fixed to `local_agent.status`, `repo.search`,
  `git.status`, `git.diff`, `tests.run`, `patch.preview`, and `patch.apply`.
  There is no arbitrary argv, environment, root, or shell action.
- The dynamic OpenAPI document publishes Custom GPT Action contracts but not
  executor heartbeat/claim/result routes, credentials, roots, or Python
  implementation details.

### Existing queue and workflow infrastructure is reused

- Local-agent work uses existing `job_data`, `job_events`, PostgreSQL
  transactions, audit, tracing, and GPT Access result handling.
- The idempotency table is a uniqueness binding, not a queue.
- Generic workers explicitly exclude local-agent ownership; the private daemon
  claims only purpose-bound local-agent jobs.
- No new ActionPlan-like orchestrator is introduced. Simple productivity
  commands remain synchronous domain operations.

### Python remains private and outbound-only

- The daemon initiates heartbeat, claim, lease heartbeat, and result requests.
- It exposes no new listener to Custom GPTs and has no PostgreSQL client for
  canonical state.
- The fixed handler registry is reused by the current CLI/voice paths and
  backend-created jobs rather than duplicating repository, Git, test, or patch
  implementations.
- The local journal records exact immutable execution evidence before effects
  and supports bounded recovery/manual reconciliation; it is not a second
  authority.

### Productivity remains a deterministic TypeScript domain

- All 24 actions use trusted principal/workspace context and recursively reject
  caller-supplied authority aliases.
- Canonical task/project transitions, optimistic concurrency, ambiguity,
  idempotency, events, and persistence stay in TypeScript.
- State mutation, outbox event, and idempotency receipt share the repository
  transaction.
- Repository and command execution remains outside the productivity module.

## Independent validation

Commands executed by this reviewer:

```text
git diff --name-status 59989445...f7f3a2ca
git diff --stat 59989445...f7f3a2ca
git diff --check 59989445...f7f3a2ca
git show a3d2251f
git show 0808eb1f
git show f7f3a2ca
gh pr checks 1408
railway --version
railway deployment list --service arcanos-api-preview-bf8ac3bd --environment arcanos-preview-bf8ac3bd --limit 3 --json
railway deployment list --service arcanos-worker-preview-bf8ac3bd --environment arcanos-preview-bf8ac3bd --limit 3 --json
GET /health
GET /gpt-access/openapi.json
GET /gpt-access/status without credentials
GET /gpt-access/capabilities/v1 without credentials
npm run check:boundaries
npm run check:routing-boundaries
npm run sync:check
node scripts/generate-local-agent-capability-catalog.mjs --check
npm run test:preview-e2e
node scripts/run-jest.mjs <12 focused architecture/boundary patterns> --coverage=false --runInBand
python -m pytest <four focused local-agent/security suites> -q -rs
npm run db:local-agent-hardening:plan
npm run validate:railway
npm run docs:check
```

Results:

- CEF and routing boundaries: passed.
- Generated TypeScript/Python catalog parity: passed.
- Cross-codebase sync: 0 errors, 0 warnings, 5 pre-existing informational
  recommendations.
- Preview verifier: 18 passed, 0 failed.
- Focused Jest architecture/boundary suites: 12 suites, 85 tests passed.
- Focused Python suites: 94 passed, 11 skipped on the local Windows host.
  Skips were symlink-privilege or POSIX descriptor tests; exact-head Linux
  sandbox CI passed those platform paths.
- Migration checksum/plan and Railway compatibility: passed.
- Documentation audit: 272 passed, 0 failed, 0 warnings.
- Diff whitespace validation: passed.
- Public preview health: ready; Redis ready.
- Public OpenAPI: HTTP 200 and contains both protected capability catalogs.
- Unauthenticated protected status and capability discovery: HTTP 401.
- Railway API/worker deployment identity: exact `f7f3a2ca`, both `SUCCESS`.
- No production or Phase 2E mutation was performed by this reviewer.

## Residual risks and conditions

These are Medium/Low operational or compatibility conditions, not waived
Critical/High defects:

1. **All required GitHub checks must finish successfully.** The exact-head CI
   run was still completing when this review was written. Any failure revokes
   this verdict until corrected and re-reviewed.
2. **Only review-artifact changes may follow `f7f3a2ca` without runtime
   revalidation.** Any source, migration, contract, CI-execution, deployment,
   or security-control change requires a new exact-head assessment and, where
   applicable, preview E2E.
3. **Production local-agent enablement remains off.** A separately approved
   production migration/promotion runbook, exact target verification, backup,
   rollback/forward-fix plan, and production sandbox evidence are still
   required.
4. **Terminal local-agent retention needs an operational policy before
   production.** Completed, cancelled, and expired job payload/result rows need
   bounded cleanup while manual-reconciliation evidence remains quarantined.
5. **Git/patch support is intentionally standalone-main-worktree-only.**
   Linked worktrees, submodule roots, external metadata, executable local Git
   configuration, and unsafe indirection fail closed.
6. **`git apply` remains path-based.** Mutation workspaces must be private,
   daemon-owned, and not shared with a hostile local writer. Identity drift or
   interruption remains a manual-reconciliation event.
7. **Windows cannot provide the same descriptor-relative directory walk as
   POSIX.** Windows uses reparse/identity pre/post checks and therefore retains
   the documented private-workspace assumption.
8. **Preview resources remain temporary.** Keep them isolated, revoke preview
   credentials if retention is extended, and use the exact-target teardown
   plan. They are not a production promotion path.
9. **Productivity scale/maintenance follow-ups remain.** Add bounded receipt
   cleanup and state projection/pagination before materially increasing tenant
   volume; document the forward-only productivity migration policy.

## Recommendation

**APPROVE WITH CONDITIONS**

The TypeScript/Python authority, public protocol, protected routing, tenancy,
confirmation, job, persistence, queue, workflow, and deployment-isolation
boundaries are sound for the reviewed runtime candidate. No Critical or High
finding remains open or waived.

Approval is conditional on the required CI matrix completing successfully and
on the final commit after `f7f3a2ca` containing review/documentation artifacts
only. A failed check or any additional runtime change returns this review to
`REQUEST CHANGES` until exact-candidate validation is repeated.
