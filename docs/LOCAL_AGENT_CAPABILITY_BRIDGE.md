# ARCANOS Local-Agent Capability Bridge

## Purpose

The local-agent bridge lets a Custom GPT request a small, fixed set of
repository operations that execute on a paired Python daemon. It extends the
existing ARCANOS control plane; it does not create another public API, queue,
workflow engine, or authorization system.

The implemented path is:

```text
Custom GPT
  -> GPT Action
  -> /gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run
  -> TypeScript authentication, scope, allowlist, confirmation, audit, trace
  -> existing job_data durable job
  -> outbound Python daemon claim
  -> allowlisted Python handler
  -> bounded structured result
  -> /gpt-access/jobs/result
```

TypeScript remains authoritative for public contracts, identity, workspace
selection, authorization, confirmation, idempotency, job lifecycle, and
result ownership. Python receives only a server-authorized job and never
exposes an internet-facing GPT endpoint or connects directly to PostgreSQL.

## Architectural assessment

The repository already contained the required control-plane foundations:

- the GPT Access Gateway and capability registry;
- risk-based confirmation challenges;
- authenticated ActionPlan requester/operator identities plus a dedicated
  local-agent executor audience;
- an authoritative Agent registry with capability grants and heartbeats;
- PostgreSQL-backed `job_data`, job events, leases, and result polling;
- request IDs, trace IDs, structured audit context, and output sanitization;
- a Python daemon with repository tools, patch policy, CLI/voice lifecycle,
  and backend clients.

The bridge therefore fits as an additive protected module:

```text
GPT Access Gateway
  -> ARCANOS:LOCAL_AGENT
  -> local-agent job specialization in job_data
  -> registered executor Agent
  -> outbound daemon polling thread
  -> shared Python handler registry
```

`ARCANOS:LOCAL_AGENT` declares `gptAccessOnly: true` and
`exposeLegacyRoute: false`. It cannot be invoked through the legacy module
routes. The generic worker claim, stale-job recovery, and failed-job requeue
paths exclude `job_type = 'local-agent'`; the local-agent claim protocol owns
that lifecycle without introducing a second server-side queue.

### Reuse and refactoring map

| Existing implementation | Bridge disposition | Result |
| --- | --- | --- |
| GPT Access bearer authentication, scopes, module allowlist, confirmation, tracing, and audit context | Reused directly | Custom GPTs still enter only through `/gpt-access/*`. |
| Module loader and capability registry | Extended with typed action metadata | The public registry now carries input/output schemas, execution target, timeout, device scopes, read-only state, and file-mutation state. |
| `job_data` and protected job-result polling | Reused with a local-agent job specialization | Durable enqueue, claim, lease, expiry, idempotency, result persistence, and GPT polling use existing storage. |
| ActionPlan authentication utilities and authoritative Agent registry | Extended surgically | The daemon has a separate `local-agent-protocol` audience and credential class pinned to one principal, instance, and Agent/device ID. It cannot authenticate as an ActionPlan executor. |
| `search_repository`, `get_repository_status`, and `get_repository_diff` | Wrapped directly by the typed handler registry | Repository search and Git reads retain the existing Python implementations and policy. |
| `validate_patch_text` and `config/cli-policy.json` | Reused directly | Patch size, secret path, traversal, Git metadata, binary patch, bidi-control, and symlink-mode rules remain shared. |
| Patch apply logic formerly embedded in CLI paths | Extracted into `local_agent/patch_handler.py` | The interactive `PatchOrchestrator`, loopback `LocalBridge`, and backend job handler share one preview/authorized-apply core. |
| Daemon CLI lifecycle | Extended with an opt-in outbound thread | Existing CLI/voice behavior remains; setting `ARCANOS_LOCAL_AGENT_ENABLED=true` adds polling without opening an inbound listener. |
| Local status and fixed test profiles | Added as bridge-specific handlers | These are new operations, but they use the same typed registry and bounded process runner as the reused handlers. |

No duplicate repository search, Git status, Git diff, or patch-policy
implementation was added.

## Capability contracts

`src/services/localAgent/contracts.ts` is the TypeScript source of truth. Every
action uses `executionTarget: python-daemon` and is idempotent. The generated
catalog is copied to:

- `packages/protocol/schemas/v1/local-agent/capability-catalog.generated.json`
- `daemon-python/arcanos/local_agent/capability-catalog.generated.json`

The Python loader compares the packaged catalog with the repository copy and
validates every request and result against the generated schemas.

For every action, `idempotent: true` means the backend hashes an explicit
GPT Access idempotency key, or derives one from the request ID and action,
scopes it to principal/workspace/device/action, and compares the complete
request fingerprint. The same key and request reuse the in-flight or retained
terminal job; the same key with a different request is rejected. The current
retention window is 24 hours.

| Action | Purpose | Input | Output | Risk | Confirmation | Timeout | Required device scope | Read-only | May modify files |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| `local_agent.status` | Read paired-agent readiness and workspace registration | Empty object | Daemon readiness, version, capabilities, workspace registration, test execution mode, sandbox availability/runtime, observation time | `readonly` | No | 10 s | `local_agent.status` | Yes | No |
| `repo.search` | Search bounded text or symbols in the registered workspace | `query`; optional bounded search type, relative path, hidden-file flag, offset, limit, and file-size limit | Bounded path/line/column previews, pagination, searched-file count, truncation | `readonly` | No | 30 s | `repo.search` | Yes | No |
| `git.status` | Read sanitized Git branch and worktree status | Empty object | Sanitized branch, HEAD, worktree changes, Git availability, workspace type | `readonly` | No | 15 s | `git.status` | Yes | No |
| `git.diff` | Read a bounded sanitized diff between validated refs | Required safe `base` and `head`; optional context lines and byte limit | Bounded diff, byte count, truncation | `readonly` | No | 30 s | `git.diff` | Yes | No |
| `tests.run` | Run one fixed allowlisted test profile under the configured fail-closed execution mode | One profile: `python-unit`, `typescript-unit`, `typescript-integration`, or `backend-cli-contract` | Profile, pass/fail/timeout state, exit code, bounded stdout/stderr, duration | `privileged` | Yes | 900 s | `tests.run` | No | Yes |
| `patch.preview` | Validate and dry-run a patch without mutation | Non-empty unified diff, at most 200,000 characters and 200,000 UTF-8 bytes | Patch SHA-256, targeted files, applicability, bounded `git apply --check` result | `readonly` | No | 30 s | `patch.preview` | Yes | No |
| `patch.apply` | Apply one exact validated and confirmed patch | Exact bounded patch plus its 64-hex-character `expectedPatchSha256` | Applied patch SHA-256, targeted files, `applied: true` | `privileged` | Yes | 60 s | `patch.apply` | No | Yes |

Important input bounds include:

- `repo.search` returns at most 200 matches per request, rejects symlink
  candidates, does not accept an absolute path or `..` traversal, and stops
  after 30 seconds, 10,000 scanned files, or 64 MiB of scanned file data;
- `git.diff` accepts only validated single Git refs, 0-20 context lines, and a
  maximum 65,536-byte returned diff;
- `tests.run` selects a fixed profile and never accepts command text or
  arbitrary arguments. `ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE` defaults to
  `disabled`; production-capable use requires `sandboxed`. The
  `unsandboxed-development-only` mode also requires
  `ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS=true` and is rejected in
  production or Railway;
- patch payloads reject additional authority fields and remain subject to the
  shared CLI patch policy.

`tests.run` is marked as file-modifying because repository test scripts can
write artifacts even when their intended purpose is validation. In
`sandboxed` mode the daemon stages a bounded, secret-free, link-free read-only
snapshot and runs the profile in a disposable writable workspace. Writes are
discarded with the container. `unsandboxed-development-only` remains an
explicit local developer escape hatch, not a production mode.

The fixed profiles resolve only to:

| Profile | Fixed operation |
| --- | --- |
| `python-unit` | Current Python interpreter with `-m pytest tests/` under `daemon-python` |
| `typescript-unit` | `npm run test:unit` |
| `typescript-integration` | `npm run test:integration` |
| `backend-cli-contract` | `npm run build:packages`, then `npm run validate:backend-cli:contract` |

## Protocol and job lifecycle

### GPT-facing operations

The Custom GPT imports the dynamic document at:

```text
GET /gpt-access/openapi.json
```

The relevant public operations are:

```text
GET  /gpt-access/capabilities/v1
GET  /gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT
POST /gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run
POST /gpt-access/jobs/result
```

The generated OpenAPI capability metadata includes both the input and output
schemas and the full execution metadata. The run operation returns a durable
`jobId`; the GPT polls the existing job-result operation until the job is
completed, failed, expired, or cancelled.

Example read request:

```json
{
  "action": "git.status",
  "payload": {}
}
```

An accepted asynchronous response contains the action, `jobId`, status,
expiry, trace ID, request ID, dedupe information, and
`poll: "/gpt-access/jobs/result"`.

The GPT polls with:

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000"
}
```

### Daemon-only operations

The paired Python daemon uses authenticated local-agent executor endpoints:

```text
POST /gpt-access/local-agent/heartbeat
POST /gpt-access/local-agent/jobs/claim
POST /gpt-access/local-agent/jobs/{jobId}/heartbeat
POST /gpt-access/local-agent/jobs/{jobId}/result
```

These routes are not a second public GPT API. They accept only the dedicated
`ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN`, require the
`local-agent-protocol` audience and the exact route scope, pin the credential
to the configured principal/instance/device ID, apply `Cache-Control:
no-store`, and validate bounded protocol objects. The four fixed credential
scopes are heartbeat, claim, job heartbeat, and result submission. The token
cannot authenticate to ActionPlan executor routes. The client does not follow
redirects and requires HTTPS unless the existing explicit
localhost/development HTTP setting is enabled.

Credential rotation supports one optional previous token with an explicit
ISO-8601 UTC expiry no more than 24 hours in the future. The previous token
uses the same narrow audience and route scopes. Configure both previous-token
fields together, move the daemon to the current token, then remove the
previous-token fields after the overlap.

### Server-controlled assignment

The model-supplied payload contains only the action inputs declared above.
TypeScript adds:

- protocol version and job ID;
- action and validated payload;
- configured GPT Access principal and workspace;
- registered device ID;
- trace ID and request ID;
- idempotency key;
- authorization decision and opaque evidence ID;
- expiry time and timeout;
- required device scopes;
- read-only and file-mutation flags.

Payload fields that attempt to provide principal, workspace, device,
repository root, authorization, or confirmation state are rejected. The
confirmation token is never stored in the action payload or sent to Python.

### Claim, lease, expiry, and replay

Local-agent jobs use `job_data` with `job_type = 'local-agent'`.

- Enqueue uses the `local_agent_job_idempotency` binding table. Its unique
  principal/workspace/device/action/key constraint is authoritative; an
  advisory lock remains only an optimization for clean conflict handling.
- Claim selection uses `FOR UPDATE SKIP LOCKED` and one claim key.
- The registered device must possess every action scope before it can claim.
- Device and job heartbeats maintain the Agent heartbeat and the job lease.
  New work fails closed when the Agent heartbeat is older than
  `ARCANOS_LOCAL_AGENT_HEARTBEAT_TTL_MS` (default 90 seconds, clamped to
  10 seconds-15 minutes).
- The daemon checks job expiry before execution, after its initial job
  heartbeat, and before result submission.
- A completed result can be replayed only with the same result key and
  fingerprint.
- Read-only work whose lease expires may be returned to pending.
- A file-modifying job that loses its lease or expires after execution begins
  is failed and marked for manual reconciliation rather than executed again.
- Offline devices do not cause direct execution; jobs remain durable until a
  valid device claims them or their expiry is reconciled.
- Job state changes and their per-job lifecycle/outbox events share one
  PostgreSQL transaction. Bounded expiry/lease recovery uses one savepoint per
  candidate so one failed event write rolls back that job without collapsing
  the remaining jobs into an opaque aggregate.

The daemon maintains a private SQLite execution journal under its configured
data directory. It commits the assignment before side effects, records
`EXECUTION_STARTED` before invoking the handler, persists a result before
submitting it, and records the server acceptance receipt. If the daemon
restarts after execution began but before the outcome was durably known, it
reports an unknown outcome instead of replaying the side effect.

### Result contract

Success results contain:

```text
protocolVersion
resultKey
outcome = succeeded
output
durationMs and outputTruncated
traceId, requestId, and deviceId
```

Failures contain a stable code, classification, bounded message, retryable
flag, metrics, and the same correlation fields. A failed result cannot also
contain output. TypeScript revalidates successful action output against the
authoritative output schema before accepting it.

## Confirmation behavior

All confirmation-required local-agent actions currently consist of
`tests.run` and `patch.apply`. Both are direct-capability-only: the
natural-language dispatcher blocks them before execution, so confirmation
cannot be obtained through semantic dispatch. They pass through the existing
GPT Access confirmation gate. `patch.apply` has an additional strict rule: it
must use a consumed confirmation challenge bound to the exact direct
capability action and payload.

The supported flow is:

1. Call the direct capability endpoint with `tests.run` or `patch.apply` and
   the proposed payload.
2. On `CONFIRMATION_REQUIRED`, stop. Do not execute or alter the payload.
3. After explicit operator approval, retry the same POST exactly once with the
   unchanged action and payload plus the raw challenge ID in the top-level
   `confirmation_token` field.
4. The gateway consumes and strips that token, verifies the exact request, and
   records only server confirmation evidence in the job.
5. Python requires `authorization.decision = confirmed`. For `patch.apply`,
   it also issues a non-serializable in-process authorization sealed to the
   exact payload and verifies `expectedPatchSha256` before `git apply`.
6. Stop if the retry fails or produces another confirmation challenge.

Natural-language dispatch deliberately rejects every confirmation-required
`ARCANOS:LOCAL_AGENT` action. In particular, a semantic re-plan cannot
regenerate or change a patch after approval.

## Local security controls

The bridge enforces:

- a server allowlist of workspace IDs and a separate local JSON mapping from
  those IDs to absolute roots;
- canonical root identity, no symlink/reparse-point workspace roots, traversal
  rejection, and symlink escape checks;
- shared secret-file denial for `.env*`, credential files/directories, private
  keys, token/secret/credential-like names, and Git metadata;
- Git pathspec exclusions and sanitized repository output;
- descriptor-relative, no-follow reads on POSIX plus pre/post-open identity and
  reparse checks on Windows; Linux tests cover file, directory, chained,
  secret-target, and post-validation link swaps;
- repository search symlink denial plus fixed 30-second, 10,000-file, and
  64-MiB aggregate scan budgets;
- a fixed Python handler allowlist and fixed test profile argv;
- three explicit test modes: default `disabled`, production-capable
  `sandboxed`, and `unsandboxed-development-only` with a separate opt-in;
- a disposable Docker/Podman sandbox with no network or host socket, a
  read-only base and input snapshot, tmpfs workspace, non-root UID, dropped
  capabilities, no-new-privileges, CPU/memory/process/file-size limits,
  timeout/cancellation cleanup, and bounded output;
- `shell=False`, an executable resolved outside the workspace, a minimal
  inherited environment, disabled Git credential prompting/config,
  wall-clock timeouts, and bounded captured output;
- a 2 MiB backend-response limit, 1.5 MiB assignment-payload limit,
  32 KiB sanitized action-output limit, and 48 KiB daemon-result limit; the
  larger transport bounds accommodate JSON escaping while the patch itself
  remains limited to 200,000 UTF-8 bytes;
- output redaction for bearer values, key/token/password assignments, private
  keys, sensitive object keys, and absolute workspace roots;
- assignment, response, and result size/depth limits;
- one-time claim semantics, expiry, lease heartbeats, idempotent result
  acceptance, and crash-safe local evidence;
- a database-unique local-agent idempotency binding and per-job transactional
  lifecycle events, including expiry/reconciliation;
- `LOCAL_EFFECT_OUTCOME_UNKNOWN`, no automatic retry, and required manual
  reconciliation when an exception occurs after a file-modifying execution
  begins;
- audit/event correlation by action, device, principal, workspace, trace ID,
  request ID, and job ID.

See
[`security/LOCAL_AGENT_CAPABILITY_BRIDGE_SECURITY_REVIEW.md`](security/LOCAL_AGENT_CAPABILITY_BRIDGE_SECURITY_REVIEW.md)
for implemented controls and residual risks.

## File-level implementation plan and map

| File or area | Responsibility |
| --- | --- |
| `src/services/localAgent/contracts.ts` | TypeScript-authoritative action catalog, input/output schemas, validation, and execution metadata |
| `src/services/arcanos-local-agent.ts` | Protected `ARCANOS:LOCAL_AGENT` module and trusted-context validation |
| `src/services/localAgent/service.ts` | Server-controlled envelope creation, confirmation evidence, fingerprints, idempotency, and durable enqueue |
| `src/services/actionPlanExecution/auth.ts` | Dedicated local-agent credential/audience, narrow protocol scopes, rotation overlap, and separation from ActionPlan roles |
| `src/services/localAgent/devicePolicy.ts` | Workspace allowlist, fresh-heartbeat requirement, and authoritative Agent/device binding |
| `src/services/localAgent/protocol.ts` | Claim/result validation, fingerprints, and result receipts |
| `src/core/db/repositories/localAgentJobRepository.ts` | `job_data` enqueue, atomic claims, leases, expiry recovery, result acceptance, and job events |
| `src/routes/gpt-access-local-agent.ts` | Executor-only heartbeat, claim, job-heartbeat, and result routes |
| `src/routes/gpt-access.ts` and `src/services/gptAccessGateway.ts` | Capability exposure, strict confirmation, OpenAPI metadata, and GPT job-result ownership |
| `src/services/moduleLoader.ts` and `src/routes/modules.ts` | Extended metadata and fail-closed GPT-only module dispatch |
| `src/core/db/repositories/jobRepository.ts` | Exclusion of local-agent jobs from generic worker/recovery/requeue paths |
| `src/dispatcher/naturalLanguage/policy.ts` | Direct-only rule for every confirmation-required local-agent action |
| `scripts/generate-local-agent-capability-catalog.mjs` | Deterministic TypeScript-to-Python catalog generation and drift check |
| `daemon-python/arcanos/local_agent/contracts.py` | Python validation against the generated catalog |
| `daemon-python/arcanos/local_agent/protocol.py` | Outbound authenticated HTTP client and assignment/result parser |
| `daemon-python/arcanos/local_agent/runner.py` | Poll, heartbeat, validation, execution, sanitization, recovery, and result submission |
| `daemon-python/arcanos/local_agent/journal.py` | Private crash-safe local execution journal |
| `daemon-python/arcanos/local_agent/workspace_registry.py` | Operator-controlled workspace resolution and path/secret policy |
| `daemon-python/arcanos/local_agent/secure_fs.py` | Descriptor-safe POSIX reads, Windows reparse checks, stable root identity, and sanitized snapshot staging |
| `daemon-python/arcanos/local_agent/handlers.py` | Fixed typed handler registry and test profiles |
| `daemon-python/arcanos/local_agent/process_runner.py` | Fixed-argv subprocesses, sanitized environment, timeout, and output bounds |
| `daemon-python/arcanos/local_agent/test_sandbox.py` and `daemon-python/Dockerfile.local-agent-tests` | Fail-closed execution modes and disposable Docker/Podman test sandbox |
| `daemon-python/arcanos/local_agent/patch_handler.py` | Shared preview and exact-authorized patch application |
| `daemon-python/arcanos/protocol_runtime/tools/repository_tools.py` | Reused repository/Git handlers with bridge-compatible bounds |
| `daemon-python/arcanos/agentic/patch_orchestrator.py` and `daemon-python/arcanos/cli/local_bridge.py` | Existing Python entry points refactored to reuse the shared patch core |
| `daemon-python/arcanos/config.py`, `cli/cli.py`, and `cli/daemon_ops.py` | Opt-in outbound local-agent daemon lifecycle |
| `tests/local-agent-*.test.ts` and `daemon-python/tests/test_local_agent_*.py` | Contract, policy, protocol, lifecycle, security, and handler coverage |

## Local setup

### 1. Build and configure the backend

Install and build through the repository’s normal workflow:

```powershell
npm install
npm run build:packages
npm run build
```

Configure the backend out of band. Values shown here are identifiers or
placeholders, not credentials:

```env
ARCANOS_GPT_ACCESS_PRINCIPAL_ID=operator:primary
ARCANOS_GPT_ACCESS_WORKSPACE_ID=personal
ARCANOS_GPT_ACCESS_SCOPES=capabilities.read,capabilities.run,jobs.result,runtime.read,diagnostics.read
MCP_ALLOW_MODULE_ACTIONS=ARCANOS:LOCAL_AGENT:*

ENABLE_ACTION_PLANS=true
ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN=<independently-generated-local-agent-token>
ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID=local-agent:executor
ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID=local-agent:workstation-1
ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID=<registered-executor-agent-uuid>

ARCANOS_LOCAL_AGENT_WORKSPACES=personal
ARCANOS_LOCAL_AGENT_JOB_TTL_MS=1200000
ARCANOS_LOCAL_AGENT_LEASE_MS=30000
ARCANOS_LOCAL_AGENT_HEARTBEAT_TTL_MS=90000
```

An `ACTION_PLAN_OPERATOR_TOKEN`/principal binding is required when using the
existing operator endpoint to register or manage the Agent. A requester
binding is not required by this bridge. Any ActionPlan roles that are
configured must have complete, distinct credentials and principal IDs. The
GPT Access bearer remains separate; do not reuse GPT Access, requester,
operator, ActionPlan executor, and local-agent executor tokens. The
local-agent token authenticates only to the `local-agent-protocol` audience
with heartbeat, claim, job-heartbeat, and result scopes.

For a bounded token rotation, configure a new current token on the backend,
retain the old value only in
`ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN`, and set
`ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT` to an ISO-8601 UTC
timestamp no more than 24 hours ahead. Move the daemon to the new current
token, verify its heartbeat, then remove both previous-token variables.

### 2. Register the executor Agent

Use the existing operator-authenticated `POST /agents/register` endpoint with
role `executor` and only the capabilities the device needs:

```json
{
  "role": "executor",
  "capabilities": [
    "local_agent.status",
    "repo.search",
    "git.status",
    "git.diff",
    "tests.run",
    "patch.preview",
    "patch.apply"
  ]
}
```

Use the returned Agent ID for `ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID` on both
the backend and daemon. Narrower Agent grants and daemon allowlists are
supported and preferred when a device does not need every action.

### 3. Configure the Python daemon

From `daemon-python/.env.example`, configure:

```env
ARCANOS_LOCAL_AGENT_ENABLED=true
BACKEND_URL=https://<backend-host>

ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN=<same-local-agent-token-as-backend-binding>
ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID=local-agent:executor
ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID=local-agent:workstation-1
ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID=<registered-executor-agent-uuid>

ARCANOS_LOCAL_AGENT_ACTIONS=local_agent.status,repo.search,git.status,git.diff,tests.run,patch.preview,patch.apply
ARCANOS_LOCAL_AGENT_DEVICE_SCOPES=local_agent.status,repo.search,git.status,git.diff,tests.run,patch.preview,patch.apply
ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE=disabled
ARCANOS_LOCAL_AGENT_SANDBOX_RUNTIME=
ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE=
ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS=false
ARCANOS_LOCAL_AGENT_WORKSPACES_JSON={"personal":"C:\\work\\Arcanos"}
ARCANOS_LOCAL_AGENT_POLL_INTERVAL_SECONDS=5
ARCANOS_LOCAL_AGENT_HEARTBEAT_SECONDS=10
```

`ARCANOS_LOCAL_AGENT_WORKSPACES_JSON` must map each server workspace ID to an
existing absolute local directory. The root itself cannot be a symlink.
`tests.run` remains unavailable while its mode is `disabled`.

For production-capable `tests.run`, build the dedicated image from the
repository root. The Dockerfile pins its upstream base by digest:

```powershell
docker build --file daemon-python/Dockerfile.local-agent-tests --tag arcanos-local-agent-tests:local .
docker image inspect --format '{{.Id}}' arcanos-local-agent-tests:local
```

Podman uses the equivalent commands:

```powershell
podman build --file daemon-python/Dockerfile.local-agent-tests --tag arcanos-local-agent-tests:local .
podman image inspect --format '{{.Id}}' arcanos-local-agent-tests:local
```

Copy only the returned immutable `sha256:<64-hex>` image ID into
`ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE`, set
`ARCANOS_LOCAL_AGENT_SANDBOX_RUNTIME=docker` or `podman`, and change the mode
to `sandboxed`. A registry deployment may instead use a verified
`name@sha256:<64-hex>` RepoDigest. Mutable tags are rejected. The daemon runs a
real sandbox self-test before reporting the runtime available; failure never
falls back to host execution.

Start the existing daemon normally:

```powershell
Set-Location daemon-python
arcanos
```

The feature is disabled by default. Enabling it starts an outbound polling
thread only.

### 4. Verify without mutation

1. Confirm the daemon heartbeat is current through the existing Agent status
   interface.
2. Import `/gpt-access/openapi.json` into the Custom GPT Action.
3. Discover `ARCANOS:LOCAL_AGENT`.
4. Run `local_agent.status`, then poll the returned `jobId`.
5. Run `git.status` or a narrow `repo.search`.
6. Use `patch.preview` before considering `patch.apply`.

Do not use `patch.apply` until the exact confirmation flow has been tested in
the intended environment.

### 5. Run the isolated preview verifier

The preview verifier accepts only explicit preview resource identities and
fixed read-only Railway inspection commands. The preview GPT Access bearer is
read only from `ARCANOS_PREVIEW_GPT_ACCESS_TOKEN`; never pass it on the command
line. Its scopes must include `capabilities.read`, `capabilities.run`,
`jobs.result`, `runtime.read`, and `diagnostics.read`. Do not grant
`workers.read` to the verifier token: discovery intentionally proves that
scope fails closed.

The preview API must publish the exact worker deployment it expects to share
the queue with. Configure these non-secret values on the API service from the
explicitly selected worker deployment:

```env
ARCANOS_WORKER_SERVICE_ID=<preview-worker-service-id>
ARCANOS_WORKER_SERVICE_NAME=<preview-worker-service-name>
ARCANOS_WORKER_DEPLOYMENT_ID=<preview-worker-deployment-id>
ARCANOS_WORKER_GIT_COMMIT_SHA=<same-tested-commit-as-api>
```

Run discovery first. Supply every identity from the selected preview
environment rather than relying on the current Railway service link:

```powershell
$env:ARCANOS_PREVIEW_GPT_ACCESS_TOKEN='<preview-only-bearer>'
npm run preview:e2e -- --mode discovery `
  --base-url https://<preview-api-domain> `
  --project-id <preview-project-id> `
  --environment-id <preview-environment-id> `
  --environment-name <preview-environment-name> `
  --api-service-id <preview-api-service-id> `
  --api-service-name <preview-api-service-name> `
  --api-deployment-id <preview-api-deployment-id> `
  --worker-service-id <preview-worker-service-id> `
  --worker-service-name <preview-worker-service-name> `
  --worker-deployment-id <preview-worker-deployment-id> `
  --postgres-service-id <preview-postgres-service-id> `
  --postgres-service-name <preview-postgres-service-name> `
  --redis-service-id <preview-redis-service-id> `
  --redis-service-name <preview-redis-service-name> `
  --commit-sha <tested-commit-sha>
```

`readonly` mode requires `--patch-file`. The patch must be an applicable,
harmless patch for a disposable fixture repository registered to the preview
daemon; never use the main working repository. The verifier checks
`patch.preview` applicability and compares `git.status` before and after the
preview. It also validates every local-agent job through the sanitized
`/gpt-access/jobs/timeline` endpoint.

```powershell
npm run preview:e2e -- --mode readonly `
  <the same explicit preview identity arguments> `
  --patch-file C:\path\to\disposable-fixture.patch `
  --expected-test-mode disabled
```

`--expected-test-mode` defaults to `disabled`. Use `sandboxed` only after the
daemon reports an available Docker or Podman sandbox. The verifier rejects a
degraded daemon, an unregistered workspace, catalog or contract drift,
non-ready API/Redis state, missing job/trace/action correlation, or any
confirmation challenge. `unsandboxed-development-only` is never a
production-capable preview configuration.

## Database impact

The bridge continues to use the existing `job_data`, job-event, and
authoritative Agent persistence. Hardening adds the reviewed
`20260724_local_agent_job_hardening_v1` migration. It creates
`local_agent_job_idempotency`, whose explicit
principal/workspace/device/action/key uniqueness is the authoritative duplicate
barrier, plus an expiry index and a deferred cascade foreign key to
`job_data`. Advisory locking remains an optimization.

Job creation, claim, terminal result, expiry, and lease recovery now persist
the job state and its per-job lifecycle event in the same transaction. Batch
recovery is bounded and uses per-job savepoints so an event failure rolls back
that job while other candidates remain independently observable.

Validate the migration artifacts without a database:

```powershell
npm run db:local-agent-hardening:plan
```

After provisioning a fresh isolated preview PostgreSQL target, set
`LOCAL_AGENT_HARDENING_PREVIEW_TARGET=true` on that service. Apply and verify
only through Railway's service-bound variables and explicit resource IDs:

```powershell
railway run --no-local --project <preview-project-id> --environment <preview-environment-id> --service <preview-postgres-service-id> -- npm run db:local-agent-hardening:apply-preview -- --confirm-preview --expected-project-id <preview-project-id> --expected-environment-id <preview-environment-id> --expected-postgres-service-id <preview-postgres-service-id>
railway run --no-local --project <preview-project-id> --environment <preview-environment-id> --service <preview-postgres-service-id> -- npm run db:local-agent-hardening:verify-preview -- --confirm-preview --expected-project-id <preview-project-id> --expected-environment-id <preview-environment-id> --expected-postgres-service-id <preview-postgres-service-id>
```

The migration runner uses only the selected service's injected
`DATABASE_PUBLIC_URL`, verifies it against that service's generated PostgreSQL
connection identity, rejects production-like targets and the known Phase 2E
validation target, verifies the reviewed checksum, and never needs a database
URL on the command line. The daemon’s SQLite journal remains private local
execution evidence; it is not canonical ARCANOS state, a server queue, or a
PostgreSQL replacement.

## Railway deployment plan

No Railway deployment, migration, variable change, or privileged operation has
been performed for this hardening work yet.

A read-only Railway status check reported:

```text
Project:     Arcanos
Environment: phase2e-validation-20260717
Service:     phase2e-redis-r2-20260718
```

That linked service is the Phase 2E Redis validation service, not the ARCANOS
API deployment target. Do not deploy the bridge from that selection.

For an isolated operator-approved preview:

1. Create or select a fresh preview environment and explicitly identify its
   API, worker, PostgreSQL, and Redis services. Do not rely on the current CLI
   link.
2. Keep the Python daemon on the registered local device. Do not deploy it as
   a public Railway service.
3. Prove the preview PostgreSQL and Redis are preview-owned and reject every
   inherited production URL, token, webhook, or third-party credential.
4. Configure the preview API’s GPT Access context, capability scopes,
   `MCP_ALLOW_MODULE_ACTIONS`, dedicated local-agent credential, workspace
   allowlist, and preview-only dependency references without printing secret
   values.
5. Apply and verify the hardening migration only through the preview-target
   command above.
6. Register or verify the preview-only executor Agent and its narrow
   capability grants.
7. Run the schema-generation drift check, focused tests, Linux sandbox/link
   tests, boundary checks, full build, and `npm run validate:railway`.
8. Deploy the exact tested commit with explicit project, environment, and
   service selection.
9. Verify `local_agent.status`, one read-only repository action, expiry
   behavior for an offline daemon, and exact confirmation in the preview.

Do not use the Phase 2E Redis validation service as an API, worker, database,
queue, or migration target. Do not point the preview at production
PostgreSQL/Redis, and do not alter the production Custom GPT Action.

## Known residual risks

The five reported hardening gaps now have code-level remediations: fail-closed
container sandboxing, a dedicated executor audience, database-authoritative
idempotency, transactional per-job recovery events, and Linux
symlink/link-swap coverage. They are not operationally proven in Railway until
the isolated preview migration, deployment, Linux CI run, and E2E evidence are
complete.

One material filesystem residual remains: `patch.apply` validates target and
workspace identities before and after invoking `git apply`, but Git performs
path-based mutation. A malicious local process with concurrent write access
could swap a target component between validation and mutation. The post-check
can detect identity/reparse changes but cannot make the Git update
descriptor-atomic. Keep registered workspaces private to the daemon account,
test mutation only in a disposable fixture repository, and treat an
interrupted or suspicious mutation as `LOCAL_EFFECT_OUTCOME_UNKNOWN` requiring
manual reconciliation. A future descriptor-relative/transactional patch
writer would require separate review to preserve Git patch semantics.

Windows does not expose the same descriptor-relative directory walk used on
POSIX. Windows reparse points are checked before and after file open, so
registered workspaces must not be shared with a hostile local writer.

These risks and recommended follow-up controls are detailed in the security
review.
