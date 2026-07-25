# Security Review — PR 1408

## Review identity

- Review round: final independent security review
- Reviewer: independent security reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed PR head: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Scope: all 125 changed files, including application and daemon source,
  generated protocol artifacts, tests, migrations and compensation,
  documentation, CI, preview tooling, and retained deployment evidence
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.95)**
- Open Critical findings: **0**
- Open High findings: **0**

This verdict is conditional on the exact reviewed head completing CI. The
isolated exact-head preview deployment and read-only/fail-closed validation
have completed successfully; the exact-head CI matrix had restarted after the
final workflow-only commit and was still pending when this report was updated.
This review does not authorize a production deployment, production migration,
or merge.

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

The final candidate closes the material security findings found during review:

1. generic diagnostics and MCP surfaces can no longer disclose local-agent job
   input or output;
2. GPT Access job timelines now join the authoritative job envelope and scope
   local-agent events to the trusted principal/workspace;
3. `tests.run` and `patch.apply` require a consumed, one-use challenge bound
   to the exact actor, tenant, action, and payload;
4. Windows alternate data stream paths are denied at the TypeScript contract,
   Python workspace, secure-file, Git, and patch-policy layers;
5. local-agent executor credentials have a dedicated audience and narrow
   heartbeat/claim/lease/result scopes;
6. logical-job idempotency is protected by a database unique constraint, not
   advisory locking alone;
7. `tests.run` uses a real fail-closed container boundary in
   production-capable mode.

No unresolved Critical or High vulnerability was found in the reviewed head.
The remaining items are operational assumptions or defense-in-depth work and
are listed explicitly below.

## Independent review method

The reviewer did not assume another reviewer covered any security area. The
review independently:

- inventoried the complete base-to-head diff and all 125 changed files;
- inspected authentication, authorization, rate limiting, tenancy, exact
  confirmation binding, challenge consumption, replay behavior, result
  polling, route isolation, OpenAPI exposure, and error/log sanitation;
- inspected executor audience/scope separation, credential rotation and
  revocation, device registration, heartbeat freshness, job claim, lease,
  result, expiry, recovery, idempotency, and audit correlation;
- inspected generic jobs, workers, diagnostics, MCP tools, event timelines,
  queue summaries, recovery, and cleanup for cross-boundary disclosure;
- inspected the Python handler registry, protocol client, durable journal,
  workspace registry, repository and Git tools, patch preview/application,
  process runner, output sanitizer, secret policy, symlink/reparse defenses,
  alternate data streams, and test sandbox;
- inspected productivity schemas, lifecycle rules, trusted tenancy,
  repository queries, transactions, idempotency, outbox events, confirmation,
  and protected routing;
- inspected both SQL migrations, compensation, migration tooling, schema
  verification, CI jobs, Railway compatibility, preview verifier, retained
  preview report, environment examples, and maintained documentation;
- ran focused security suites plus static, protocol-parity, and passive
  Railway validation on the exact reviewed head.

## Finding disposition

| ID | Original severity | Status | Disposition |
| --- | --- | --- | --- |
| SEC-001 | High | Resolved | Generic repository, diagnostics, worker, and MCP paths exclude local-agent rows; protected GPT Access result reads remain tenant-bound. |
| SEC-002 | High | Resolved | Job-event timelines join `job_data`; missing trusted tenancy excludes local-agent events and a trusted scope returns only matching local-agent events. |
| SEC-003 | High | Resolved | Git work requires a physical standalone worktree and rejects external Git/common/object directories, alternates, executable config, includes, linked worktrees, and submodule roots. |
| SEC-004 | Medium | Resolved | Patch and repository paths reject colon-bearing segments, including Windows alternate data streams, and Git forces/validates `core.protectNTFS=true`. |
| SEC-005 | Medium | Resolved | Both file-modifying actions require exact consumed GPT Access challenge evidence; permissive confirmation flags and natural-language execution cannot authorize them. |
| SEC-006 | Medium | Resolved | The local-agent credential uses a dedicated role/audience, fixed protocol scopes, pinned identity, bounded rotation overlap, and cross-token collision checks. |
| SEC-007 | Medium | Resolved | `local_agent_job_idempotency` supplies database-enforced tenant/device/action/key and one-job uniqueness; advisory locks are only an optimization. |
| SEC-008 | Medium | Resolved | `tests.run` has disabled, sandboxed, and development-only modes; production-capable execution requires the sandbox and never falls back to host execution. |
| SEC-009 | Low | Resolved | Every expiry/recovery transition receives per-job transactional event evidence; savepoints isolate a failed candidate without collapsing the batch. |

### SEC-001 — Generic job-data disclosure

`local-agent` input and output can contain repository search, diff, test, or
patch material. Generic job routes, worker inspection, system diagnostics, and
MCP tools now treat those rows as nonexistent or omit them from aggregate
queries. The diagnostics projection itself is bounded and does not contain raw
input or output.

Evidence:

- `src/core/db/repositories/jobRepository.ts`
- `src/mcp/server/jobTools.ts`
- `src/platform/logging/systemDiagnostics.ts`
- `src/routes/jobs.ts`
- `src/services/workerControlService.ts`
- `tests/job-repository.local-agent-boundary.test.ts`
- `tests/jobs.route.test.ts`
- `tests/mcp-job-tools.test.ts`
- `tests/system-diagnostics-local-agent-boundary.test.ts`
- `tests/worker-control-service.test.ts`

### SEC-002 — Cross-tenant event-timeline disclosure

Timeline queries now parameterize and join the authoritative `job_data`
envelope. A request without trusted principal/workspace context excludes every
local-agent event. A request with trusted context returns ordinary events plus
only local-agent events whose server-created job envelope matches both values.
No model field can supply that scope.

Evidence:

- `src/core/db/repositories/jobEventRepository.ts`
- `src/routes/gpt-access.ts`
- `src/services/gptAccessGateway.ts`
- `tests/job-event-repository.test.ts`
- `tests/integration/local-agent-hardening.pg.integration.test.ts`

### SEC-003 — Git metadata and command escape

Every local-agent Git or patch operation validates a standalone repository,
requires physical in-root Git metadata, rejects external alternates/common
directories and executable-bearing local configuration, uses fixed arguments,
disables credential helpers/hooks/text conversion/submodule recursion, uses a
sanitized environment, and rechecks repository identity. Linked worktrees and
submodule roots that use `.git` files are intentionally unsupported.

Evidence:

- `daemon-python/arcanos/local_agent/secure_fs.py`
- `daemon-python/arcanos/local_agent/patch_handler.py`
- `daemon-python/arcanos/protocol_runtime/tools/repository_tools.py`
- `daemon-python/tests/test_local_agent_handlers.py`

### SEC-004 — Path, symlink, secret, and ADS escape

Public schemas and Python path resolution reject absolute paths, drives,
traversal, `.git`, colon/ADS syntax, secret names, links/reparse points, and
paths outside a registered root. POSIX reads walk descriptor-relative with
no-follow semantics. Windows performs pre/post reparse and identity checks.
Git output is NUL-aware and control-stripped; secret paths are excluded and
filtered again.

Evidence:

- `src/services/localAgent/contracts.ts`
- `daemon-python/arcanos/local_agent/workspace_registry.py`
- `daemon-python/arcanos/local_agent/secure_fs.py`
- `daemon-python/arcanos/cli/cli_policy.py`
- `daemon-python/arcanos/protocol_runtime/tools/repository_tools.py`
- `daemon-python/tests/test_cli_policy_security.py`
- `daemon-python/tests/test_local_agent_handlers.py`
- `daemon-python/tests/test_local_agent_sandbox_security.py`

### SEC-005 — Confirmation binding and replay

`tests.run` and `patch.apply` are privileged, direct-capability-only actions.
They require a consumed challenge bound to the authenticated actor,
server-controlled principal/workspace, HTTP method/path, action, and normalized
payload. The token is stripped before dispatch and never becomes daemon
payload or journal data. A changed action, changed payload, expired token,
different binding, or replay fails closed. Python receives only the server's
authorized assignment, and patch application additionally requires an
in-process non-serializable authorization sealed to the exact canonical
payload and expected SHA-256.

Evidence:

- `src/transport/http/middleware/confirmationChallengeStore.ts`
- `src/transport/http/middleware/confirmGate.ts`
- `src/routes/gpt-access.ts`
- `src/services/localAgent/service.ts`
- `daemon-python/arcanos/local_agent/runner.py`
- `daemon-python/arcanos/local_agent/patch_handler.py`
- `tests/gpt-access-gateway.test.ts`
- `tests/local-agent-service.test.ts`
- `daemon-python/tests/test_local_agent_protocol_runner.py`
- `daemon-python/tests/test_local_agent_handlers.py`

### SEC-006 — Executor identity and device authority

The daemon bearer authenticates only as `local-agent-executor` in the
`local-agent-protocol` audience. Its fixed scopes are heartbeat, claim, job
heartbeat, and result. It cannot authenticate to ActionPlan executor, GPT
Access, administration, unrelated queues, or PostgreSQL. Configuration rejects
credential overlap, pins principal/instance/device, verifies an authoritative
Agent record and capability grant, enforces a fresh heartbeat, and supports a
single previous credential for at most 24 hours.

Evidence:

- `src/services/actionPlanExecution/auth.ts`
- `src/services/localAgent/devicePolicy.ts`
- `src/routes/gpt-access-local-agent.ts`
- `daemon-python/arcanos/local_agent/protocol.py`
- `tests/action-plan-execution-auth.test.ts`
- `tests/action-plan-execution-result-route.test.ts`
- `tests/local-agent-device-policy.test.ts`
- `tests/local-agent-http-protocol.test.ts`

### SEC-007 — Job integrity, replay, and recovery

Jobs carry server-created principal, workspace, device, action, validated
payload, trace/request IDs, idempotency evidence, authorization evidence, and
expiry. Database uniqueness prevents two logical jobs for the same scoped key;
changed canonical payloads conflict. Claims are atomic and lease-bound. Exact
claim/result replays are idempotent, different terminal results are rejected,
and expired/already-terminal jobs do not execute. A possibly started file
mutation is marked unknown and requires manual reconciliation rather than
automatic replay. The local journal commits before side effects and result
submission.

Evidence:

- `migrations/20260724_local_agent_job_hardening_v1`
- `src/core/db/repositories/localAgentJobRepository.ts`
- `daemon-python/arcanos/local_agent/journal.py`
- `daemon-python/arcanos/local_agent/runner.py`
- `tests/local-agent-job-repository.test.ts`
- `tests/integration/local-agent-hardening.pg.integration.test.ts`
- `daemon-python/tests/test_local_agent_protocol_runner.py`

### SEC-008 — `tests.run` sandbox

The production-capable mode starts a disposable Docker/Podman container as a
non-root user with no network, no host socket, read-only base/input
filesystems, a bounded temporary writable workspace, all capabilities dropped,
no-new-privileges, and CPU, memory, PID, disk, file-size, time, cancellation,
and output limits. The image must be an immutable digest and pass an effective
self-test. Source staging excludes secrets, dependencies, Git metadata, and
links and enforces actual copied-byte limits. Missing sandbox infrastructure
fails closed; no host fallback exists.

Evidence:

- `daemon-python/Dockerfile.local-agent-tests`
- `daemon-python/arcanos/local_agent/test_sandbox.py`
- `daemon-python/arcanos/local_agent/sandbox_entrypoint.py`
- `daemon-python/arcanos/local_agent/secure_fs.py`
- `daemon-python/tests/test_local_agent_sandbox_security.py`
- `daemon-python/tests/test_local_agent_sandbox_container_e2e.py`
- `.github/workflows/ci-cd.yml`

## Other security-domain conclusions

### Productivity

- TypeScript is the sole public, lifecycle, tenancy, transaction, idempotency,
  and persistence authority.
- The module exposes 24 fixed actions; all writes are privileged and
  confirmation-gated.
- Caller-supplied tenancy aliases are recursively rejected; every repository
  read/write is scoped by trusted principal and workspace.
- Task/project transitions, optimistic versions, terminal-state handling,
  ambiguity, and stale-plan behavior fail closed.
- Canonical state, the outbox event, and the hashed idempotency receipt share a
  transaction.
- `ARCANOS:PRODUCTIVITY` is GPT-Access-only, not exposed through legacy module
  routes, introspection, or `/gpt/:gptId`, and contains no repository or command
  execution.

### OpenAPI and public protocol

The public `/gpt-access/openapi.json` contains only the intended Custom GPT
Action contract and deterministic capability metadata. It does not publish
daemon heartbeat/claim/result protocol routes, credentials, workspace roots,
or implementation paths. Execution, result reads, and protected discovery
remain bearer/scope controlled.

### Logging, output, and evidence

Operational logs and events use bounded structured metadata and redaction.
Bearer values, confirmation tokens, database URLs, workspace roots, private
keys, credential assignments, ANSI/control sequences, and sensitive object
keys are removed or never persisted. The preview verifier hashes payloads,
challenge IDs, dependency hosts, and deployment metadata rather than printing
the underlying sensitive values. A base-to-head added-line scan found no
private-key, OpenAI-key, Railway-token, or bearer literal; database URL
matches were limited to CI/test/documentation fixtures.

### Migrations and preview isolation

The local-agent hardening migration is additive, transactional, repeatable,
checksum-pinned, and verified against exact expected columns, constraints, and
indexes. Compensation refuses nonempty bindings or active local-agent jobs.
The productivity migration is additive and forward-only by documentation.
Preview tooling accepts only fixed read-only Railway commands, requires an
explicit four-service preview identity and exact commit/deployments, rejects
production and Phase 2E names/references, verifies dependency host ownership,
uses shell-free execution, and permits only `/gpt-access/*` HTTP paths.
Challenge mode observes `CONFIRMATION_REQUIRED` and never approves or retries.

## Final-head addenda

Two changes landed after the larger security hardening commit:

1. `0808eb1f` replaced application-clock calls in one expiry test with the
   fixture's deterministic database clock. It changes no production code or
   security contract and makes the intended database-clock assertion stable.
2. `f7f3a2ca` added `npm run test:preview-e2e` to Deployment Readiness CI. It
   changes no runtime behavior and closes a release-evidence gap by making the
   existing 18-test fail-closed preview harness mandatory.

Both changes are security-neutral or security-positive. Exact-head preview
evidence was subsequently collected for `f7f3a2ca`; exact-head CI remained in
flight.

## Exact-head isolated preview evidence

The final head was deployed only to the isolated preview stack:

- API deployment `ce5a974e-a087-4634-9e74-992b4c44144e` reported
  `SUCCESS`;
- worker deployment `87baaf0a-ac51-42a0-abdc-5044cd71f122` reported
  `SUCCESS`;
- protected server metadata paired both deployments to exact commit
  `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`;
- authenticated read-only E2E passed, including six-event tenant-bound local
  agent timelines, idempotent replay, idempotency conflict, and
  `patch.preview` with no workspace mutation;
- PostgreSQL integration passed 6/6, including own-tenant, foreign-tenant, and
  missing-context timeline isolation;
- a separate exact `patch.apply` request returned
  `403 CONFIRMATION_REQUIRED`; no approval, retry, or job was created;
- a bounded preview log scan found zero fatal entries and zero actual
  credentials.

The preview evidence is sufficient for the security review because it exercises
the public authorization, tenancy, job, event, and fail-closed confirmation
boundaries without performing a newly approved mutation.

## Commands and tests executed by this final reviewer

| Command | Result |
| --- | --- |
| `git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214..f7f3a2caf3f13566a41a8587a1b6e2966d7f6439` | Passed |
| `python -m pytest` over CLI policy, local-agent handlers, protocol/runner, and sandbox-security suites | 94 passed, 11 skipped |
| `node scripts/run-jest.mjs` over local-agent, ActionPlan auth, job events, and productivity suites | 15 suites passed, 166 tests passed, 6 database-gated tests skipped |
| `node scripts/run-jest.mjs` over GPT Access, OpenAPI, natural-language dispatch, ActionPlan result routing, and protected GPT routing | 5 suites, 211 tests passed |
| `npm run test:preview-e2e` | 18 tests passed |
| `npm run type-check` | Passed, including all boundary checks and workspace package builds |
| `npm run lint` | Passed with 0 errors and 84 pre-existing warnings |
| `node scripts/generate-local-agent-capability-catalog.mjs --check` | Passed |
| `npm run validate:railway` | Passed; passive validation only, no deployment |
| Added-line sensitive-literal scan | No private key, OpenAI key, Railway token, or bearer literal found |

The skipped Python cases require platform privileges or an effective container
runtime. The skipped TypeScript cases require the explicit PostgreSQL test
connection. Those checks are required in exact-head CI and are not represented
as locally passed here.

## Residual risks and operating conditions

### 1. Exact-head CI evidence

- Severity: **release-blocking condition**, not an open code vulnerability
- Confidence: high

The API and worker preview deployments identify exact head and the final
read-only/confirmation-fail-closed preview verifier passed. Before Ready for
Review, every required CI check for `f7f3a2ca` must also be green. Any later
runtime or workflow change restarts both the CI and exact-head preview evidence
conditions.

### 2. Path-based patch mutation under a hostile concurrent local writer

- Severity: **Medium conditional; Low in the required private daemon-owned fixture**
- Confidence: high

External `git apply` cannot make every mutation descriptor-relative and atomic
against another local process swapping path components. Keep mutation roots
private to the daemon account, use disposable fixtures for preview mutation,
preserve identity checks/backups, and require manual reconciliation after any
interruption or identity drift. A shared hostile writable patch root is outside
the supported threat model.

### 3. Windows descriptor-relative limitation

- Severity: **Low/Medium conditional**
- Confidence: high

Python does not expose a complete descriptor-relative Win32 directory walk.
Pre/post reparse and identity checks are defense in depth, not a kernel-level
race guarantee. Protect registered roots with private Windows ACLs and keep the
Linux descriptor-safe link/race suite mandatory.

### 4. Semantic output/prompt injection

- Severity: **Medium conditional**
- Confidence: medium-high

Repository text, Git names, diffs, and test output are untrusted content.
Structural validation, control stripping, secret redaction, and size limits do
not remove human-language instructions embedded in source. Custom GPT
instructions must treat tool output as data, never as authority. The exact
confirmation boundary for file-modifying actions materially limits impact and
must remain intact.

### 5. Local journal data at rest

- Severity: **Low/Medium conditional**
- Confidence: high

Pending or quarantined journal rows can contain a server assignment, including
patch content, until accepted or manually reconciled. The SQLite file is
private and permission-checked but not application-encrypted. Run the daemon
under a dedicated account on encrypted storage, protect backups, and clear
resolved quarantines through an audited operator procedure.

### 6. Development HTTP override

- Severity: **Low/Medium configuration risk**
- Confidence: high

The protocol requires HTTPS by default and never follows redirects, but it
inherits the existing explicit `BACKEND_ALLOW_HTTP=true` development override.
Keep that flag false for every non-localhost preview/production daemon; reject
such configuration during deployment review so the executor bearer cannot be
sent over cleartext transport.

### 7. In-memory confirmation and rate-limit state

- Severity: **Low operational**
- Confidence: high

Confirmation challenges and pre-auth rate buckets are process-local. Restart
or replica drift rejects a valid retry, which is fail-closed; rate limits are
not globally coordinated. Use a single/sticky confirmation issuer during this
release or move expiring state to a shared store in a future change.

### 8. Bearer credential theft and daemon impersonation

- Severity: **Low/Medium conditional**
- Confidence: high

The dedicated token is narrow, pinned, rotatable, and revocable, but not
hardware- or transport-bound. A stolen current token can impersonate that
registered device until revocation. Separate preview/production credentials,
store them only in backend/daemon secret stores, rotate on loss or anomalous
audit activity, and remove the previous-token overlap promptly.

### 9. Sandbox runtime and supply chain

- Severity: **Low**
- Confidence: medium-high

Container/kernel vulnerabilities remain outside the application boundary. The
base image digest and npm lockfile are pinned, but OS/Python package resolution
during image construction is not fully reproducible. Retain the exact image
digest, produce SBOM/provenance for broader distribution, never mount a host
socket or use privileged mode, and keep missing/unhealthy sandbox status
fail-closed.

## Approval conditions

This reviewer approves with these conditions:

1. All required CI checks for exact head
   `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439` must pass, including full build,
   lint/typecheck, unit/integration tests, security audit, Windows Python,
   Linux effective sandbox/link-race tests, PostgreSQL concurrency, deployment
   readiness, and the preview safety harness.
2. Preserve the recorded isolated preview evidence: the API and worker serve
   exact head, use only preview-owned PostgreSQL/Redis/credentials, and passed
   the final discovery/read-only/confirmation-fail-closed validation.
3. Preserve the exact-action/payload one-use confirmation contract, the
   private-workspace condition for patch mutation, HTTPS outside localhost,
   and fail-closed sandbox defaults.
4. Keep the PR Draft until the combined merge-readiness report records the
   exact-head green evidence and every independent reviewer approves or
   approves with conditions.
5. Do not interpret this review as approval to merge, deploy production,
   migrate production, modify production Custom GPT configuration, or relax
   any authority boundary.

## Final verdict

**APPROVE WITH CONDITIONS**

No Critical or High security finding remains open in the reviewed code. The
TypeScript/Python authority boundary, tenancy, confirmation, job, filesystem,
sandbox, and protected-routing controls are coherent and well-tested. The
remaining blocker is exact-head release evidence, not an unresolved Critical
or High design defect.
