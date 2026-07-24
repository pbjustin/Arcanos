# Local-Agent Capability Bridge Security Review

## Scope and conclusion

This review covers the implemented `ARCANOS:LOCAL_AGENT` TypeScript capability,
its durable `job_data` protocol, the outbound Python executor, the seven
initial handlers, and their integration with GPT Access, ActionPlan executor
authentication utilities, the dedicated local-agent executor audience, the
Agent registry, and the existing Python repository and patch tools.

The implementation preserves the intended trust boundary:

- the Custom GPT is an untrusted client;
- TypeScript owns the public contract and authorization decision;
- PostgreSQL owns canonical job state;
- Python is an authenticated outbound executor;
- local subprocesses remain inside an allowlisted handler;
- no Python listener is exposed to the Custom GPT or internet.

The bridge is suitable for controlled preview use after the reviewed database
migration, dedicated credentials, and container sandbox are configured and
verified. Host execution of untrusted repository tests is not equivalent to
sandboxed code execution and is forbidden in production-capable
configuration.

## Trust boundaries and assets

### Trust boundaries

1. **Custom GPT to GPT Access:** untrusted natural-language/model output enters
   a schema-, scope-, allowlist-, and confirmation-controlled TypeScript
   endpoint.
2. **GPT Access to PostgreSQL:** the backend adds trusted identity,
   authorization, expiry, idempotency, and correlation data before storing a
   job.
3. **Backend to local device:** the daemon authenticates outbound with the
   dedicated `local-agent-protocol` credential and can claim only jobs
   assigned to its authoritative Agent/device ID and scopes.
4. **Daemon to workspace:** a server workspace ID is resolved through an
   operator-controlled local map to one canonical absolute directory.
5. **Handler to subprocess:** fixed argv and sanitized environment cross into
   Git, npm, pytest, or other profile-owned child processes.

### Protected assets

- GPT Access, operator, ActionPlan executor, and dedicated local-agent bearer
  credentials;
- configured principal, workspace, instance, and Agent identities;
- source code and uncommitted workspace changes;
- secret files and credential stores;
- canonical job and audit state;
- confirmation decisions and idempotency evidence;
- local execution journal and result evidence.

## Implemented controls

### Public and authorization boundary

- `ARCANOS:LOCAL_AGENT` is `gptAccessOnly` and has no legacy module route.
- Custom GPT execution remains under
  `/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run`.
- The gateway requires `capabilities.run` and a matching
  `MCP_ALLOW_MODULE_ACTIONS` entry.
- The principal and workspace are loaded from server configuration, not the
  action payload or conversation.
- The device is resolved from the server-side dedicated local-agent binding
  and an authoritative executor Agent record.
- The Agent must hold every required device scope for the action.
- The credential audience is fixed to `local-agent-protocol`; its only scopes
  are heartbeat, claim, job heartbeat, and result submission. It is not
  accepted by ActionPlan executor routes.
- One optional previous token may overlap during rotation only when paired
  with an ISO-8601 UTC expiry no more than 24 hours ahead.
- Python accepts only an outbound assignment whose device matches its pinned
  configuration. The assignment principal is the server-controlled requesting
  GPT Access principal; the separate executor principal is bound to the
  purpose-specific bearer credential by TypeScript.
- The daemon protocol requires HTTPS unless the existing explicit development
  HTTP setting is enabled, sends credentials only in the bearer header, and
  does not follow redirects.

### Contract and payload boundary

- TypeScript defines exact input/output JSON schemas and rejects additional
  fields.
- A generated catalog is checked by Python to prevent silent schema drift.
- Python rejects payload keys that attempt to carry principal, workspace,
  device, root, authorization, or confirmation state.
- Assignments, responses, results, strings, collections, and JSON nesting are
  bounded. The daemon accepts at most a 2 MiB backend response, 1.5 MiB
  assignment payload, 32 KiB sanitized handler output, and 48 KiB result. The
  transport headroom accounts for JSON escaping; the patch schema separately
  enforces both 200,000 characters and 200,000 UTF-8 bytes in TypeScript and
  Python.
- Successful action output is validated in Python and revalidated in
  TypeScript before the result is accepted.
- Failed results require a structured error and cannot include output.

### Confirmation and mutation boundary

- `tests.run` and `patch.apply` are privileged, confirmation-required actions.
- Every confirmation-required local-agent action is direct-capability-only;
  natural-language dispatch blocks both `tests.run` and `patch.apply`.
- `patch.apply` requires a consumed GPT Access challenge bound to the exact
  direct action and payload.
- The confirmation token is stripped by TypeScript and never appears in the
  stored payload, daemon assignment, or local journal.
- Python accepts only the server’s `confirmed` authorization decision.
- The patch handler creates an opaque, non-serializable in-process
  authorization bound to the exact canonical payload and verifies the expected
  SHA-256 before applying.
- `patch.preview` uses `git apply --check` and does not mutate files.

### Job, replay, and recovery boundary

- Local-agent jobs reuse the existing durable `job_data` store.
- Enqueue binds the principal/workspace/device/action/key tuple in
  `local_agent_job_idempotency` under a database unique constraint. Advisory
  locking is retained only for clean conflict handling.
- Atomic claim uses a transaction and `FOR UPDATE SKIP LOCKED`.
- Claim keys and result keys support exact replay; conflicting terminal
  results are rejected.
- Jobs have server-controlled expiry, action timeout, device lease, and
  heartbeat requirements.
- New work fails closed when the authoritative Agent heartbeat exceeds the
  configured TTL (90 seconds by default, clamped to 10 seconds-15 minutes).
- The daemon checks expiry before execution and result submission.
- Read-only work may be requeued after lease loss; potentially file-modifying
  work is failed for manual reconciliation instead of replayed.
- Any exception after a file-modifying execution begins is reported as
  `LOCAL_EFFECT_OUTCOME_UNKNOWN`, is non-retryable, and requires manual
  reconciliation.
- The local SQLite journal commits before side effects and before result
  submission. An interrupted unknown side effect is not automatically rerun.
- Generic worker claim, stale recovery, and failed-job requeue paths exclude
  `local-agent` jobs.
- Job state and each lifecycle/outbox event are written in the same
  transaction. Bounded batch recovery uses one savepoint per job, so an event
  failure rolls back that job and preserves per-job observability.

### Workspace and secret boundary

- Server and daemon maintain separate workspace allowlists.
- Local workspace roots must be existing absolute directories, cannot
  themselves be symlinks, and cannot be assigned to two workspace IDs.
- Relative path normalization rejects absolute paths, drives, `..`, Git
  metadata, paths outside the registered root, and symlink escapes.
- Search does not follow directory symlinks and verifies each resolved file.
- POSIX file reads walk from open directory descriptors with `O_NOFOLLOW`;
  Windows rejects reparse components before and after opening and rechecks the
  workspace identity.
- Search stops after 30 seconds, 10,000 scanned files, or 64 MiB of scanned
  file data, and reports truncation when a scan budget is exhausted.
- Shared secret-file policy excludes `.env*`, `.npmrc`, `.pypirc`, `.netrc`,
  `.ssh`, private-key names and suffixes, and
  secret/token/credential-like names.
- Git status and diff use explicit secret pathspec exclusions and filter
  returned paths.
- Patch policy rejects secret paths, Git metadata, path escapes, existing
  symlink targets, creation of symlink mode `120000`, binary patches, private
  key content, unsupported control characters, and oversized patches.

### Process and output boundary

- There is no generic shell capability.
- Test execution selects one of four fixed profiles; model input cannot supply
  argv, environment variables, or a working directory.
- Test execution has three explicit modes: default `disabled`,
  production-capable `sandboxed`, and
  `unsandboxed-development-only`. There is no automatic fallback to host
  execution. The development-only mode also requires
  `ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS=true` and is rejected under
  production or Railway markers.
- Sandboxed tests run as non-root in a disposable Docker/Podman container with
  no network or host socket, read-only base/input filesystems, tmpfs writable
  workspace, dropped capabilities, no-new-privileges, CPU/memory/process/file
  limits, timeout/cancellation cleanup, and bounded output. The configured
  image must be an immutable RepoDigest or local image ID and must pass a real
  self-test.
- Git and test processes use `shell=False`.
- Executables are resolved to existing absolute files and are rejected when
  the resolved executable is inside the registered workspace.
- The child environment is rebuilt from a small OS allowlist, resets HOME and
  USERPROFILE to the workspace, disables Git credentials/config/prompts, and
  accepts only two explicit Python environment overrides.
- Processes have a wall-clock timeout and bounded stdout/stderr capture.
- POSIX timeout handling kills the new process group. Windows timeout handling
  invokes fixed `taskkill.exe /PID <pid> /T /F` with `shell=False`, then uses a
  parent-kill fallback.
- Output sanitization removes workspace roots, bearer values, private keys,
  credential assignments, and sensitive object fields before size limiting.
- Result submission carries and verifies trace ID, request ID, and device ID.

## Hardening disposition and residual findings

### LA-01: Test sandbox — implemented, pending environment verification

- **Previous severity:** Medium; High for adversarial repositories.
- **Location:** `daemon-python/arcanos/local_agent/test_sandbox.py`,
  `daemon-python/arcanos/local_agent/secure_fs.py`,
  `daemon-python/Dockerfile.local-agent-tests`
- **Disposition:** Remediated in code. `tests.run` now has `disabled`,
  `sandboxed`, and `unsandboxed-development-only` modes. The default is
  `disabled`; production-capable configuration requires `sandboxed`, and a
  missing or unhealthy runtime fails closed.
- **Isolation:** The disposable Docker/Podman container is non-root, has no
  network or host socket, uses a read-only base and sanitized input, writes
  only to bounded tmpfs, drops all capabilities, enables
  no-new-privileges, and constrains CPU, memory, processes, file size, time,
  and output.
- **Supply chain:** The Dockerfile pins its upstream base by digest. Runtime
  configuration accepts only a verified RepoDigest or immutable local image
  ID; mutable tags are rejected.
- **Verification status:** A Linux CI job builds the image and is configured
  to exercise environment leakage, network denial, workspace isolation,
  process/memory limits, output truncation, timeout, and container cleanup.
  Do not claim the operational sandbox ready until that job and the intended
  device self-test pass.
- **Residual:** Container-runtime or kernel vulnerabilities remain outside the
  application boundary. Do not mount a host socket, enable privileged mode, or
  use host execution on a sensitive machine.

### LA-02: Dedicated executor audience — remediated

- **Previous severity:** Medium.
- **Location:** `src/services/actionPlanExecution/auth.ts`,
  `src/routes/gpt-access-local-agent.ts`,
  `daemon-python/arcanos/local_agent/protocol.py`
- **Disposition:** Local-agent routes now require
  `ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN`, role
  `local-agent-executor`, audience `local-agent-protocol`, and one of four
  fixed scopes: heartbeat, claim, job heartbeat, or result. The credential
  cannot authenticate as an ActionPlan executor.
- **Rotation/revocation:** One previous token may overlap for no more than 24
  hours and is accepted only before its explicit expiry. Removing the
  credential or the Agent capability grant revokes access. Current and
  previous tokens are rejected when they collide with GPT Access or any
  ActionPlan role credential.
- **Residual:** Credential theft remains possible at the host boundary. Store
  it only in the backend/daemon secret stores, rotate after device loss, and
  monitor the credential version and device identity in audit records.

### LA-03: Database-authoritative idempotency — implemented, migration pending

- **Previous severity:** Medium defense in depth.
- **Location:** `src/core/db/repositories/localAgentJobRepository.ts`,
  `migrations/20260724_local_agent_job_hardening_v1`
- **Disposition:** The migration creates
  `local_agent_job_idempotency` with an explicit unique constraint over
  principal, workspace, device, action, and key hash, a unique job binding,
  expiry index, retained request fingerprint, and deferred cascade foreign key
  to `job_data`. Advisory locks remain only an optimization.
- **Semantics:** Identical repeats return the bound job/result; a changed
  canonical request conflicts; expired terminal bindings may be reused only
  under the documented retention rules. Cleanup removes eligible expired
  bindings in bounded batches.
- **Deployment gate:** The repository fails closed when the binding table is
  unavailable. Apply and verify the reviewed migration only against proven
  preview PostgreSQL before E2E. No database migration has been applied yet.

### LA-04: Per-job expiry events — remediated

- **Previous severity:** Low.
- **Location:** `src/core/db/repositories/localAgentJobRepository.ts`,
  `src/core/db/repositories/jobEventRepository.ts`
- **Disposition:** Creation, claim/start, terminal result, expiry, and
  lease-recovery transitions now persist their per-job lifecycle event in the
  same transaction as job state. Expired pre-execution work emits
  `job.expired`; uncertain mutation outcomes emit `job.failed` with manual
  reconciliation evidence.
- **Partial failure behavior:** Bounded batch recovery uses one savepoint per
  candidate. If an event write fails, that job’s transition rolls back while
  the remaining candidates can continue; events are not collapsed into one
  opaque aggregate.

### LA-05: Symlink and TOCTOU read coverage — implemented, Linux gate pending

- **Previous severity:** Low.
- **Location:** `daemon-python/arcanos/local_agent/secure_fs.py`,
  `daemon-python/tests/test_local_agent_sandbox_security.py`,
  `.github/workflows/ci-cd.yml`
- **Disposition:** POSIX reads walk path components relative to open directory
  descriptors with no-follow flags. Coverage includes file links, directory
  links, chained links, secret targets, and file/intermediate-directory swaps
  after validation. The dedicated Linux job runs this suite where symlink
  creation is available.
- **Windows behavior:** Reparse points and root identities are checked before
  and after open, but Python does not expose an equivalent descriptor-relative
  Win32 directory walk. Windows link tests may still require Developer Mode or
  elevated privilege.
- **Verification status:** The Linux gate is present; record its actual run in
  the preview E2E report. Until then, do not represent the new CI coverage as
  executed evidence.

### LA-06: `patch.apply` is not descriptor-atomic

- **Severity:** Medium when another local process can mutate the registered
  workspace concurrently; Low for a private daemon-owned fixture.
- **Location:** `daemon-python/arcanos/local_agent/patch_handler.py`
- **Evidence:** The handler validates target/root identities before and after
  `git apply`, rejects links/reparse points, binds authorization to the exact
  payload, and verifies the patch SHA-256. The external Git process still
  performs path-based mutation.
- **Impact:** A hostile local writer could swap a target component between
  validation and mutation. Post-apply validation may detect the change, but it
  cannot make the mutation descriptor-atomic or guarantee that no unintended
  write occurred.
- **Required mitigation:** Keep registered mutation workspaces private to the
  daemon account, exercise preview mutation only on a disposable fixture,
  preserve backups/evidence, and require manual reconciliation for any
  uncertain outcome.
- **Future option:** A descriptor-relative or transactional patch writer would
  require separate architectural and compatibility review to preserve Git
  patch semantics.

## Operational security requirements

Before enabling the bridge:

- use independent, high-entropy GPT Access, operator, ActionPlan executor, and
  local-agent executor tokens;
- run the Python daemon as a dedicated non-administrator account;
- register only intended absolute workspaces and narrow allowed directories
  further when practical;
- grant only the actions required by that device;
- keep `ARCANOS_LOCAL_AGENT_ENABLED=false` until backend identity, Agent
  registration, and workspace mapping are complete;
- keep `ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE=disabled` until an immutable
  sandbox image and Docker/Podman self-test succeed;
- require `sandboxed` for production-capable `tests.run`; never enable
  `unsandboxed-development-only` on a machine containing sensitive data;
- keep development HTTP disabled outside localhost;
- do not expose the daemon or legacy loopback CLI bridge to the internet;
- review `patch.preview` and its SHA-256 before confirming `patch.apply`;
- monitor job expiry, manual-reconciliation markers, heartbeat loss, and
  unexpected result rejection;
- rotate the dedicated local-agent credential after device loss, journal
  compromise, or anomalous protocol activity; remove the previous token as
  soon as the daemon heartbeat proves the new token works.

## Deployment security gate

No deployment, migration, or Railway variable change has occurred for this
hardening work yet.
The current read-only Railway selection is:

```text
Project:     Arcanos
Environment: phase2e-validation-20260717
Service:     phase2e-redis-r2-20260718
```

That is the Phase 2E Redis validation service, not the API, worker, PostgreSQL,
Redis, or migration target for this bridge. It must not be modified. A preview
must use a fresh isolated environment with preview-owned PostgreSQL, Redis,
credentials, services, and domain; reject inherited production references
before any migration or deployment. The Python daemon remains local and
outbound.

## Review disposition

The implementation meets the core architectural requirements: TypeScript is
the public authority, Python is not public and does not own canonical state,
existing job and authorization systems are reused, authority fields are
server controlled, confirmation-required local actions are direct-only,
patches require exact confirmation, tests are default-disabled and
production-sandboxed, the daemon credential has a dedicated narrow audience,
idempotency is database-enforced after migration, per-job expiry events share
the state transaction, and no generic command capability is exposed.

The implementation still needs isolated preview migration/deployment, the
actual Linux sandbox/link test run, and E2E evidence. The main remaining code
risk is that `patch.apply` delegates path-based mutation to Git and therefore
cannot provide descriptor-atomic protection against a hostile concurrent local
writer.
