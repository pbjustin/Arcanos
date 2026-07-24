# ARCANOS Local-Agent and Productivity Preview E2E Report

- Report date: 2026-07-24
- Status: Preview validation completed; temporary resources retained for review
- Branch: `codex/local-agent-preview-hardening`
- Pull request: <https://github.com/pbjustin/Arcanos/pull/1408>

## Executive result

The residual-risk hardening and isolated Railway preview validation completed
without modifying production or the Phase 2E validation environment.

The exact application commit deployed and tested was:

```text
a1357af42b76825408bf18f0fcacfb74994c085b
```

The public preview is:

```text
https://arcanos-api-bf8ac3bd-arcanos-preview-bf8ac3bd.up.railway.app
```

The dynamic Custom GPT Action document is:

```text
https://arcanos-api-bf8ac3bd-arcanos-preview-bf8ac3bd.up.railway.app/gpt-access/openapi.json
```

`ARCANOS:PRODUCTIVITY` and `ARCANOS:LOCAL_AGENT` both appeared in capability
discovery. The approved `patch.apply` test changed only the disposable
fixture's `preview-target.txt` from `before` to `after`.

This report was added after the deployed application commit. It does not alter
the deployed application artifact.

## Architecture assessment

The implementation preserves the existing ARCANOS authority boundaries:

```text
Temporary Custom GPT / E2E client
  -> /gpt-access/*
  -> TypeScript authentication, tenancy, policy, confirmation, audit, tracing
  -> existing job_data queue and lifecycle
  -> private outbound-polling Python daemon
  -> existing typed Python handlers
  -> structured result submission
  -> /gpt-access/jobs/result
```

Verified properties:

- TypeScript remains authoritative for public contracts, identity, policy,
  confirmation, tenancy, persistence, idempotency, and job creation.
- Python exposes no public HTTP API and has no PostgreSQL connection.
- The daemon initiates outbound heartbeat, claim, and result requests.
- No second queue, workflow engine, or authentication system was introduced.
- No generic shell capability was added.
- The modules remain protected by GPT Access and are not exposed through
  legacy routes or `/gpt/:gptId`.
- `ARCANOS:PRODUCTIVITY` and `ARCANOS:LOCAL_AGENT` remain separate modules.
- Repository, Git, patch, test, and command functionality is not placed inside
  the productivity module.
- TypeScript capability contracts generate the equivalent Python catalog used
  for protocol-parity validation.

## Baseline

| Item | Recorded value |
|---|---|
| Git branch | `codex/local-agent-preview-hardening` |
| Deployed commit | `a1357af42b76825408bf18f0fcacfb74994c085b` |
| Node.js | `v24.13.0` locally; CI build target `20.19.0` |
| npm | `11.6.2` |
| Python | `3.11.7` locally; CI used Python 3.11 |
| Railway CLI | `4.30.2` |
| Local OS | Windows NT `10.0.26200.0`, x64 |
| Local Docker | Unavailable |
| Linux Docker validation | Available in GitHub Actions |

The unrelated local user changes were preserved in:

```text
stash@{0}: codex-preserve-unrelated-before-local-agent-preview
```

They were not included in the branch or preview deployment.

## Railway isolation

### Selected target

| Resource | Name | ID | Deployment |
|---|---|---|---|
| Workspace | `pbjustin's Projects` | — | — |
| Project | `Arcanos` | `7faf44e5-519c-4e73-8d7a-da9f389e6187` | — |
| Environment | `arcanos-preview-bf8ac3bd` | `99d9eeae-c618-4a77-8498-85dd0d7444cc` | — |
| API | `arcanos-api-preview-bf8ac3bd` | `7a34bd3b-5087-4c9e-b732-a5a00a9dae8e` | `4c58255a-af70-438e-a3c5-9ce4a2d1f305` |
| Worker | `arcanos-worker-preview-bf8ac3bd` | `ad02d44b-d488-4e8d-b003-92223d02d1b8` | `c4969a34-3321-49a8-8093-dc1c8e2ed1dd` |
| PostgreSQL | `postgres-preview-bf8ac3bd` | `c044dc1c-fcf5-4457-ac74-163e2a55132e` | `c1103750-d6ab-4242-8026-80076d4bd98b` |
| Redis | `redis-preview-bf8ac3bd` | `83109a22-246b-4853-9346-d7179238e0bf` | `5b3e456f-944d-4265-96c6-c768b760e281` |

All four deployments reported `SUCCESS`. The API deployment metadata and
health response identified commit `a1357af42b76825408bf18f0fcacfb74994c085b`.
The API's server-controlled worker metadata identified the same commit and
worker deployment `c4969a34-3321-49a8-8093-dc1c8e2ed1dd`.

### Stateful resources

| Service | Volume | Mount |
|---|---|---|
| PostgreSQL | `postgres-volume-ErHh` (`06edbc2c-f306-4f72-ade4-6da78c431bbf`) | `/var/lib/postgresql/data` |
| Redis | `redis-volume-88of` (`56b8b6db-1b97-4501-9a93-5b61e028e45e`) | `/data` |

The API domain is attached only to the preview API service. PostgreSQL and
Redis have no public HTTP domains.

### Forbidden target proof

The original linked Phase 2E target was not used:

| Item | Value |
|---|---|
| Environment | `phase2e-validation-20260717` (`fb99f47d-5ef5-44c1-96c2-acf7b90fab13`) |
| Redis service | `phase2e-redis-r2-20260718` (`1ac0bd56-50b3-49eb-954c-ea83515ec915`) |
| Latest deployment | `9f102e53-ef25-46b5-80e8-0243eb1512d6` |
| Deployment creation time | `2026-07-20T19:12:13.179Z` |

That deployment predates this preview task and remained unchanged.

### Variable isolation

The API and worker use Railway service references to the preview-owned
PostgreSQL and Redis instances. The preview variable audit found no references
to production or Phase 2E database, Redis, internal URL, webhook, or credential
values.

Preview-only credential variables include:

- `ACTION_PLAN_OPERATOR_TOKEN`
- `ARCANOS_GPT_ACCESS_TOKEN`
- `ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN`

Their values are not included in this report or command output.

## Migrations

Migrations were applied only through the preview PostgreSQL service.

### Local-agent hardening

The reviewed migration is:

```text
migrations/20260724_local_agent_job_hardening_v1/01_local_agent_job_idempotency.sql
```

The exact repeatable apply/verification command was:

```powershell
railway run `
  --project 7faf44e5-519c-4e73-8d7a-da9f389e6187 `
  --environment 99d9eeae-c618-4a77-8498-85dd0d7444cc `
  --service c044dc1c-fcf5-4457-ac74-163e2a55132e `
  --no-local `
  node scripts/local-agent-hardening-migration.mjs `
  --apply-preview `
  --confirm-preview `
  --expected-project-id 7faf44e5-519c-4e73-8d7a-da9f389e6187 `
  --expected-environment-id 99d9eeae-c618-4a77-8498-85dd0d7444cc `
  --expected-postgres-service-id c044dc1c-fcf5-4457-ac74-163e2a55132e
```

Result:

- Migration checksum verified:
  `75cf9f3a914fafbd8d1ad453a2f47c5f930e8f2bdf45ac6e61f672c74f775bed`.
- `local_agent_job_idempotency` exists.
- 30 current bindings and zero missing bindings.
- Scope uniqueness is database-enforced.
- `job_id` is unique and references `job_data` with deferred
  `ON DELETE CASCADE`.
- The expiry index exists.
- The preview database had zero duplicate logical binding groups.

The two-connection PostgreSQL concurrency test proved that two concurrent
inserts for the same principal/workspace/device/action/key scope cannot both
commit.

### Productivity

The additive migration is:

```text
migrations/20260724_productivity_core.sql
```

It was executed transactionally with five-second lock timeout and sixty-second
statement timeout through the explicitly selected preview PostgreSQL service.
A repeatable application completed successfully.

Result:

- Six productivity tables exist:
  `productivity_projects`, `productivity_tasks`, `productivity_notes`,
  `productivity_reviews`, `productivity_events`, and
  `productivity_command_receipts`.
- Seventeen productivity indexes and constraint-backed indexes exist.
- Including local-agent hardening, seven new domain tables and 21 indexes are
  present.

Railway CLI did not expose a usable database snapshot operation. No snapshot
was claimed. The environment is synthetic and disposable; environment deletion
is the preview rollback boundary.

## Residual-risk remediation

### 1. `tests.run` sandbox

Implemented execution modes:

- `disabled`
- `sandboxed`
- `unsandboxed-development-only`

The default remains fail-closed. Production-capable configuration requires
`sandboxed`; unsandboxed execution requires an explicit development-only
override.

The Linux effective-sandbox job built an immutable Docker image and ran as a
non-root user with:

- read-only container filesystem
- bounded writable workspace and temporary storage
- no host socket or privileged mode
- sanitized environment
- disabled/restricted network policy
- CPU, memory, process, disk, timeout, and output limits
- cleanup after timeout, cancellation, and failure

The focused Linux sandbox and link-race suite passed 20 tests.

The preview daemon remained in `disabled` test mode because Docker/Podman was
not available on the Windows host. No unsandboxed repository code was run.

### 2. Dedicated local-agent executor identity

The daemon uses a purpose-bound credential with:

- role `local-agent-executor`
- audience `local-agent-protocol`
- registered device identity
- explicit executor instance identity
- only heartbeat, claim, result, and recovery protocol scopes
- preview-only token material
- rotation and revocation through server-controlled configuration

Live cross-audience checks returned HTTP `401` for:

- local-agent credential against ActionPlan operator endpoints
- local-agent credential against GPT Access user capabilities
- GPT Access credential against local-agent executor protocol
- ActionPlan operator credential against local-agent executor protocol

### 3. Database-enforced idempotency

`local_agent_job_idempotency` has authoritative unique constraints for:

```text
(principal_id, workspace_id, device_id, action, idempotency_key_hash)
job_id
```

Identical replays returned the original job. Changed canonical payloads using
the same key returned `LOCAL_AGENT_IDEMPOTENCY_CONFLICT`. Advisory locks remain
an optimization, not the correctness boundary.

### 4. Per-job expiry events

Each expired job is transitioned and receives its own lifecycle event with
reason, reconciliation time, trace when available, and audit metadata.

The focused repository suite passed:

- expired-result retention
- post-expiry result rejection
- mutation reconciliation after execution began
- per-job expiry event emission
- partial event-write failure isolation while the bounded batch continued

### 5. Symlink security

Linux CI exercised symlink files, directories, chained links, external targets,
secret targets, and validation/open races as part of the 20-test sandbox
suite.

The Windows-host symlink case was attempted but skipped because the host lacked
the required symbolic-link privilege. No result was invented for Windows.

## Additional security review

| Finding | Result |
|---|---|
| Path traversal | Final preview request rejected with `VALIDATION_FAILED` before job creation |
| Secret-file access | Synthetic `.env` access failed with `LOCAL_AGENT_ACCESS_DENIED`; fixture removed afterward |
| Daemon impersonation | Purpose-bound audience, principal, instance, device, and scope checks |
| Stale device | Daemon was stopped; after 108 seconds the gateway returned `LOCAL_AGENT_DEVICE_OFFLINE` and created no job |
| Device recovery | Daemon restarted; heartbeat age returned to two seconds and status execution succeeded |
| Claim races | Atomic-claim repository test passed |
| Duplicate results | Exact replay accepted; changed result rejected in focused tests |
| Result tampering | Job/request/trace/device correlation enforced and tested |
| ANSI/control output | Sanitization and bounded-output tests passed |
| Oversized output/diffs | Output and diff limits enforced and tested |
| Patch path escape | Patch parsing and registered-root enforcement tested |
| Git hooks/submodules | Fixed handler paths and sanitized execution environment; no generic shell |
| Confirmation replay/mutation | One-time, actor/action/payload-bound challenge tests passed in CI |
| Cross-tenant access | Trusted principal/workspace context; caller-supplied tenancy rejected |
| OpenAPI exposure | Only registered contracts; no secret values or `/gpt/:gptId` path |
| Log leakage | 500 API and 80 worker lines scanned: zero credential-pattern hits |
| Preview dependencies | Explicit preview PostgreSQL and Redis service references only |

Deferred findings:

1. **Low — confirmation rejection observability.** The first approved retry
   safely returned a new challenge without an execution job. A second explicit
   approval succeeded. The external error does not distinguish expiry from
   another exact-binding rejection. Add a non-secret internal rejection reason
   metric while keeping the public response generic.
2. **Low — disabled `tests.run` result presentation.** A previously started
   may-modify-files job that fails before test execution can conservatively
   surface an unknown-effect lifecycle classification. This is safe but less
   precise for users.
3. **Operational — sandbox runtime availability.** A machine that should run
   `tests.run` must maintain a pinned, working Docker or Podman runtime. The
   action remains disabled otherwise.
4. **Operational — executor credential theft.** A stolen unexpired
   purpose-bound credential cannot become a GPT or ActionPlan credential, but
   it could impersonate that registered preview device until revoked. Use short
   rotation windows and revoke stale devices.
5. **Dependency debt.** CI installation output reported three moderate and
   five high npm advisories while the configured security gate still passed.
   These were not changed as part of the surgical bridge hardening and need a
   separate dependency-impact review.

## Capability and OpenAPI verification

Discovery verified:

- `/gpt-access/health`
- `/gpt-access/status`
- `/gpt-access/capabilities/v1`
- `/gpt-access/openapi.json`
- both capability-detail endpoints
- unauthorized access
- scope denial
- invalid capability behavior

The catalog exposed:

- 24 `ARCANOS:PRODUCTIVITY` actions
- 7 `ARCANOS:LOCAL_AGENT` actions

The local-agent actions are:

```text
local_agent.status
repo.search
git.status
git.diff
tests.run
patch.preview
patch.apply
```

No generic command or shell action exists.

## E2E results

### Productivity

The isolated preview exercised:

- `intent.catalog`
- `intent.resolve`
- `state.current`
- `context.summary`
- `reference.resolve`
- `inbox.list`
- `task.list`
- `project.list`
- `project.health`
- `focus.today`
- `knowledge.find`
- `review.daily`
- `review.weekly`
- `capture.add`
- `inbox.process`
- `task.create`
- `task.complete`
- `task.defer`
- `task.transition`
- `project.create`
- `project.advance`
- `project.transition`
- `knowledge.store`
- `review.record`

Verified behaviors:

- trusted principal and workspace resolution
- caller-supplied owner/workspace rejection
- canonical task and project transitions
- invalid-transition rejection
- ambiguous reference candidates without mutation
- stale-version rejection
- identical idempotent replay
- changed-payload idempotency conflict
- atomic state, event/outbox, and receipt persistence
- explicit `persisted` and `effect` responses

The final exact-commit verifier reran all read-only productivity actions.
Earlier mutation scenarios used the same isolated stack; subsequent commits
changed only preview verifier behavior and Windows patch-stream handling.

### Local agent

The final exact-commit preview passed:

- online and offline `local_agent.status`
- `repo.search`
- `git.status`
- `git.diff`
- mutation-free `patch.preview`
- path-traversal rejection
- secret-file denial
- job-result polling
- six-event audit timelines
- idempotent job replay
- changed-payload conflict
- daemon stop/restart recovery

`tests.run` remained disabled on the preview daemon. Its sandboxed behavior was
validated in Linux CI; no unsandboxed execution occurred.

### Confirmed `patch.apply`

Disposable fixture:

```text
C:\Users\pbjus\AppData\Local\Temp\arcanos-local-agent-preview-bf8ac3bd-fixture
```

Patch SHA-256:

```text
7cbbd48b1a598a40f9579572ab30078ecd136e863ce5e316efa908dee0153ea1
```

Flow:

1. Initial request returned HTTP `403` and `CONFIRMATION_REQUIRED`.
2. No job was created and the fixture remained clean.
3. The first explicitly approved exact retry returned another challenge and
   created no job. Execution stopped.
4. The operator explicitly approved the new challenge.
5. One exact retry with unchanged capability, action, payload, idempotency key,
   request ID, and trace ID was accepted.
6. Job `c630843d-0e14-4b81-b6ef-4dac527bdda5` completed successfully.
7. Only `preview-target.txt` changed from `before` to `after`.

Canonical job evidence:

| Field | Value |
|---|---|
| Action | `patch.apply` |
| Principal | `preview:operator` |
| Workspace | `preview-fixture` |
| Device | `5e704113-392d-4cbe-8a0b-26ebd5406b22` |
| Request ID | `preview-patch-apply-a1357-1784928311588` |
| Trace ID | `preview-patch-apply-a1357-1784928311588-trace` |
| Authorization decision | `confirmed` |
| Authorization evidence | Present, 64-character digest |
| Idempotency bindings | Exactly one |

Lifecycle events:

```text
job.queued
job.created
job.claimed
job.started
worker.heartbeat
job.completed
```

All six events share the request, trace, principal, workspace, device, and
action correlation. The public event projection redacts the authorization
decision while retaining evidence presence; the canonical job envelope records
`confirmed`.

## Tests actually executed

| Command or CI job | Result |
|---|---|
| `node --test scripts/preview-e2e.test.mjs` | 18 passed |
| Focused local-agent repository Jest suite | 10 passed |
| Preview PostgreSQL two-connection concurrency suite | 2 passed |
| Full local Python suite during hardening | 519 passed, 13 skipped |
| Final Windows Python CI | 522 passed, 9 skipped |
| Final Node unit CI | 4,907 passed, 10 skipped |
| Final Node integration CI | 84 passed, 5 skipped |
| Linux effective sandbox/link-race CI | 20 passed |
| `npm run validate:gpt:job-hardening` | Dry run passed; no network |
| Boundary, CEF, and routing checks | Passed |
| `npm run docs:check` | 271 passed, 0 failed, 0 warnings |
| Railway compatibility and deployment readiness | Passed |
| Exact-commit discovery verifier | Passed |
| Exact-commit read-only verifier | Passed |
| Preview log credential/fatal-pattern scan | Zero hits |
| `gh pr checks 1408` | All checks complete and passing |

The exact preview database concurrency command was:

```powershell
railway run `
  --project 7faf44e5-519c-4e73-8d7a-da9f389e6187 `
  --environment 99d9eeae-c618-4a77-8498-85dd0d7444cc `
  --service c044dc1c-fcf5-4457-ac74-163e2a55132e `
  --no-local `
  pwsh -NoProfile -Command `
  '$env:LOCAL_AGENT_HARDENING_TEST_DATABASE_URL=$env:DATABASE_PUBLIC_URL; node scripts/run-jest.mjs --testPathPatterns=tests/integration/local-agent-hardening.pg.integration.test.ts --coverage=false --runInBand'
```

## Passed, failed, skipped, blocked, and manual

### Passed

- All final pull-request checks.
- Exact commit deployment for API and worker.
- Preview migrations and schema verification.
- Capability discovery and OpenAPI.
- Productivity E2E scenarios.
- Local-agent read-only and failure-boundary scenarios.
- Database-backed idempotency race.
- Linux sandbox and symlink/link-race coverage.
- Confirmed fixture-only patch application.
- Audit, trace, identity, and job correlation.

### Failed

- No final CI, migration, deployment, discovery, read-only, or approved patch
  execution test failed.
- The first confirmed retry produced a second challenge. This was a safe,
  non-executing confirmation-flow rejection, not a job failure. The fresh
  challenge was separately approved and completed.

### Skipped

- Windows symlink creation: host privilege unavailable.
- Live sandboxed `tests.run` on the Windows preview daemon: Docker/Podman
  unavailable.
- Live production smoke, production migration, and production deployment:
  deliberately prohibited.
- Production Custom GPT modification: deliberately prohibited.
- Live consumed-token replay after successful mutation: not performed because
  approval covered one exact retry; one-time replay is covered by CI tests.

### Not executed

- Production data import.
- Production or Phase 2E variable changes.
- Production credential rotation.
- Preview teardown.

### Blocked

- Railway database snapshot: no supported CLI operation was available.
- Windows privileged symlink coverage: requires Developer Mode or elevated
  symbolic-link privilege.

### Manually verified

- Fixture contents and Git diff after `patch.apply`.
- Preview URL and API health.
- API/worker/PostgreSQL/Redis deployment identity.
- Forbidden Phase 2E deployment remained unchanged.

## Logs and secret handling

The review scanned 500 API log lines and 80 worker log lines for:

- bearer credentials
- OpenAI-style secret keys
- PostgreSQL and Redis credential URLs
- password, token, secret, or credential assignments
- fatal startup and connection failures

- Detected secret-pattern hits: `0`
- Detected fatal-pattern hits: `0`

No token, password, database URL, or raw confirmation challenge is included in
this report.

## Temporary Custom GPT instructions

Do not modify the production Custom GPT.

1. Create a temporary test GPT.
2. Add a Custom GPT Action using:

   ```text
   https://arcanos-api-bf8ac3bd-arcanos-preview-bf8ac3bd.up.railway.app/gpt-access/openapi.json
   ```

3. Configure API-key authentication as a bearer token using the preview-only
   `ARCANOS_GPT_ACCESS_TOKEN`. Do not paste the token into chat, source, or this
   report.
4. Use only the disposable preview workspace and fixture repository.
5. Suggested conversation checklist:

   - “What’s going on?”
   - “Remember that I need to review the launch plan.”
   - “What should I focus on?”
   - “Search the repository for the local-agent job claim logic.”
   - “Show me the Git status.”
   - “Preview a harmless patch to the fixture repository.”
   - “Apply that patch.”

6. Require the real confirmation UI before the last action.

The existing fixture patch has already been applied. Reset that disposable
fixture or create a new disposable fixture before repeating the final two
phrases.

## Rollback

The implementation branch is unmerged, so production rollback is not needed.

For preview application rollback, prefer deleting the isolated preview
environment. It removes the API, worker, stateful services, variables, volumes,
domain, preview agent registration, and synthetic data as one boundary.

Do not run the hardening compensation migration against the current preview:
the table contains idempotency bindings and its compensation script correctly
requires an empty table.

To undo only the disposable fixture mutation before deletion:

```powershell
git -C C:\Users\pbjus\AppData\Local\Temp\arcanos-local-agent-preview-bf8ac3bd-fixture restore -- preview-target.txt
```

## Teardown plan

Teardown has not been executed.

### 1. Stop the preview daemon

The daemon process at report time is PID `24732`:

```powershell
Stop-Process -Id 24732
```

Confirm the process identity before stopping it if teardown occurs later,
because PIDs can be reused.

### 2. Verify the exact Railway target

```powershell
railway environment link 99d9eeae-c618-4a77-8498-85dd0d7444cc
railway service link 7a34bd3b-5087-4c9e-b732-a5a00a9dae8e
railway status --json
```

Proceed only if the active environment is exactly
`arcanos-preview-bf8ac3bd` with ID
`99d9eeae-c618-4a77-8498-85dd0d7444cc`.

### 3. Revoke preview credentials if environment deletion is delayed

```powershell
railway variable delete ACTION_PLAN_OPERATOR_TOKEN `
  --service 7a34bd3b-5087-4c9e-b732-a5a00a9dae8e `
  --environment 99d9eeae-c618-4a77-8498-85dd0d7444cc

railway variable delete ARCANOS_GPT_ACCESS_TOKEN `
  --service 7a34bd3b-5087-4c9e-b732-a5a00a9dae8e `
  --environment 99d9eeae-c618-4a77-8498-85dd0d7444cc

railway variable delete ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN `
  --service 7a34bd3b-5087-4c9e-b732-a5a00a9dae8e `
  --environment 99d9eeae-c618-4a77-8498-85dd0d7444cc
```

Deleting the environment makes this separate credential step unnecessary.

### 4. Delete the preview environment

```powershell
railway environment delete 99d9eeae-c618-4a77-8498-85dd0d7444cc --yes
```

This is the preferred teardown because the API, worker, PostgreSQL, Redis,
volumes, preview variables, device row, domain, and synthetic records all
belong only to this environment.

If account two-factor authentication requires it, let Railway prompt
interactively rather than recording a 2FA code.

### 5. Remove local disposable artifacts

After resolving and checking each path exactly:

```powershell
$targets = @(
  'C:\Users\pbjus\AppData\Local\Temp\arcanos-local-agent-preview-bf8ac3bd-fixture',
  'C:\Users\pbjus\AppData\Local\Temp\arcanos-local-agent-preview-bf8ac3bd-state',
  'C:\Users\pbjus\AppData\Local\Temp\arcanos-local-agent-preview-bf8ac3bd-fixture.patch'
)

$expectedPrefix = 'C:\Users\pbjus\AppData\Local\Temp\arcanos-local-agent-preview-bf8ac3bd'
foreach ($target in $targets) {
  $absolute = [System.IO.Path]::GetFullPath($target)
  if (-not $absolute.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing unexpected teardown path: $absolute"
  }
  if (Test-Path -LiteralPath $absolute) {
    Remove-Item -LiteralPath $absolute -Recurse -Force
  }
}
```

### 6. Remove temporary GPT configuration

Delete the temporary GPT Action or the temporary GPT itself through the
ChatGPT UI. Do not alter the production Custom GPT.

### 7. Branch and pull request

Do not merge automatically. After review, the operator may close PR `#1408`
or merge it through the normal protected process. The unrelated stash should
be restored only after the branch work is complete and conflicts have been
reviewed.

## Resources and cost exposure

Temporary Railway resources currently retained:

- one API service
- one worker service
- one PostgreSQL service and volume
- one Redis service and volume
- one Railway-provided API domain
- one manual preview environment

These resources continue to incur normal Railway usage until teardown. No
dollar estimate is claimed.

## Required manual steps

1. Review PR `#1408`.
2. Optionally perform the temporary Custom GPT UI checklist.
3. Decide when to execute the teardown plan.
4. Separately triage the npm dependency advisories.
5. Restore the preserved unrelated stash after the branch work is complete.
