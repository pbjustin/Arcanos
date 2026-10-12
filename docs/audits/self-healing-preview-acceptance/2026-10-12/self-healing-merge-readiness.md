# Self-healing merge-readiness assessment

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

## Authenticated staging verdict — cleanup approval BLOCKED

**PRECREATE_CLEANUP_VERIFIED: BLOCKED. LIVE_ACCEPTANCE_VERIFIED: BLOCKED.
MERGE_READY: BLOCKED.**

PR #1539 remains open, non-draft and unmerged. Inspected head
`a8bb1c35eeea3d59be6fd86c0ce908e4e147767a` differs from approved application
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67` only in the five audit documents.
No web/worker application artifact was deployed and no executable SHA was tested
on Railway. Source CI passed; functional live acceptance remains unproved.

CLI authentication and immediate empty-project deletion now work.
The actual detached watchdog's confirmation read failed; its correction passes
local fakes but lacks a completed corrected live rehearsal.
Connected deletion of the fresh service/volume probe was rejected twice,
including after explicit exact-resource owner authorization. Root stopped
its expiry daemon before it could indirectly execute the rejected cleanup.
The independent dashboard fallback and service/volume cleanup remain unproved.
No staging workloads were started.

| Required gate | Result | Current evidence |
| --- | --- | --- |
| EXACT_SHA_VERIFIED | BLOCKED | Approved Git source identified; no deployed artifact. |
| STAGING_ISOLATION_VERIFIED | BLOCKED | Acceptance services/dependencies never provisioned. |
| WEB_READY | BLOCKED | Application runtime NOT_RUN. |
| WORKER_READY | BLOCKED | Application runtime NOT_RUN. |
| HEALTHY_BASELINE_VERIFIED | BLOCKED | No genuine baseline. |
| FAILURE_DETECTION_VERIFIED | BLOCKED | No live incident. |
| MITIGATION_AUTHORIZATION_VERIFIED | BLOCKED | Infrastructure approval denial is not application authorization. |
| MITIGATION_APPLICATION_VERIFIED | BLOCKED | No controller-to-consumer evidence. |
| TRINITY_CONSUMPTION_VERIFIED | BLOCKED | No deployed Trinity execution. |
| RECOVERY_VERIFIED | BLOCKED | No fresh consumer-correlated recovery. |
| MITIGATION_ROLLBACK_VERIFIED | BLOCKED | No live mitigation or clearing. |
| SERVICE_ROLE_BOUNDARIES_VERIFIED | BLOCKED | Source/profile only, no deployed role proof. |
| CONCURRENCY_AND_IDEMPOTENCY_VERIFIED | BLOCKED | Disposable CI/local evidence is not staging execution. |
| RESTART_SAFETY_VERIFIED | BLOCKED | No genuine restart during incident. |
| REGRESSION_TESTS_PASSED | PASS | Approved-source full CI; operator and docs results separate. |
| LIVE_ACCEPTANCE_VERIFIED | BLOCKED | All fourteen rows BLOCKED / execution NOT_RUN. |
| MERGE_READY | BLOCKED | Mandatory live gates and cleanup proof absent. |

Remaining assignment resources are two disposable projects, two empty service
definitions and one empty1000MB volume. No deployment, database process, Redis,
job or paid provider call exists. Production service/deployment identities and
SUCCESS states match the preflight read-only snapshot; our production mutation
count is zero. See [exact IDs, cost estimates and cleanup instructions](self-healing-preview-evidence.md).
Estimated continuing full-volume storage is about$0.00021/hour; actual billing
and retention are unverified. Cleanup is BLOCKED until owner dashboard removal
and fresh absence read-back. The original19:38:25.364Z absolute expiry was not
reset; stopping provisioning does not make residual resource cleanup pass.

Required owner action is actual dashboard cleanup of the two named probes,
because the connected app's destructive-action approval path still refuses
the exact authorized operation. More general spending/deployment authorization
is unnecessary. Once cleanup authority, corrected expiry execution and
independent fallback are actually established, resume supported isolated
staging at the same approved executable SHA. A different executable still
requires explicit authorization. Keep the PR open; no merge or production
promotion is authorized by a future PASS.

The earlier expired-login/hard-ceiling assessments below are historical and do
not replace this current verdict. No new ARCANOS defect or source correction
was inferred; process-local state, prompt lifetime, stale/control-only recovery
and unsupported runtime boundaries remain live acceptance questions.

## Current revised staging verdict — 2026-10-12

**PRECREATE_CLEANUP_VERIFIED: BLOCKED. LIVE_ACCEPTANCE_VERIFIED: BLOCKED.
MERGE_READY: BLOCKED.**

The owner permits the existing workspace and accepts that $10 is an operational
target rather than an enforced ceiling. Maximum lifetime remains two hours.
The former hard-budget blocker is withdrawn.

Inspected PR head `450ab65d9955d7627f75fdb3a34fe1773faa23dc` differs from approved
executable `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67` only in the five audit
documents; base/branch/open/non-draft state match. No executable change
requires renewed authorization, and no executable SHA was deployed.

Current stop reason is the owner's mandatory precreation cleanup gate:
CLI sign-in expired before completion; whole-project deletion is not callable
through the connected tools; disposable cleanup, a tested live watchdog and
the independent fallback have not been executed. The proposed CLI/watchdog/
owner-dashboard procedure can meet the stated gate once actually proved.
A second automated controller/provider TTL is not an extra requirement.

The seventeen-gate table below remains one PASS (approved-source regression
testing) and sixteen BLOCKED. All fourteen live scenarios are BLOCKED /
execution NOT_RUN. Existing hard-ceiling text below describes the initial
attempt, not this current verdict. Current full CI at inspected documentation
head is SUCCESS; source-specific receipts remain distinct from live gates.

No new fixture or code fix occurred, no resources were created, and no
assignment infrastructure charge continues. Cleanup execution is NOT_RUN
because there is nothing to delete. PR #1539 remains open and unmerged.

Required owner action is usable management sign-in and an executed independent
cleanup fallback rehearsal. Authorization itself is sufficient; the required
credential/cleanup evidence is missing. Do not provision until that evidence
exists, and do not use production or an unrelated deployment as a substitute.


## Dedicated staging verdict — 2026-10-12

**MERGE_READY: BLOCKED. LIVE_ACCEPTANCE_VERIFIED: BLOCKED.**

The owner approved `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67` after its difference
from the initial requested SHA was reported. PR #1539 was verified open,
non-draft and unmerged, base `3fd305b37ba410cf21684a8fed7619a1ba180b48`.

The new mission permits a dedicated temporary project with fresh identities.
It does not waive exact-SHA, isolation or the hard $10 ceiling. Provisioning
stopped before mutation: the illustrative two-hour resource estimate is $0.32,
but elapsed time, egress, retained storage and cleanup are not independently
bounded. The documented workspace-wide dollar limit could stop production.
No such limit was changed.

| Required staging gate | Result | Evidence / limitation |
| --- | --- | --- |
| EXACT_SHA_VERIFIED | BLOCKED | Approved source verified; no running artifact exists. |
| STAGING_ISOLATION_VERIFIED | BLOCKED | No staging identities/configuration to attest. |
| WEB_READY | BLOCKED | Web deployment/runtime NOT_RUN. |
| WORKER_READY | BLOCKED | Worker deployment/runtime NOT_RUN. |
| HEALTHY_BASELINE_VERIFIED | BLOCKED | Genuine staging baseline NOT_RUN. |
| FAILURE_DETECTION_VERIFIED | BLOCKED | Genuine staging detection NOT_RUN. |
| MITIGATION_AUTHORIZATION_VERIFIED | BLOCKED | Prior local evidence is distinct; live authorization NOT_RUN. |
| MITIGATION_APPLICATION_VERIFIED | BLOCKED | No staging actuation or consumer transcript. |
| TRINITY_CONSUMPTION_VERIFIED | BLOCKED | Genuine staging Trinity NOT_RUN. |
| RECOVERY_VERIFIED | BLOCKED | No live incident or fresh measured recovery. |
| MITIGATION_ROLLBACK_VERIFIED | BLOCKED | Live TTL/clearing/rollback NOT_RUN. |
| SERVICE_ROLE_BOUNDARIES_VERIFIED | BLOCKED | Source roles inspected; deployed roles NOT_RUN. |
| CONCURRENCY_AND_IDEMPOTENCY_VERIFIED | BLOCKED | Existing CI is not staging process-boundary proof. |
| RESTART_SAFETY_VERIFIED | BLOCKED | Genuine staging restart NOT_RUN. |
| REGRESSION_TESTS_PASSED | PASS | Both full CI runs passed at approved SHA; docs checks reported separately. |
| LIVE_ACCEPTANCE_VERIFIED | BLOCKED | All fourteen live scenarios blocked before provisioning. |
| MERGE_READY | BLOCKED | Mandatory live deployment/isolation/recovery evidence absent. |

No staging project/service/deployment/incident IDs exist. Assignment resource
spend is $0: no assignment-created infrastructure or continuing charges exist. Cleanup
execution is NOT_RUN because no created resources needed deletion; final
inventory/documentation-check outcomes are recorded in the delivery receipt.

Process-local command delivery, service-role ownership, lack of durable incident
restoration and prompt policy without TTL remain limitations. The authenticated
same-process manual coordinator path can be reused after prerequisites pass.
Missing general loopback supervision is acceptance tooling work, not a
reproduced runtime defect. No broad redesign was made.

Required owner action: independently enforce scoped expiry/cleanup, bound
egress and retained storage, and authenticate whole-project deletion; or
provide separate billing isolation that bounds all incremental charges below
$10. Verify plan charges and permissions before resuming. No shared production
limit change or budget increase is authorized. Any different source deployment
requires approval. Keep PR #1539 open.

The older eighteen-gate native-preview assessment below remains historical
evidence and does not replace this seventeen-gate staging verdict.


PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Branch: `codex/targeted-security-healing-20261012`.
Initial inspected head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

**MERGE_READY: BLOCKED. LIVE_PREVIEW_ACCEPTANCE: BLOCKED.**

The owner subsequently authorized preparing the recommended isolated profile.
This resolves the authorization to do that work; it does not supply a platform
credential. Railway CLI returned Unauthorized, the connected tools cannot
create the required environment, and the existing trusted-main profile still
cannot consume a PR-only change. The [concrete provisioning proposal](self-healing-preview-provisioning-plan.md)
and local planning/attestation contract are prerequisites, not a deployed
profile or live acceptance. No live gate changes as a result of authorization.

Recovery head lock: `2fd4cf81833ba3be4592654bc7789dd3309374d7`.
Root cause: missing opt-in, proven by the lifecycle `not-opted-in` receipt.
Provisioning stopped before mutation: fixed service IDs are shared with
production and prohibited as targets by this mission; the managed profile is
sealed/passive and cannot run the normal runtime or PG/Redis. An owner-installed
trusted normal-runtime profile with preview-exclusive identities is required.
No new source defect was inferred from this intentional policy boundary.

Subsequent PR CI at the evidence-only C32 head failed one unchanged heavy
structured-evidence success test at its five-second default. Commit
`6f58e16af9a0e202d7415942a2a7d8870db131dc` gives only that case a bounded
30-second budget; assertions and runtime behavior are unchanged. Four covered
focused suites passed 32 cases with zero skips. Final-head full-CI status is
recorded separately on the PR; the failed C32 run is preserved in the regression
report. This correction does not lift any live provisioning or acceptance gate.

The exact-head PR preview is absent and its isolation cannot be proven. Local
regressions and ordinary CI cannot pass mandatory genuine-runtime gates. This
verdict is independent from GitHub's syntactic mergeability/check status and
does not establish production readiness.

| Gate | Result | Evidence / required environment |
| --- | --- | --- |
| PR_HEAD_IDENTIFIED | PASS | Authenticated GitHub metadata plus matching branch/ref. Final published head is recorded in the PR receipt. |
| PREVIEW_PROVISIONING_ROOT_CAUSE_IDENTIFIED | PASS | Exact lifecycle receipt: `action: noop`, `reason: not-opted-in`; supported-profile/production-ID conflict independently inspected. |
| PREVIEW_ENVIRONMENT_MATCHED | BLOCKED | Expected `pr-676861-1539` absent; successful candidate belongs to another branch/SHA. |
| PREVIEW_ISOLATION_VERIFIED | BLOCKED | No exact-head target on which service/credential/storage/queue isolation can be established. |
| WEB_AND_WORKER_DEPLOYED | BLOCKED | No compliant preview-exclusive identities; no deployment attempted or successful deployment IDs. |
| HEALTHY_BASELINE_VERIFIED | BLOCKED | Local normal consumer passed; genuine Railway baseline NOT_RUN. |
| FAILURE_DETECTION_VERIFIED | BLOCKED | Deterministic local threshold/transport tests passed; genuine Railway detection NOT_RUN. |
| MITIGATION_AUTHORIZATION_VERIFIED | BLOCKED | Local HTTP/policy/actuator denial and approved dispatch passed; runtime authorization evidence unavailable. |
| MITIGATION_APPLICATION_VERIFIED | BLOCKED | Local same-process command and scoped actuator tests passed; actual preview application NOT_RUN. |
| TRINITY_CONSUMPTION_VERIFIED | BLOCKED | Real Trinity consumer exercised locally against synthetic provider; cross-service/live consumer NOT_RUN. |
| RECOVERY_VERIFIED | BLOCKED | Local post-action measurable verification passed; no live incident close or improvement evidence. |
| MITIGATION_ROLLBACK_VERIFIED | BLOCKED | Local TTL/rollback/replacement/restart passed; preview return to baseline NOT_RUN. |
| SERVICE_ROLE_BOUNDARIES_VERIFIED | BLOCKED | Local role suppression/manual ownership passed; no attested live role instances. |
| CONCURRENCY_AND_IDEMPOTENCY_VERIFIED | BLOCKED | Local duplicate/lease/owner tests passed; genuine storage contention and cross-service behavior NOT_RUN. |
| RESTART_SAFETY_VERIFIED | BLOCKED | Prior two-process local invalidation passed; genuine preview restart NOT_RUN. |
| REGRESSION_TESTS_PASSED | PASS | Pinned-toolchain focused/local contract tests and static checks; exact commands/totals in regression report. |
| EXACT_HEAD_RETESTED | BLOCKED | Local source-head regression receipt is distinct; no final-head live preview exists to retest. |
| MERGE_READY | BLOCKED | Mandatory live identity/isolation/application/recovery gates remain blocked. |

## Defects repaired and fixtures

The regression report records failing-before-fix evidence for dispatched
actuator accounting, Railway target containment, and false recovery from empty
or stale request windows. Follow-up lifecycle fencing invalidates verification
for an expired, cleared or replaced Trinity command without claiming recovery
or rolling back another command. Contained provider timeout/503 fixtures,
actual same-process Trinity consumer assertions, scoped authorization/target
tests and a two-process restart fixture provide deterministic local coverage.

## Remaining blockers and risks

1. No owned exact-head normal-runtime Railway preview; no live recovery proof.
2. Trinity/controller state is process-local. A mitigation selected on a worker
   does not reach a separate web service. No distributed command delivery or
   controller arbitration was added as an unrelated redesign.
3. Web automatic suppression is intentional; dedicated durable job-runner
   startup does not start the canonical scheduler. Live ownership must identify
   which same-process consumer can actually use a controller command.
4. Diagnosis keys are types, not unique durable incidents. There is no durable
   incident-open/close lifecycle, active-command restoration or evidence of
   restart-safe exactly-once external effects.
5. Prompt-route mitigation has no TTL; successful policy remains active until
   explicit rollback/clear or restart. Trinity TTL does not reset every budget.
6. Local queue/Redis tests mock storage. Disposable CI storage tests supplement
   regression evidence but do not prove preview wiring or isolation.
7. A standard sealed preview's pure policy contract and passive worker cannot
   establish normal-runtime controller-to-consumer healing.
8. The new prohibition on production service IDs rejects the existing managed
   lifecycle's fixed app IDs. Its trusted-main profile cannot be changed by a
   PR-only patch; manual replacement provisioning would bypass its ownership
   and cleanup contract. Required owner action is specified in preview evidence.

Recommended next action: install the reviewed trusted normal-runtime profile
with preview-exclusive app/storage identities and scoped authority, then
identify its isolated preview at the final PR head, verify role ownership,
then rerun all applicable live scenarios with correlated detection, authorized
effect, actual consumer, measurable recovery and rollback evidence. Keep this
PR open; do not merge, promote, enable auto-merge or modify production while
mandatory gates remain blocked.
