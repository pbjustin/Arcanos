# Self-healing acceptance matrix

## Owner dashboard deletion verification — 2026-10-12, 19:22–19:25 UTC

After the owner reported cleanup complete, fresh CLI and connected-tool
inventories still listed both remaining probes. The service/volume project's
`deletedAt` changed to `2026-10-14T19:20:20.070Z`; the first empty project's
date remains `2026-10-14T17:38:48.891Z`. These are scheduled deletion dates,
not evidence of completed permanent removal.

Both CLI project records now expose an empty service list. Describing the
service/volume environment returns `Project not found.` Its normal project
API is inaccessible; current live service/volume state and retained-storage
billing cannot be inferred. Earlier statements that the empty services and
volume remained live describe the pre-dashboard snapshot, not this one.

Railway [documents force deletion during the 48-hour grace period](https://railway.com/changelog/2025-03-21-project-deletion-changes).
The owner was asked to force-delete only projects
`db505b48-74f0-4571-9cd3-52bc865ff2cd` and
`21a05b97-59f7-435f-8a3a-234eb722cb6c`.
That action and fresh absence verification remain pending. The independently
removed empty probe `7bd0536d-95c1-4db9-a766-6a0f49547617` remains absent.

Production's four service/deployment identities and SUCCESS states still match
the read-only baseline. PR head inspected here is
`fbda67cf64cbe924767ba26e8a07531d03238df8`, open/non-draft/unmerged,
with only these five audit documents differing from approved executable
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
No application deployed, live fault ran, or new executable defect was inferred.
All fourteen live scenarios remain **BLOCKED / execution NOT_RUN**;
LIVE_ACCEPTANCE_VERIFIED and MERGE_READY remain **BLOCKED**.
The original **19:38:25.364Z** absolute expiry remains in force.

At inspected documentation head `fbda67cf64cbe924767ba26e8a07531d03238df8`,
[PR CI38295724570](https://github.com/pbjustin/Arcanos/actions/runs/38295724570)
and [CI/CD38295724506](https://github.com/pbjustin/Arcanos/actions/runs/38295724506)
both completed SUCCESS. Each records899 passing/13 skipped suites and17,640
passing/167 skipped tests; duplicate runs are not added together. Railway PR
and sealed E2E jobs were skipped. These counts do not establish live acceptance.
This documentation update passes `npm run docs:check` (980 checks/current
indexes), `node scripts/check-documentation-links.mjs --local-only` (716 local
targets,109 external URLs skipped) and `git diff --check`.

## Always-ask cleanup retry — 2026-10-12, 19:01 UTC

The owner changed Railway's plugin-specific permission to **Always ask** and
requested another cleanup attempt. A fresh settings read confirmed that mode;
the global default remains Allow low-risk actions. The prior read at18:34 UTC
had shown Railway's Allow all actions override. Missing/restrictive plugin
permissions are therefore not the established cause of cancellation, and the
earlier attribution to automatic approval review was unverified.

Fresh ownership inventory matched the same two empty services and empty1000MB
volume in the assignment-created service/volume probe. The exact environment-
scoped service deletion again returned `Cancelled — the user did not approve
this action. No changes were made.` A separately authorized volume deletion
returned the same result. Neither executed. Fresh inventory at19:01 UTC still
contained both remaining probe projects, both empty service definitions and
the live1000MB volume. The removed second empty probe remained absent.

Cleanup, LIVE_ACCEPTANCE_VERIFIED and MERGE_READY remain **BLOCKED**;
all fourteen genuine self-healing scenarios remain **BLOCKED / NOT_RUN**.
No new resource, application deployment, fault, fixture or executable correction
occurred. No alternate deletion interface or daemon was used to bypass the
cancellations. No plugin setting was changed by the agent. Owner dashboard
cleanup remains required; the absolute **19:38:25.364Z** expiry was not reset.
The concrete IDs and cost estimates below still apply. Both full CI workflows
at documentation head `ccf3f311460a30c844a65186f542f752038d10f4` are now
completed SUCCESS (CI/CD38290720098, PR CI38290720097); terminal metadata was
verified, without newly parsing test totals. Earlier attempt descriptions below
remain historical.

## Authenticated staging attempt — cleanup gate BLOCKED

Inspected documentation head: `a8bb1c35eeea3d59be6fd86c0ce908e4e147767a`.
Approved executable: `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
No application deployment or fault injection occurred. Successful CLI login
and empty-project removal are infrastructure preflight evidence, not
self-healing acceptance. The connected app rejected deletion of a fresh empty
service twice, including after exact-resource owner authorization, so the
service/volume cleanup gate and independent dashboard fallback remain blocked.

| # | Scenario | Genuine Railway staging result | Execution/evidence |
| --- | --- | --- | --- |
| 1 | Healthy baseline | BLOCKED | NOT_RUN; no web/worker artifact. |
| 2 | Transient provider timeout | BLOCKED | NOT_RUN; only local synthetic operator transport. |
| 3 | Sustained provider failure | BLOCKED | NOT_RUN; no live authorized fallback/escalation. |
| 4 | Trinity failure | BLOCKED | NOT_RUN; no actual deployed consumer. |
| 5 | Redis interruption | BLOCKED | NOT_RUN; no Redis instance. |
| 6 | Worker job failure | BLOCKED | NOT_RUN; no worker or PostgreSQL execution. |
| 7 | Failure threshold | BLOCKED | NOT_RUN; local fixture/source evidence is separate. |
| 8 | Mitigation expiration | BLOCKED | NOT_RUN; real ten-minute TTL not exercised. |
| 9 | Recovery verification | BLOCKED | NOT_RUN; no fresh consumer-correlated recovery. |
| 10 | Actuator failure | BLOCKED | NOT_RUN; no approved natural throwing-actuator injection path. |
| 11 | Concurrent incidents | BLOCKED | NOT_RUN; no deployed controllers/actions. |
| 12 | Service-role restrictions | BLOCKED | NOT_RUN; configured roles are not runtime proof. |
| 13 | Unauthorized action | BLOCKED | NOT_RUN; management-tool approval denial is not application authorization proof. |
| 14 | Restart during incident | BLOCKED | NOT_RUN; no live incident/process. |

The operator SDK suite passed 163 local assertions plus 500 separately counted
quota requests. It did not start ARCANOS or Bun and is not an application/live
scenario result. Thirty cleanup fake tests passed; actual watchdog confirmation
failed on the second probe, and the corrected third rehearsal was stopped
before expiry after the deletion approval rejection. Do not promote its local
fix to a live expiry PASS.

The request plan preserves actual thresholds, ten-minute mitigation TTL,
cooldowns and request limits. Worker evidence needs the jobRunner child's PID,
provider receipts and exact-job SQL events from a fresh isolated database.
Controller/health traffic alone must not establish Trinity recovery.
Process-local state and FORCE_MOCK/worker-watchdog boundaries remain
uncertified. No production testing substitutes were used.

Current [resource and cleanup evidence](self-healing-preview-evidence.md) and
[seventeen-gate verdict](self-healing-merge-readiness.md) supersede the earlier
attempt summaries below. The historical fourteen local scenarios remain
separately scoped; no new application defect or repair is claimed.

## Revised time-limited staging attempt — 2026-10-12

The owner withdrew the independently enforced $10 ceiling and authorized the
existing workspace, a $10 operational target and a two-hour maximum lifetime.
Approved executable remains `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`;
inspected PR head `450ab65d9955d7627f75fdb3a34fe1773faa23dc` differs only in five
audit documents. No source substitution or deployment occurred.

Mandatory precreation cleanup proof is BLOCKED: connected inventory is
authenticated, but no project-delete tool is exposed; CLI login expired before
completion; a disposable deletion, tested watchdog and independent owner
fallback were not executed. All fourteen genuine staging scenarios remain
BLOCKED / execution NOT_RUN. The fourteen-row table below applies unchanged.
No initial state, fault, incident, authorization/application transcript,
consumer change, recovery or rollback was observed in staging.

The historical hard-ceiling rationale below is superseded by this authorization.
It is not the current stop reason. Current inventory, authentication outcome
and remaining owner prerequisites are in [evidence](self-healing-preview-evidence.md).


## Dedicated staging results — 2026-10-12

Owner-approved source: `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
Provisioning stopped before mutation because an independent hard $10 spend
bound could not be established. No staging project, deployment, baseline,
provider, fault or runtime consumer was exercised. All scenarios are BLOCKED,
execution NOT_RUN; this is not fourteen observed runtime failures.

| # | Genuine staging scenario | Acceptance | Execution |
| --- | --- | --- | --- |
| 1 | Healthy baseline | BLOCKED | NOT_RUN |
| 2 | Transient timeout | BLOCKED | NOT_RUN |
| 3 | Repeated provider failure | BLOCKED | NOT_RUN |
| 4 | Trinity failure / actual consumption | BLOCKED | NOT_RUN |
| 5 | Redis interruption | BLOCKED | NOT_RUN |
| 6 | Worker job failure / no duplicate execution | BLOCKED | NOT_RUN |
| 7 | Failure threshold | BLOCKED | NOT_RUN |
| 8 | Mitigation expiration / safe clearing | BLOCKED | NOT_RUN |
| 9 | Fresh sufficient recovery verification | BLOCKED | NOT_RUN |
| 10 | Actuator failure / bounded retry | BLOCKED | NOT_RUN |
| 11 | Concurrent incidents | BLOCKED | NOT_RUN |
| 12 | Service-role restrictions | BLOCKED | NOT_RUN |
| 13 | Unauthorized operation | BLOCKED | NOT_RUN |
| 14 | Restart during incident | BLOCKED | NOT_RUN |

No staging correlation IDs, detection/actuation logs, controller/consumer
transcripts, recovery measurements or clearing observations exist. No paid
model, production dependency or unrelated deployment was used.
[Cost evidence](self-healing-preview-evidence.md) records the stop decision;
[readiness](self-healing-merge-readiness.md) reports all seventeen new gates.

Earlier local PASS results below were not rerun in this staging assignment.
They remain distinct local/CI evidence and cannot pass a genuine staging gate.

## Historical local and preview investigation


PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Initial inspected head:
`ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

The architecture map was completed before execution. All fourteen safely
executable scenarios were evaluated locally. No isolated Railway fixture or
genuine Railway runtime was exercised: the PR-owned exact-head preview is
absent, so live execution stopped before credentials, endpoints or faults were
used. Local PASS below applies only to the stated boundary. Every overall
scenario remains BLOCKED for the requested live acceptance.

The subsequent owner authorization permits preparation of an isolated profile;
it does not establish platform credentials or deploy a runtime. New local
profile identity/isolation contract checks use synthetic observations. They
are not re-executions of the fourteen runtime scenarios below. All fourteen
live results remain BLOCKED / execution NOT_RUN.

Recovery follow-up at `2fd4cf81833ba3be4592654bc7789dd3309374d7`:
all fourteen genuine live scenarios remain **BLOCKED**, and their runtime
execution is **NOT_RUN**. No new fault, incident, consumer execution or recovery
was performed. Missing opt-in was identified, but the current managed workflow
targets service IDs confirmed in production and admits only sealed/passive
services without PostgreSQL/Redis. The new mission forbids those target IDs.
Independent preview-only identities and a supported trusted normal-runtime
profile are required first. Local results below are preserved prior evidence,
not substituted live outcomes or newly executed scenarios.

| Scenario | Local result and execution mode | Evidence and practical limit | Isolated preview fixture | Genuine live preview / overall acceptance |
| --- | --- | --- | --- | --- |
| Healthy baseline | PASS — local real-consumer integration | `self-healing-trinity.integration.test.ts`: healthy coordinator selects no unnecessary action; actual SDK/Trinity takes its normal path against synthetic loopback replies. | NOT_RUN | BLOCKED |
| Transient provider timeout | PASS — local real-consumer integration | Held loopback intake response triggers the real SDK deadline; one direct-answer recovery succeeds; only one failure observation, no persistent threshold activation. Next request returns to the normal pipeline. Client cancellation is distinguished from timeout-fixture backstop cleanup. No real provider call. | NOT_RUN | BLOCKED |
| Repeated provider failures | PASS — local real-consumer integration | Five controlled 503 POSTs remain on the authorized model: intake plus four bounded recovery attempts. OPEN circuit rejects further POSTs; two successful synthetic probes close it. This proves bounded failure/admission behavior, not provider availability. | NOT_RUN | BLOCKED |
| Trinity failure | PASS — local real-consumer integration | Coordinator selects and applies same-process degraded mode; actual `runTrinity` consumer switches simple traffic to direct answer. Complex traffic remains outside this mitigation. The integration asserts provider request transcript and consumer decision, beyond selection logs. Cross-service delivery is absent. | NOT_RUN | BLOCKED |
| Redis interruption | PASS — local mocked lifecycle/operation integration | `redis-startup-lifecycle`, `redis-operation-boundary`, `safety-v2-redis-lifecycle`, `self-heal-telemetry-redis`: bounded reconnect/deadlines, unavailable admission and persistence fallback. No Redis process was interrupted locally or on Railway. | NOT_RUN | BLOCKED |
| Worker job failure | PASS — local mocked queue/runner integration | `worker-task-queue`, `worker-autonomy-service`, `worker-duplication-suppression`, `job-runner-runtime`, queue lifecycle/requeue suites: bounded retries, one local execution owner and fenced terminal/retry behavior. This does not prove real SQL contention or exactly-once external effects. | NOT_RUN | BLOCKED |
| Incident threshold | PASS — local unit and real-consumer integration | V2 records failures one/two without action and activates at three; transient real transport failure remains below that threshold. Canonical diagnosis tests separately enforce request/burst thresholds and configured incident attempt budgets. No durable unique incident registry exists. | NOT_RUN | BLOCKED |
| Mitigation TTL | PASS — local V2 and real-consumer integration, Trinity scope | Fake-clock boundary expires the ten-minute Trinity command and restores the normal consumer. Pending verification is invalidated for expired/replaced commands without attributing recovery. Prompt-route mitigation has no TTL and requires explicit clear/rollback/restart; this broader requirement remains a limitation. | NOT_RUN | BLOCKED |
| Recovery verification | PASS — local controller integration | Empty/stale request windows defer verification; measured post-action improvement is required for a live Trinity command. Expired/rolled-back/replaced commands cannot claim later recovery. V2 retains successful actions until TTL. There is no durable incident-close API to validate. | NOT_RUN | BLOCKED |
| Failed mitigation | PASS — local controller/actuator integration | Four pre-fix throwing-actuator regressions demonstrated unbounded retries. Dispatched exceptions now consume cooldown/budget once, including degraded cooldown override. Unchanged/worse Trinity samples trigger rollback and ineffective cooldown; denied actuation consumes no dispatched attempt. Escalation effects are mocked. | NOT_RUN | BLOCKED |
| Concurrent incidents | PASS — local unit/controller and real-consumer integration | One in-flight tick, one pending verification, duplicate suppression, predictive execution ownership, rollback-before-advisor ownership, and stage/action replacement fencing prevent competing same-process actions. No distributed coordinator lock or cross-service command bus is implemented. | NOT_RUN | BLOCKED |
| Service-role restriction | PASS — local startup/unit and real-consumer integration | Web role suppresses automatic scheduler, interval entry and V2 failure activation; explicitly authorized manual web command remains consumable. Worker repair stays disabled for web even with approval. Standalone durable job runner does not start canonical scheduler; prompt fast trip is a separate owner. | NOT_RUN | BLOCKED |
| Unauthorized action | PASS — local HTTP/policy/actuator integration | Approval, scoped admission, pre-parser authentication, rate-limit and helper credential suites reject unauthorized mutation. New exact Railway target regressions reject absent/conflicting/ambiguous scope before any mocked deployment; actual deployment calls never occur. | NOT_RUN | BLOCKED |
| Restart during incident | PASS — two genuine local Node processes | `self-healing-restart.test.js` first activates a command, then fresh PID has empty stage/command state and normal consumer. Literal synthetic env, empty temp cwd, reviewed module allowlist and denied fetch contain effects. This proves invalidation, not durable incident continuation or external-effect replay safety. | NOT_RUN | BLOCKED |

The original failures, corrections and aggregate results are in the
[regression report](self-healing-regression-report.md). Deployment identity,
isolation stop conditions and absence of live incident/consumer evidence are in
the [preview evidence](self-healing-preview-evidence.md). The
[merge-readiness report](self-healing-merge-readiness.md) keeps live gates
independent from local results.

No production database writes, Redis mutations, shared job execution, webhooks
or billable model calls were authorized or executed by these acceptance tests.
Existing CI disposable PostgreSQL/Redis results are supplementary CI evidence;
they are not substitutes for the missing isolated preview.
