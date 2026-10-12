# Railway preview evidence

## Final cleanup verification — 2026-10-12, 19:50:29 UTC

**CLEANUP_VERIFIED: PASS. LIVE_ACCEPTANCE_VERIFIED: BLOCKED.
MERGE_READY: BLOCKED.**

Fresh authenticated CLI and connected-tool inventories independently show
all three assignment-created project IDs absent:
`21a05b97-59f7-435f-8a3a-234eb722cb6c`,
`7bd0536d-95c1-4db9-a766-6a0f49547617`, and
`db505b48-74f0-4571-9cd3-52bc865ff2cd`.
Both preexisting project IDs remain visible in both inventories.
Production's four service/deployment identities and SUCCESS statuses match the
read-only baseline. No assignment-created project, service or volume remains
in the control-plane inventory. Accrued charges and retained-backup billing
are unverified; deletion is not an invoice showing zero charges.

The first-resource deadline `2026-10-12T19:38:25.364Z` has expired.
This run is closed; no new resource or application deployment was started.
The corrected automated service/volume cleanup rehearsal did not complete,
so precreation cleanup proof for a future run remains **BLOCKED**, although
owner dashboard cleanup and final resource absence are now verified.

Inspected PR head `14bddcd58054c54ef1a052c01d0e1c0a6a94dca6` remains
open/non-draft/unmerged. Only these five documents differ from approved
executable `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
No Railway application artifact, live incident, runtime mitigation or consumer
execution was tested. All fourteen live scenarios remain **BLOCKED / execution
NOT_RUN**; the seventeen required gates retain one PASS for approved-source
regression evidence and sixteen BLOCKED for deployment/live acceptance.
No new executable defect or application fixture was inferred from cleanup.
Earlier incomplete-cleanup statements below are historical snapshots.

The latest documentation update passes `npm run docs:check` (980 checks;
generated indexes current), `npm run docs:links -- --local-only` (716 local
targets;109 external network checks skipped), and `git diff --check`.
At inspected head `14bddcd58054c54ef1a052c01d0e1c0a6a94dca6`, Docs/API
workflow metadata shows SUCCESS; CI/CD38299353539 and PR CI38299353393 were
still IN_PROGRESS. No final status or test total for these runs is inferred.

## Partial forced cleanup and expired staging window — 2026-10-12, 19:39:54 UTC

Fresh CLI and connected inventories independently confirm absence of the
service/volume probe `db505b48-74f0-4571-9cd3-52bc865ff2cd` and second empty
probe `7bd0536d-95c1-4db9-a766-6a0f49547617`. Both preexisting projects remain
visible. Production's four recorded deployment identities and SUCCESS states
still match the read-only baseline.

The first empty probe `21a05b97-59f7-435f-8a3a-234eb722cb6c` remains in both
inventories, with no services and scheduled deletion
`2026-10-14T17:38:48.891Z`. No volume, credential or deployment was created in
that probe. Overall cleanup remains **BLOCKED** pending its forced removal
and fresh absence verification. No known billable workload or volume remains
in the assignment inventory; actual accrued charges and platform retention
are unverified. Earlier residual-service/volume descriptions are historical.

The original two-hour deadline `2026-10-12T19:38:25.364Z` has expired.
No new resource or application deployment will begin within this closed run.
Automated cleanup with services/volumes lacks a completed corrected live
rehearsal. A future run needs a new time window and proven cleanup preflight;
the same approved executable remains
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.

Inspected PR head `fe532c42ed9b5a0e06118068ad000eb006a9a34f` is open,
non-draft and unmerged, and differs from approved executable only in these five
documents. Its Docs/API workflows passed; CI/CD38298606542 and PR CI38298606790
were still running when checked. No terminal result for them is inferred.
No live scenario ran: all fourteen remain **BLOCKED / execution NOT_RUN**.
LIVE_ACCEPTANCE_VERIFIED and MERGE_READY remain **BLOCKED**.

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

## Successful login, executed cleanup probes and approval stop — 2026-10-12

**PRECREATE_CLEANUP_VERIFIED: BLOCKED. LIVE_ACCEPTANCE_VERIFIED: BLOCKED.
MERGE_READY: BLOCKED.**

Fresh authenticated PR metadata: #1539, open/non-draft/unmerged,
branch `codex/targeted-security-healing-20261012`, base
`3fd305b37ba410cf21684a8fed7619a1ba180b48`, inspection head
`a8bb1c35eeea3d59be6fd86c0ce908e4e147767a`.
Git diff from approved application SHA
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67` lists exactly the five audit
Markdown files. No different executable was substituted or deployed.

Supported Railway CLI 5.23.3 sign-in completed successfully; fresh
`whoami --json` and complete project inventories succeeded. Identity/email,
OAuth values and transient activation URLs/codes are omitted.
Workspace: `1c9265a3-986f-4304-ad3e-5a874caab039`.
The two preexisting projects were recorded before creation and excluded from
all mutations: production `7faf44e5-519c-4e73-8d7a-da9f389e6187` and unrelated
`8e4cb1eb-1441-4e83-b434-15c06c676a5f`.

Three disposable projects were actually created. All are assignment-owned;
none contains ARCANOS, PostgreSQL, Redis, a model credential or application data.

| Probe | Project / environment ID | Result |
| --- | --- | --- |
| Original empty CLI probe | `21a05b97-59f7-435f-8a3a-234eb722cb6c` / `057756e5-0b34-4a12-beed-34a7e6dc6f65` | Still present; CLI scheduled deletion for 2026-10-14T17:38:48.891Z. Owner dashboard removal pending. |
| Immediate-delete probe | `7bd0536d-95c1-4db9-a766-6a0f49547617` / `f85c4837-b9e6-46e5-9c40-ddc78e93a63a` | Removed by scoped API projectDelete; fresh CLI and connected inventories confirmed absence. |
| Service/volume probe | `db505b48-74f0-4571-9cd3-52bc865ff2cd` / `5e85ff14-fda4-4325-924c-fee7d0660ab3` | Still present; connected service deletion rejected twice. Owner dashboard cleanup requested. |

The first actual project was created at 17:38:27.240Z. The conservative mission
clock began at **17:38:25.364Z**; the original absolute two-hour expiry is
**19:38:25.364Z**. It was never reset by another probe or sign-in.

### Captured failing and corrective infrastructure evidence

The first watchdog, PID15111, armed at17:38:29.013Z, began cleanup at
17:38:48.227Z and recorded CLI deletion acceptance at17:38:49.060Z.
At17:44:49.061Z it ended:
`BLOCKED / WATCHDOG_DELETE_NOT_CONFIRMED`.
Fresh inventories still contained the project with a deletion time 48 hours
later. Accepted scheduled deletion is not project absence.

The operator API adapter initially returned HTTP403 at inspection. Matching
the pinned CLI's documented normal `User-Agent` and `x-source` client headers
made the same bounded authenticated inspection succeed. An invalid
ProjectMember field was also corrected against the public schema.
The normal CLI refreshes its own OAuth session; only its documented credential
accessor is used privately in memory, never printed, passed in argv or copied
to an application. Caller role remained null/unverified, so OWNER/admin
membership is not claimed.

Fresh detached watchdog PID16987 armed at18:02:53.194Z for the second probe.
It began cleanup at18:03:04.506Z, recorded immediate API deletion acceptance at
18:03:06.114Z, then ended at18:03:06.457Z:
`BLOCKED / WATCHDOG_CLI_FAILED`.
Independent fresh CLI and connected inventories confirmed the target absent,
and an already-absent rerun at18:04:49Z passed without mutation.
Its exact transient subprocess failure is unknown; the original BLOCKED
record is preserved. The revised watchdog has bounded confirmation-read
retries and safe phase/exit diagnostics, tested locally, not yet passed live.

The third probe has two live **empty** service definitions, no source and no
deployment:
`1a37a7ae-c62a-4e0d-af28-a9cdfc71670b`,
`59ff3127-d358-4681-8ded-a61418a8a629`.
Volume `b177bc79-8db3-4530-b91b-9f04e0e6bfde` is live, size1000MB,
region `us-east4-eqdc4a`, mounted at `/data` on the first service.
Fresh inventory verified no buckets/shared variables/credentials.

Deletion of the first service returned:

```text
Cancelled — the user did not approve this action. No changes were made.
```

The owner then explicitly authorized deleting this exact project, its two empty
services and empty volume. A fresh ownership inventory preceded the retry,
which returned the same rejection. A separately scoped deletion of the owned
volume, also explicitly authorized, returned the same cancellation/no-change
result. No alternate deletion path was used to bypass those controls.
Third watchdog PID17490 had armed at18:09:11.122Z;
root stopped it at18:10:15Z, before its18:10:25.632Z expiry, to prevent indirect
execution of the rejected cleanup. Its event log contains only `armed`;
the process is exited, not an active cleanup fallback. Provisioning/fault
injection stopped and the owner was immediately given both remaining dashboard
project links. No service/volume deletion or independent fallback PASS exists.

### Remaining resources, cost and production boundary

Owner removal required:
[empty original probe](https://railway.com/project/21a05b97-59f7-435f-8a3a-234eb722cb6c)
and [service/volume probe](https://railway.com/project/db505b48-74f0-4571-9cd3-52bc865ff2cd).
Delete only those assignment-created projects; skip the grace period if offered.
No extra deployment authorization is required. Cleanup is BLOCKED until a fresh
inventory shows actual absence.

There are no builds, running deployments, jobs, databases or Redis processes,
so no application CPU/RAM/network/model spend occurred. The empty1000MB volume
is the only potentially billed assignment resource. Using the documented
$0.15/GB-month rate and730hours/month, a conservative full1GB estimate is
**about$0.00021/hour**, plus **about$0.01** if billed for a further48hours.
Current short-lived probe cost is estimated below$0.01; this is not an invoice
or measured disk usage. Actual billing/retention is unverified. The two remaining
projects and volume are residual resources; continuing storage charges must
be reported until removal. No shared spending limit or subscription change
was made. The owner's $10 target is operational, not technically enforced.

Read-only production metadata at18:11:51Z matched the preflight deployment-ID snapshot:
web `2a20acd4-3c92-4db6-8995-4a3a466202ef`,
worker `d43d6fec-10f1-479a-8d76-9d3df4f2d295`,
PostgreSQL `7bb12602-2ebb-4901-96a6-a232fba5c279`,
Redis `aeae0e09-e4bb-406f-92ea-cf5ca81294ac`, all SUCCESS, same excluded
service/environment identities. Our production mutation count is zero.
No production variable values, data, secrets or runtime logs were read.

Proposed acceptance project `arcanos-pr1539-healing-staging` was not created.
There are no staging web/worker deployment IDs, artifact digests, incident IDs,
controller/consumer logs or fourteen-scenario fault results.
All genuine runtime scenarios are BLOCKED / execution NOT_RUN.
Operator files/results are preserved outside temporary infrastructure and
summarized with hashes in the [regression report](self-healing-regression-report.md).
The earlier expired-auth/no-resource attempts below are historical.

## Revised authorization and mandatory cleanup preflight — 2026-10-12

**PRECREATE_CLEANUP_VERIFIED: BLOCKED. LIVE_ACCEPTANCE_VERIFIED: BLOCKED.**

The owner explicitly accepts the existing workspace and a tightly time-limited
run without an independently enforced $10 ceiling. $10 is now an operational
target; maximum runtime is two hours from the first mission-created temporary
resource, including disposable cleanup probes.
Spending must be monitored and cleanup must begin when any specified stop
condition occurs. No shared workspace cap was set. The earlier hard-financial-
ceiling blocker is withdrawn.

Fresh authenticated PR metadata confirms open/non-draft/unmerged PR #1539,
branch `codex/targeted-security-healing-20261012`, base
`3fd305b37ba410cf21684a8fed7619a1ba180b48`, inspected head
`450ab65d9955d7627f75fdb3a34fe1773faa23dc`. Git diff from approved executable
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67` lists exactly the five audit
Markdown files. Executable code, dependencies, build configuration and runtime
behavior are unchanged; no renewed executable authorization was needed.

Connected reads again listed the same workspace and two preexisting projects;
proposed `arcanos-pr1539-healing-staging` is absent. Available management tools
still expose no whole-project-delete operation. Current environment readiness
has no configured secrets/runtime identities, and CLI `whoami --json` returned
exit 1, Unauthorized. The supported CLI OAuth/device sign-in was started and
its activation link was immediately shown to the owner. It ended with exit 1:

```text
Device code expired. Please run railway login again.
```

The transient activation URL/code is intentionally not retained in artifacts.
No successful CLI identity, billing/admin role, create permission or deletion
permission was established by this attempt.

Official [CLI deletion](https://docs.railway.com/cli/project) schedules project
removal; accepted deletion is not control-plane absence. A valid cleanup proof
must include noninteractive disposable deletion plus service/volume/project
absence read-back. A narrow environment-scoped project token is not assumed
to permit whole-project deletion. Cron settings and future scheduled prompts
are not evidence of actual cleanup execution.

The proposed path is an executed disposable deletion rehearsal, a detached
watchdog with reviewed exact IDs/creation receipts, successful short-deadline
rehearsal and observed heartbeat, plus actual independent owner dashboard
deletion. The watchdog shares this workspace host; the owner dashboard is the
independent fallback. No second automated controller/provider TTL is imposed.
The owner was asked to complete sign-in and choose dashboard rehearsal or an
existing trusted cleanup controller; that answer remains pending. No disposable
probe was created while management deletion/fallback was unverified.

Resource creation count is zero. Staging project/environment/service/
deployment/incident IDs, runtime artifact digests, baseline/consumer logs and
observed resource usage remain absent. Assignment infrastructure charges remain
$0 because no resources were created; no invoice measurement is claimed.
Previous ~$0.32/two-hour and ~$0.42/retention estimates remain illustrative
assumptions, not a financial stop condition or guaranteed bill. There are no
assignment resources or continuing charges to clean up. No production operation
or deletion of a preexisting resource occurred.

Required next owner action: complete a fresh supported CLI sign-in when ready,
and provide an executable independent fallback (dashboard rehearsal or a
trusted controller with deletion evidence). Then prove both cleanup paths and
arm expiry before provisioning. Additional authorization for the same approved
executable SHA is not requested. Different executable deployment SHAs still
require explicit authorization.

Read-only production deployment identity snapshot (all excluded as targets):

| Production role | Latest deployment ID | Observed status |
| --- | --- | --- |
| Web | `2a20acd4-3c92-4db6-8995-4a3a466202ef` | SUCCESS |
| Worker | `d43d6fec-10f1-479a-8d76-9d3df4f2d295` | SUCCESS |
| PostgreSQL | `7bb12602-2ebb-4901-96a6-a232fba5c279` | SUCCESS |
| Redis | `aeae0e09-e4bb-406f-92ea-cf5ca81294ac` | SUCCESS |

The final delivery receipt independently checks these identities/statuses
again. This is control-plane metadata only, not production runtime testing or
permission to affect any production deployment.

The initial hard-ceiling investigation below remains historical evidence.


## Dedicated staging investigation — 2026-10-12

**LIVE_ACCEPTANCE_VERIFIED: BLOCKED. MERGE_READY: BLOCKED.**

Authenticated GitHub metadata confirmed PR #1539 open, non-draft and unmerged,
branch `codex/targeted-security-healing-20261012`, base
`3fd305b37ba410cf21684a8fed7619a1ba180b48`. Initial requested
`2fd4cf81833ba3be4592654bc7789dd3309374d7` differed from current
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`. The owner explicitly approved the latter
after that difference was reported. The hard $10 ceiling remains unchanged.
No different SHA was deployed.

### Inventory and capabilities

Connected-tool reads listed one workspace, `pbjustin's Projects`
(`1c9265a3-986f-4304-ad3e-5a874caab039`), with two preexisting projects:

| Project | ID | Scope |
| --- | --- | --- |
| Arcanos | `7faf44e5-519c-4e73-8d7a-da9f389e6187` | Production excluded; identity metadata only |
| Arcanos Live PR 1527 | `8e4cb1eb-1441-4e83-b434-15c06c676a5f` | Unrelated; not adopted or changed |

Proposed `arcanos-pr1539-healing-acceptance` was absent. Production environment/
service identities matched the earlier inventory. No production variable
values, secrets, runtime logs, SQL/Redis data or writable dependencies were read.

Current managed-environment readiness exposed no configured secrets, runtime
variables or outbound identities. Official `railway whoami --json` returned
exit 1: `Unauthorized. Please login with railway login`. No interactive login
or token extraction was attempted; the earlier owner-workflow preference was
preserved.

Callable tools expose empty-project/service creation, per-service CPU/RAM
limits, source `commitSha` pinning and scoped service/volume deletion. These
are available capabilities, not exercised create/deploy/delete authority.
Inventory reads do not expose the user's billing/admin role. No billing/usage
limit, project expiry, whole-project deletion, raw GraphQL or remote shell
operation is currently callable. Project deletion exists in the CLI/dashboard,
but CLI authentication is unavailable. No mutation was used to test permissions.

### Costs and hard-ceiling stop

Official [container pricing](https://docs.railway.com/pricing/plans#resource-usage-pricing)
was fetched. This illustrative conservative two-hour footprint is not an
applied configuration; the smallest footprint meeting readiness is unverified.

| Assumption, one replica each | Rate | Two-hour estimate |
| --- | --- | --- |
| RAM: web 2 GB, worker 2 GB, PostgreSQL 1 GB, Redis 0.5 GB; total 5.5 GB | $0.000231 / GB / minute | $0.15246 |
| CPU: 0.5 vCPU per service; total 2 vCPU | $0.000463 / vCPU / minute | $0.11112 |
| Two volumes, at most 5 GB used each | $0.000003472222222 / GB / minute | $0.00417 |
| Public egress, assumed at most 1 GB total | $0.05 / GB | $0.05000 |
| **Resource estimate** | | **$0.31775, approximately $0.32** |

A 48-hour full-10-GB storage reserve adds approximately $0.10: illustrative
total approximately $0.42. Continuous assumed operation for 24 hours would be
approximately $3.26 including 1 GB egress. No buckets, backups/PITR, public TCP
proxies, additional replicas, Railway Agents or paid AI calls are proposed.
Private storage networking and bounded egress are assumptions, not verified
controls. Builds, build CPU/RAM, base-image downloads, image exports and image
storage are documented as free. No service limits or lifetime were applied.

[Billing](https://docs.railway.com/pricing/understanding-your-bill) depends on
subscription commitments and tax. Existing plan, credits, invoice and tax
were not inspected. No free-allowance assumption or plan/account change is made.
The estimate excludes any new subscription commitment and tax; it cannot
guarantee the final incremental bill.

[Cost Control](https://docs.railway.com/pricing/cost-control#hard-limit) documents
a workspace-wide hard limit, minimum $10, that takes all workloads offline.
Using it on the accessible workspace could stop production and is excluded.
[CLI usage](https://docs.railway.com/cli/usage) offers workspace/agent limits;
[project usage](https://docs.railway.com/projects/project-usage) is reporting,
not a documented project-only dollar cap. Email alerts leave resources running.
The documentation does not establish zero metering/shutdown overshoot.

An independent resource/time bound could also satisfy the budget. That proof
is unavailable: CPU/RAM ceilings do not limit elapsed time, egress or retained
storage. A local timer can fail on session disconnection. No authenticated
independent expiry/cleanup mechanism is established.
[Volume pricing/deletion](https://docs.railway.com/volumes/reference#pricing)
includes filesystem metadata; deletion is queued for up to 48 hours and
billing cessation during that queue is not documented. Service deletion keeps
detached volumes requiring separate deletion. Whole-project deletion is
documented in the [CLI](https://docs.railway.com/cli/project) but not executable
with the current authenticated capabilities.

**Stop decision:** the estimated short run is inexpensive, but total spending
cannot be independently bounded below $10. The owner's instruction requires
stopping before provisioning in this situation. No project, service, volume,
credential, source connection, deployment or fault was created.

### Deployment, live evidence and cleanup

Approved source is `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`; running artifact
`EXACT_SHA_VERIFIED` remains BLOCKED. Project/environment/service/deployment
IDs and artifact digests are absent. Source pinning was not executed.
All fourteen genuine staging scenarios are BLOCKED / execution NOT_RUN.
No baseline, isolation attestation, incident/execution IDs, controller/consumer
logs, measured recovery or rollback exists.

Assignment-created infrastructure spend is **$0**, because no resources were
created; this is not an invoice measurement. No staging tests/jobs,
credentials or resources were started. Cleanup execution is NOT_RUN because
there are no created resources to delete, no residual assignment charges and
no preexisting resources were removed. Final inventory verification is
recorded in the PR delivery receipt. Production-operation count is zero.

Required owner action: establish authenticated independently enforced scoped
expiry/cleanup, bounded egress and retained-storage accounting, or a separate
billing setup proving the complete incremental bill fits $10. Verify creation/
deletion authority and all plan charges before provisioning. A new project
alone is not billing isolation. No shared production limit or ceiling increase
is authorized.

The native-preview investigation below remains historical evidence.


Date: 2026-10-12. PR:
[#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Initial remote head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.
Base: `3fd305b37ba410cf21684a8fed7619a1ba180b48`.
Branch: `codex/targeted-security-healing-20261012`; draft: false;
state: open; preview opt-in label absent.

**PREVIEW_ENVIRONMENT_MATCHED: BLOCKED. PREVIEW_ISOLATION_VERIFIED: BLOCKED.
LIVE_PREVIEW_ACCEPTANCE: BLOCKED.**

## Authorized profile preparation

The owner authorized the recommended isolated profile after the recovery
assessment. Current inspection started at
`4b365ce4271a4c13b39b37da3cbad9485b979581`, with the same base and branch,
open/non-draft. Railway inventory still has no PR #1539 preview. The
[provisioning proposal](self-healing-preview-provisioning-plan.md) declares the
separate normal-runtime name `self-healing-pr-1539-e2e`, preserving the sealed
native namespace and checks.

The managed executor's current observed secret bindings are empty. The official
Railway CLI archive for `5.23.3` was verified against its release asset SHA256
`79622bd63fdae79709bba016b892ae61f89c5645fa47e65d2e4f60c21d7e0949`.
`railway whoami --json` returned exit 1:

```text
Unauthorized. Please login with `railway login`
```

The connected Railway tools expose no environment-create operation for the
required existing project. No alternate project or resource was created to
bypass this limitation. The owner selected the owner-run trusted workflow
alternative to supplying a scoped API credential to this session. No token
was requested in chat, read from secret files or printed. Read-only production
source/build metadata confirms both app roles follow `main`, without an
attested watch-path exclusion for installing the new controller/workflow.
This creates an additional stop boundary: a main installation cannot proceed
while it could automatically deploy production. No such installation occurred.

Pure local planning/attestation guards can be prepared while this prerequisite
is pending. They cannot authenticate an operator, prove platform ownership or
substitute for provisioning, isolation or fault evidence. Deployment IDs,
incident IDs, runtime controller/consumer logs and all live gates remain
unavailable. The earlier recovery receipts below remain historical evidence.

## Recovery investigation and stop decision

Recovery inspected PR head `2fd4cf81833ba3be4592654bc7789dd3309374d7`,
base `3fd305b37ba410cf21684a8fed7619a1ba180b48`, open/non-draft, same
branch/repository, with no `railway-preview` label. The current project's
inventory still contains no `pr-676861-1539`. The canonical name is derived
from `RAILWAY_PR_PREVIEW_CONTRACT.environmentPrefix`, not assumed from the user.

The direct cause is intentional admission, not a failed Railway deployment.
[Run 38208187161, job 114676258554](https://github.com/pbjustin/Arcanos/actions/runs/38208187161/job/114676258554)
logged the following decoded, redacted excerpt:

```text
2026-10-12T05:30:14.1745458Z {"schemaVersion":1,"kind":"railway_pr_preview_lifecycle","summary":{"status":"PASS","action":"noop","reason":"not-opted-in"}}
```

`decideLifecycleAction` requires open, non-draft, same-repository `main` PR plus
the label. A no-op returns before creation/deployment. There is no provisioning
failure to bypass or admission defect to fix. Adding the label would trigger
the standard lifecycle, but it would not satisfy this assignment's restrictions.

### Independently verified service identity conflict

Read-only `describe_environment` inspected the exact preview base and production
environment identity/configuration metadata. No values, logs, runtime endpoints,
database records or Redis contents were read. Railway service definitions are
project-level: environments have separate service instances, while their
`serviceId` can be shared. The mission explicitly forbids production service
IDs as preview deployment targets, so environment scoping alone was not treated
as permission to deploy these IDs.

| Fixed lifecycle role | Service ID | Present in preview base | Present in production | Current mission target |
| --- | --- | --- | --- | --- |
| Web | `c4ade025-3f13-4fca-9309-5d0dd81396fe` | Yes | Yes | Rejected |
| Worker | `1765befb-b805-4051-9af9-28634e986886` | Yes | Yes | Rejected |

The base contains exactly these two services and no volumes/shared variables.
The lifecycle requires their IDs, sealed start commands, credential-empty
configuration and a passive worker. Adding PG/Redis, runtime variables, different
service IDs or a normal launcher fails its ownership/configuration guards.
Native PR environment names remain passive even without the sealed CLI flag.
Weakening those checks was not attempted.

### Workflow authority and supported alternatives

The caller/reusable workflows check out `github.workflow_sha` with no persisted
Git credentials. The protected `railway-pr-preview-lifecycle` GitHub environment
allows only branch `main`. Credentialed jobs have contents/pull-request reads
and status writes; they never execute PR-head code. A change solely on this PR
cannot become the trusted provisioning controller through opt-in or recovery
dispatch. No merge, default-branch edit or protection relaxation is authorized.

GitHub secret-name listing returned HTTP 403; this does **not** prove the secret
is missing. Prior masked logs show the named lifecycle secret was populated.
[Scheduled discovery 38211330587](https://github.com/pbjustin/Arcanos/actions/runs/38211330587)
passed workspace-token/project inventory validation. Creation/deployment
permissions were not exercised. No token value was inspected or disclosed.

The documented normal-runtime worker-diagnostics lane has a different custom
namespace and a cleanup-only workflow. Its allowed service IDs also include
the production-shared web/worker/PG/Redis definitions. The existing Live PR
Acceptance workflow admits only `gaming-guide`; the `live-pr-acceptance` GitHub
environment returned 404, and its target/secret availability is unverified.
No unrelated profile, deployment or manually created parallel environment was
adopted as a self-healing preview.

### Owner action required before provisioning

1. Install a reviewed managed **normal-runtime self-healing** provisioning,
   attestation and cleanup profile in the trusted controller. Preserve the
   existing sealed lane and its isolation checks; do not merge PR #1539 to obtain
   this capability or run PR code with the lifecycle credential.
2. Supply preview-exclusive web/worker service IDs and private disposable
   PostgreSQL/Redis instances with fresh storage, purpose-bound preview-only
   credentials and no production service/queue/webhook references. Register
   these identities in that profile's ownership and cleanup contract.
3. Confirm protected-environment credentials and create/deploy authority through
   the trusted workflow, without sharing token values. Identify the intended
   same-process controller/Trinity execution path while retaining role guards.
4. Refresh the actual PR head, deploy and attest that exact SHA, then establish
   baseline and authenticated, bounded preview-only faults. Every code/head
   change invalidates earlier exact-head acceptance.

Recovery stopped before labels, dispatch, environment/service creation,
deployments or faults. Preview environment ID and deployment IDs remain **none**;
isolation, web/worker deployment, baseline and all fourteen live scenarios remain
BLOCKED/NOT_RUN. This is a supported-path and target-identity blocker, not a
claim that Railway creation failed. Historical discovery below is preserved.

## Read-only discovery and exact-head lock

GitHub PR metadata and Railway project/environment/service/deployment inventory
were read through authenticated control-plane tools. No environment values,
secrets, production deployment logs, production runtime endpoints, databases or
queues were accessed. Production access was limited to identity metadata in
project inventory; that environment was excluded from deployment inspection
and testing.

The maintained lifecycle contract at
`scripts/railway-pr-preview-lifecycle.mjs` declares the following target:

| Identity | Value | Evidence / disposition |
| --- | --- | --- |
| Workspace | `1c9265a3-986f-4304-ad3e-5a874caab039` | Lifecycle contract. |
| Expected project | `7faf44e5-519c-4e73-8d7a-da9f389e6187` (`Arcanos`) | Present in authenticated Railway inventory. |
| Expected PR environment | `pr-676861-1539` | Absent from that project's environment inventory; no environment ID can be recorded. |
| Preview base | `8d5594c5-075e-4ad5-8fad-9e6e0866032d` (`pr-preview-base-20260812`) | Present; template/base is not an owned PR deployment. Not tested. |
| Contract web service | `c4ade025-3f13-4fca-9309-5d0dd81396fe` (`ARCANOS V2`) | Project service definition present; no matched PR environment service instance/deployment. |
| Contract worker service | `1765befb-b805-4051-9af9-28634e986886` (`ARCANOS Worker`) | Project service definition present; no matched PR environment service instance/deployment. |
| Excluded production environment | `fb583147-6c39-4343-9267-500f357d25ab` | Name/id seen in inventory only; no test or configuration mutation. |
| Matched PR deployment IDs/statuses | None | No exact-head deployment identified; genuine preview execution prohibited. |

The lifecycle admits open, same-repository, non-draft `main` PRs only with
`railway-preview`. This PR has no such label. Its lifecycle no-op/green workflow
and skipped E2E job are not deployment or runtime evidence. No label was added,
workflow dispatched, environment created, service restarted or redeployed.

Initial-head check receipts: [exact-head supplemental job (skipped)](https://github.com/pbjustin/Arcanos/actions/runs/38203123337/job/114660653773),
[latest lifecycle reconciliation](https://github.com/pbjustin/Arcanos/actions/runs/38204741359/job/114665614068)
and [sealed E2E (skipped)](https://github.com/pbjustin/Arcanos/actions/runs/38204741359/job/114665675622).
Their recorded conclusions and URLs are retained in JSON; there is no executed
E2E receipt or controller/runtime log transcript for this PR.

## Other discovered non-production candidates

These identities were examined solely to reject incorrect association. They
were not adopted, reconfigured, queried as runtimes or fault-injected.

| Candidate | Identity | Result |
| --- | --- | --- |
| Arcanos live-validation environment | `8048969f-07d0-48bd-bc0a-3f07ccbb26d1` | Unrelated environment, not PR #1539. |
| Validation service | `530c6dcf-bb15-4b46-babc-cf00e22b76cf` | Different service from contract roles. |
| Successful validation deployment | `6bb89f16-37b0-48d7-bf9a-ba4076957ca5` | `SUCCESS`, created `2026-10-07T01:25:25.164Z`, updated `2026-10-07T01:41:29.887Z`. |
| Deployment commit/branch | `cfb735d034854d20b85671c74aef533e8e53f728`, `fix/gaming-clear-audit-runtime-budget` | Does not match PR head or branch; success cannot establish current PR acceptance. |
| Other preview environment names | `Arcanos-pr-1433`, `Arcanos-pr-1432` | Different PRs; not tested. |
| Second accessible project | `8e4cb1eb-1441-4e83-b434-15c06c676a5f` (`Arcanos Live PR 1527`) | Different PR; not tested. |
| Second project's environment | `9ca4ff39-612f-4a89-9101-0d98c5f5e5e4` (`live-pr-1527`) | Deployment inventory returned empty. |
| Second project's services | supervisor `625cb884-088a-45da-ac27-4a5e9c00e017`; runtime `261ef14c-3c2a-4f26-ab4e-bd692e4fb201` | Not PR #1539 services. |

Older validation deployment statuses and SHAs, plus sanitized inventories, are
preserved in [machine-readable evidence](self-healing-evidence.json). No
arbitrary latest successful deployment was treated as an exact-head preview.

## Isolation checklist before faults

| Requirement | Result | Reason |
| --- | --- | --- |
| Exact PR-head deployment | BLOCKED | Owned environment absent; unrelated successful deployment has a different SHA. |
| Separate PR service identities | BLOCKED | Contract roles known, but no owned environment instances/deployments. |
| Preview-only variables and credentials | BLOCKED | No matched target; values were not inspected. |
| No production database writes | BLOCKED | Live target could not be attested; no database was contacted by acceptance execution. |
| No production Redis mutations | BLOCKED | Live target could not be attested; no Redis fault/mutation was executed. |
| No shared production queues | BLOCKED | No matched target on which to verify queues; active live workers not started. |
| No production webhooks/external effects | BLOCKED | No matched target; runtime/model/webhook calls not executed. |
| No unauthorized billable model calls | PASS | Local provider transcripts are synthetic loopback HTTP; live model execution NOT_RUN. |
| No production secret access | PASS | Discovery used identity metadata only; no production values were read. |
| Live workflow safe to execute | BLOCKED | Exact-head identity and isolation prerequisites are unavailable. |

The stop condition was honored: dependent live work stopped immediately. The
explicitly authorized local/mocked fallback continued without using production
as a substitute.

## Controller and runtime-consumer evidence

Genuine Railway baseline, detection, incident creation, authorization, command
application, consumer behavior change, recovery, rollback and return-to-baseline
were **NOT_RUN**. There are no live incident IDs, execution IDs, request IDs or
controller/consumer log excerpts to attach. The implementation's diagnosis
`incidentKey` is a type, not a unique durable incident identity. No identifier
was invented or inferred from an unrelated deployment.

Local fixture assertions and sanitized event excerpts belong in the regression
report and JSON. Synthetic clock/request IDs are labeled local and cannot be
correlated to a Railway service/deployment. A selected action, successful
receipt or HTTP response alone is not treated as recovery proof.

## Required next live run

Before any live fault, establish an authorized normal-runtime preview for this
PR, its exact final head, environment-owned web/controller/worker identities,
preview-only credentials and isolated disposable storage/queues. The standard
sealed preview fixture serves pure contracts with a passive worker; even if
deployed, it cannot establish the genuine self-healing workflow by itself.
Refresh the PR head and independently attest each service's active successful
deployment SHA. Any head or ownership change invalidates prior acceptance.
Only then execute contained faults and correlate controller and actual
consumer evidence through recovery and mitigation clearing.
