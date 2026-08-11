# Repository health-audit progress

Status: current non-GPT-OSS dashboard through the latest product slice in
PR [#1427](https://github.com/pbjustin/Arcanos/pull/1427) and merged,
automatically promoted delivery-control PR
[#1430](https://github.com/pbjustin/Arcanos/pull/1430)

Original audit capture: 2026-07-28

Last reconciled: 2026-08-11 UTC

This report is advisory evidence. Current tracked source, tests, required CI,
maintained documentation, and freshly read provider state supersede every
statement here. Nothing in this report authorizes a deployment, database or
provider operation, configuration change, GitHub setting change, or live-memory
action. GPT-OSS is explicitly excluded from the active queue.

## Report map

- This file is the compact current dashboard and implementation order.
- [findings.md](findings.md) is the normalized open/closed finding register
  through audit-scoped product PR #1427 and delivery PRs #1428–#1430.
- [evidence.md](evidence.md) is the PR, validation, preview, merge, production,
  and provider-state ledger through delivery PR #1430.
- [history-through-2026-07-31.md](history-through-2026-07-31.md) preserves the
  former long-form tracked narrative and its dated anchors.

The reorganization intentionally separates current state from chronology.
Future updates should change the tables below and add one compact evidence
dossier; they should not append another full chronological audit.

## Current reconciled snapshot

| Area | Current state |
| --- | --- |
| Audit closure anchor on `main` | PR #1430 merge `98d6ad998e936d4db26b1330b28a9edff1331018`; tree `23a9f5e5853f60508b25b8f7e2148026304c98be`; fetched on 2026-08-11. The latest product slice remains PR #1427. Unrelated Arcanos Gaming PRs #1425/#1426 are present in #1427's base and remain excluded |
| Delivery-control source identity | PR #1428 head `fcabc28398c4f943fa9529bdb9b10570609d0b1f`, merge `c3763fe9a970503baab5f19f1fb1490b52abb622`; PR #1429 head `efe6e216d3fb9bba7d5d3dca56b5b301a0d56174`, merge `8361e37263d6b0a9c32c15b76c1999fd80bf98bb`; PR #1430 head `08bd9d2c15805a465700d5ea064b93f80cfd5613`, merge `98d6ad998e936d4db26b1330b28a9edff1331018`. Each squash merge is tree-identical to its reviewed head |
| Latest closed product slice | Successful non-GPT terminal retention: completed/cancelled Ask and DAG-node rows receive bounded database-clock retention at every authoritative terminal writer; deterministic cleanup preserves active idempotency, diagnostics/accounting observation windows, and unstamped legacy rows |
| PR #1427 final-head evidence | CI/CD run `31463630148`, API Endpoint Tests `31463630146`, Documentation Audit `31463630135`, PR CI `31463630141`, approval run `31463629006`, Codecov patch, and both Railway preview contexts passed at final head `0e3c1d6e`. GitHub reported `CLEAN` and `MERGEABLE` with no unresolved review threads; the passive preview did not exercise PostgreSQL retention |
| Exact-merge delivery evidence | PR #1430 CI/CD run `31529904593` passed all 13 jobs, including Railway Compatibility, `Deployment Readiness`, and `All Checks Complete`; Documentation Audit `31529904589` and Repository Registration `31529904597` passed. Auxiliary documentation analysis `31529904611` repeated the known missing-secret fixture failure and did not gate promotion |
| Production credit | PR #1427 retains its separate manual-promotion/readiness/schema/279-row protection evidence and no live retention stamp/deletion credit. Automatic run `31531116356` then promoted exact #1430 merge to worker deployment `d20a6833-2448-4677-89df-84e46a0d2567` and web deployment `e59f6a27-2d2a-4e24-b9e8-f9ba5d26dd41`; both exact IDs became active, role/readiness and joint active-ID verification passed, and the strict 15-minute/500-line watchdog found no `/ask` timeout or budget-abort regression |
| Promotion control | PR #1428 retired the tracked hold to exact sentinel `none`, introduced one serialized worker-first pair with exact-ID observation, and required explicit project/environment/web/worker configuration plus a dedicated production project-token secret. PRs #1429/#1430 corrected readiness and deployment-history drift exposed by the first two fail-closed runs. Native Railway deployment triggers remain disabled to avoid duplicate independent releases; GitHub is the sole automatic promotion path. The obsolete web-only repository variable `RAILWAY_SERVICE_ID` was removed after acceptance |
| Latest product slice | Successful non-GPT terminal retention is closed in merged source and was present in the dated exact #1430 automatic-acceptance pair; live writer/deletion behavior remains unexercised |
| Next active implementation slice | Predictive/reactive self-heal approval |
| Explicit exclusion | GPT-OSS remains outside this queue and is not made ready by any result in this report |

## PRs #1428–#1430 closure — automatic paired promotion

PR #1428 restored one GitHub-controlled, serialized production pair. Its exact
base was `2db3d41a58d9d34be6ee2119f7da9c0d682ac31e`, reviewed head
`fcabc28398c4f943fa9529bdb9b10570609d0b1f`, merge
`c3763fe9a970503baab5f19f1fb1490b52abb622`, and reviewed/merged tree
`ddfe9047d5060fd768ffa6b900da598b129a1c6f`. It changed nine files
(+505/-232) and merged at `2026-08-11T18:29:15Z`. The workflow now requires
the exact inactive rollout-hold sentinel `none`, explicit project and
environment identity, distinct web and worker service IDs, and a dedicated
production project-token secret. It captures both active baselines, validates
role/readiness before mutation, deploys and verifies worker first, then web,
rechecks both exact active IDs together, and runs the web-only timeout/budget
watchdog. Native Railway deployment triggers remain disabled so a merge cannot
start duplicate independent service releases.

PR #1428 final-head CI and exact-merge CI were green, but its first automatic
run [`31524244647`](https://github.com/pbjustin/Arcanos/actions/runs/31524244647)
failed safely in preflight: production web `/readyz` correctly exposed
`openai`, `database`, `redis`, `public-provider-admission`, and `startup`, while
the repository verifier still expected the earlier four-name contract. No
deployment was enqueued and the #1427 pair remained active.

PR #1429 synchronized the activation verifier, production smoke checker,
negative tests, pinned digest, and maintained readiness documentation with the
five-check contract. Its reviewed head was
`efe6e216d3fb9bba7d5d3dca56b5b301a0d56174`, merge
`8361e37263d6b0a9c32c15b76c1999fd80bf98bb`, and shared tree
`947a39b7fa7983baaa7c402c8da8e3c592e56a6c`; it changed six files (+20/-5)
and merged at `2026-08-11T19:10:10Z`. Exact-merge CI run `31526489055`
passed all 13 jobs. Automatic run
[`31527715994`](https://github.com/pbjustin/Arcanos/actions/runs/31527715994)
then passed preflight and enqueued exact worker deployment
`1732d5d2-9433-4fbd-b2a0-db2e9534f87d`, but the first observation poll asked
the long-lived service for 100 deployment records and exceeded its fixed 256
KiB command-output cap. Web was not enqueued. The detached worker later became
active; both roles stayed ready, and the intervening revisions contained only
workflow, scripts, docs, and tests, so the temporary worker-new/web-old pair
did not cross an application, worker, package, or schema compatibility change.

PR #1430 bounded exact-deployment observation to the newest 20 records while
retaining exact-ID matching, the 256 KiB output cap, ten-second polling, and the
45-minute elapsed-time budget. A live credential-safe size read found 20
worker records occupied 60,507 bytes and contained the just-enqueued ID. The
reviewed head was `08bd9d2c15805a465700d5ea064b93f80cfd5613`, merge
`98d6ad998e936d4db26b1330b28a9edff1331018`, and shared tree
`23a9f5e5853f60508b25b8f7e2148026304c98be`; it changed three files (+7/-3)
and merged at `2026-08-11T19:50:47Z`. Copilot's one actionable thread asked
the test to consume the exported limit contract; final head `08bd9d2c` made
that change, refreshed the pinned source digest, replied to the thread, and
resolved it. Required PR checks and exact-merge CI run `31529904593` passed.

Automatic acceptance run
[`31531116356`](https://github.com/pbjustin/Arcanos/actions/runs/31531116356)
started from the exact #1430 merge without manual dispatch. Policy job
`93911098579` and production job `93911152941` passed. Preflight recorded
worker baseline `1732d5d2-9433-4fbd-b2a0-db2e9534f87d` and web baseline
`8fce3a96-e7c2-408c-9eae-f28e55dce823`, then activated:

- worker `d20a6833-2448-4677-89df-84e46a0d2567` for exact merge `98d6ad99`;
- web `e59f6a27-2d2a-4e24-b9e8-f9ba5d26dd41` for the same exact merge.

Both role/readiness checks, both exact active-ID checks, and the final joint
pair check passed. The strict post-deploy watchdog scanned 500 web log lines
over 15 minutes and found no `/ask` timeout regression or budget-abort signal.
The run completed at `2026-08-11T20:13:27Z`.

GitHub now retains the four canonical Railway repository variables:
`RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_NAME`,
`RAILWAY_WEB_SERVICE_ID`, and `RAILWAY_WORKER_SERVICE_ID`; the obsolete web-only
`RAILWAY_SERVICE_ID` variable was removed after acceptance. The dedicated
`RAILWAY_PRODUCTION_PROJECT_TOKEN` secret remains configured by name; its value
was never logged or written to the repository. The pair is coordinated,
worker-first, and serialized, but Railway does not make it provider-atomic. A
worker success followed by web failure still requires reviewed forward
completion or exact-baseline reconciliation; the workflow intentionally does
not guess a rollback or redeploy application code across an unknown schema
state. No database, provider/model, or live-memory operation was part of this
delivery-control restoration.

## PR #1427 closure — successful non-GPT terminal retention

PR #1427 merged on `2026-08-11T07:16:23Z` as
`2db3d41a58d9d34be6ee2119f7da9c0d682ac31e`. Its exact base is
`b270997a356071fdfa63823ca67beabde897b67f`, its final reviewed head is
`0e3c1d6ebbb4523a71728f8b1d847b27ad23053a`, and both head and merge resolve
to tree `626e623852c70481cbb8a76b6ad9113631ddde18`. It contains two commits, 26
changed files, and +2,291/-75 lines. The Gaming work already present in the
base remains outside this audit slice.

The merged lifecycle policy positively allowlists only completed or cancelled
`ask` and `dag-node` rows. Ask retention defaults to 24 hours and DAG-node
retention to one hour; configured values are bounded from one hour through 30
days. All six authoritative terminal writer families—terminal creation,
generic terminal update, fenced claimed-job completion/cancellation, pending
cancellation, stale-job cancellation recovery, and stalled-worker cancellation
recovery—preserve explicit then persisted retention before applying the
database-clock fallback. GPT lifecycle ownership is unchanged; failed,
unknown, and local-agent rows remain outside this policy.

Cleanup is enabled by default and deletes one deterministic bounded batch only
after retention has elapsed, the row is older than the greater of one hour and
the configured diagnostics window, and any idempotency deadline has elapsed.
`FOR UPDATE SKIP LOCKED` supports disjoint concurrent cleaners. Unstamped legacy
rows remain ineligible; their inspection is bounded and aggregate-only, and a
process-local latch prevents repeated warning floods while preserving ongoing
aggregate counts. Non-GPT cleanup logs expose counts rather than job IDs.

Local Node 20.19.0 validation passed build, type-check, lint with zero errors
and 76 existing warnings, Railway validation, eight focused Jest suites with
120 tests, the 327/327 documentation audit, current generated indexes, and
`git diff --check`. Independent source, SQL/concurrency, and test-coverage
reviews found no remaining merge blocker. The final review disposition had no
unresolved thread.

At final head `0e3c1d6ebbb4523a71728f8b1d847b27ad23053a`, CI/CD run
`31463630148`, API run `31463630146`, Documentation Audit `31463630135`, PR CI
`31463630141`, approval run `31463629006`, Codecov, and both Railway preview
contexts passed. The required PostgreSQL 18 job exercised the real terminal
writers and bounded/concurrent cleanup; the worker regression exercised the
actual Ask consumer-success path through the fenced repository writer with
provider and database transports mocked. The automatic Railway preview was a
passive, credential/database-empty deployment contract, so it did not prove
PostgreSQL persistence or cleanup and receives no retention E2E credit.

At the exact merge, CI/CD run `31468287598` passed all 13 jobs and `All Checks
Complete`; Documentation Audit `31468287552` passed 327/327; Repository
Registration `31468287557` was workflow-green although its backend request
returned HTTP 400; and auxiliary documentation-analysis run `31468287618`
failed on the already recorded missing
`ARCANOS_JOB_READ_CAPABILITY_SECRET` startup fixture. Railway Auto Deploy run
`31469237913` enforced hold `20260727-dag-snapshot-generation-v1` and skipped
production job `93708761589`.

GitHub recorded nine non-production #1427 merge-SHA deployment records. Their
initial attempts failed, the same pattern was already present on the base, none
targeted production, and all nine records were inactive at the bounded
2026-08-11 readback. Preview environment
`2b806b26-50de-4803-b710-b1fab9956ebb` served the exact head through green web
deployment `05b35321-df86-4ac0-ac1f-68a895ac9057` and passive-worker deployment
`111f0a3d-46ae-44d5-b5ef-3d3b9a2b40de`; cleanup run `31468287960` passed and
the preview was inactive by `2026-08-11T07:17:31Z`. Its credential/database-
empty runtime still supplies no PostgreSQL retention evidence.

An authorized production operation later drained both previous application
writers and deployed exact merge `2db3d41a58d9d34be6ee2119f7da9c0d682ac31e`
to web deployment `8fce3a96-e7c2-408c-9eae-f28e55dce823` and worker deployment
`71f3c370-9054-43f7-a44f-dd37fe7e6147`. Both became successful on 2026-08-11,
reported that exact commit, retained the tracked `/readyz`, 300-second health,
60-second drain, and integrity-launcher contract, and returned HTTP 200
readiness. Sanitized startup-log review found no fatal startup condition; the
nonempty error-classified lines were Node JSON-module warnings, and the worker
reported the privacy-bounded legacy-null protection event.

A read-only post-deploy database transaction verified zero running or
cancel-requested jobs, one non-null validated `dag_runs.snapshot_generation`
BIGINT column and its nonnegative constraint, 23 protected legacy Ask rows, 256
protected legacy DAG-node rows, and no newly stamped terminal row. This is exact
deployment, readiness, schema, and legacy-protection evidence—not a live
terminal-writer or eligible-cleanup deletion test. The operation made no
provider/model or live-memory call and performed no manual migration or
backfill, retention aging, or operator-invoked cleanup; the worker's automatic
startup inspection is accounted for above.

## PR #1424 closure — protected-digest tooling

PR #1424 merged on `2026-08-08T23:37:38Z` as
`4f253ff68bdcea5c1b5fcc9e8525a43b92d291d3`. Its exact base is
`6a3ef8763e3d97ef10e5345d3061268527d87373`, its final reviewed head is
`b59da846b829a9133c3dbb75d64e2d6994f523ab`, and both head and merge resolve to
tree `aa570f1a1415fabcd09d451072f0abbd9c9f2256`. It contains six commits, 56
changed files, and +9,066/-5,532 lines.

The merged slice establishes one versioned semantic-digest owner shared by
runtime integrity checks and operator tooling. The command covers all seven
manifest entries, distinguishes the six runtime-owned pins from the generic
manual-only entry, derives runtime-selected sources rather than accepting a
substitute during complete checks, and fails closed on malformed pins,
candidate data, environment overrides, source changes, and mismatches.
Non-finite JSON numbers fail schema validation instead of collapsing to the same
semantic digest as `null`; automatic reports omit candidate and expected digest
values.

Normal tracked Railway web and worker startup runs the compiled comparison
after mounted volumes are available and before the role launcher. The automatic
gate skips only when none of the six runtime-owned pins is configured. Native
PR previews run that same gate before the exact sealed-preview launcher, signal
handling prevents an interrupted comparison from racing into startup, and CI
Deployment Readiness exercises the wrapper under an explicit safe web role with
`RUN_WORKERS=false`.

Local Node 20.19.0 evidence includes successful build, type-check, lint with no
errors, an initial 82/82 focused matrix, a final 115/115 focused matrix,
Railway validation, native-preview boundary checks, current generated indexes,
and compiled generation/pre-cutover smoke checks. A broad non-GPT sweep passed
7,600 tests; two unrelated load-sensitive Windows process tests subsequently
passed 28/28 in isolation. The unchanged GPT-OSS CRLF fixture remains excluded.

At final head `b59da846b829a9133c3dbb75d64e2d6994f523ab`, CI/CD run
`31283307853`, API run `31283307807`, Documentation Audit `31283307816`, PR CI
`31283307810`, approval run `31283307111`, Codecov, and both Railway service
contexts passed. The automatic preview used environment
`275ef5a6-1c59-4820-9330-40ef34465ec3`, web deployment
`e915a498-1396-43a0-970e-6786245d84fc`, and passive-worker deployment
`1cd8e566-7eee-4d43-9616-3f2f5c5e1356`; the contained runner passed 68/68
requests with stable exact-head identity. This proves served identity, no-pin
gate handoff, and the sealed component matrix, not configured-pin matches,
normal provider/database behavior, or production state. A 2026-08-10 readback
found the preview environment absent and both former preview health URLs
returning HTTP 404; that supports current teardown, not deletion of every
historical artifact.

At the exact merge, CI/CD run `31284399435` passed all 13 jobs and
`All Checks Complete`; Documentation Audit `31284399440` passed 327/327;
Repository Registration `31284399454` was workflow-green despite its
non-critical HTTP 400; and audit-cycle run
`31285801521` passed. Auxiliary documentation-analysis run `31284399453`
failed on the already recorded missing `ARCANOS_JOB_READ_CAPABILITY_SECRET`
startup fixture. Railway Auto Deploy `31284925830` enforced hold
`20260727-dag-snapshot-generation-v1` and skipped production job
`93171963381`.

Railway repository integration separately started 18 web/worker deployments
across nine non-production environments. Commit-status history ended with five
successes and 13 failures; the 2026-08-10 inventory reported those five former
successes removed and the other 13 failed. None targeted the production or
#1424 preview environment. This external fan-out is not production credit, and
status history does not establish complete cleanup of every historical artifact.

## PR #1423 closure

PR #1423 merged on `2026-08-08T06:57:44Z` as
`6a3ef8763e3d97ef10e5345d3061268527d87373`. Its exact base is
`7bc83f469e571cd19626dbd2fa9360a8596b38e7`, its reviewed head is
`58754e5632bd4bea4640ba83fc79b3a5f9a551e2`, and both head and merge resolve to
tree `55fe0200366bf7a06ad9f752b05e6c9e65b54093`. It contains two commits, nine
changed files, and +80/-8 lines.

The merged slice removes the unused Node/backend
`config.limits.requestTimeout`, the backend `REQUEST_TIMEOUT=30000` example,
and the corresponding millisecond-valued backend documentation claim. It does
not add an HTTP-server timeout property, a response-only `Promise.race`, or any
other substitute that could falsely imply cooperative cancellation of admitted
work. The Python daemon remains separate: `BACKEND_REQUEST_TIMEOUT=15` and
`REQUEST_TIMEOUT=30` are seconds-valued controls with maintained consumers, and
the documentation names their bounded scope rather than implying universal
coverage.

Focused local validation passed the two-test Node/documentation contract, all
six daemon OpenAI-adapter tests including exact timeout propagation, the
311/311 documentation audit with current generated indexes, and
`git diff --check`. Independent Node/runtime, daemon-contract, tests/CI, and
generated-artifact reviews found no merge blocker. The optional test-hardening
recommendation and daemon-consumer wording correction were implemented; the
final Copilot review produced no inline comments, and no review thread remained.

At the exact reviewed head, CI/CD run `31240522180` passed all 13 jobs,
including Security Audit, PostgreSQL, Node, Python, Redis, Railway compatibility,
deployment readiness, and `All Checks Complete`. API Endpoint Tests run
`31240522159`, Documentation Audit run `31240522158`, and PR CI run
`31240522167` passed, as did Codecov, approval-policy, Copilot, and both Railway
preview contexts. The bounded native runner passed 68/68 requests against
environment `b9067c39-49b8-49f6-bffe-148e5b2de058`, with exact served-head
identity and stable web/worker readiness. That preview is sealed component
evidence, not proof of a Node request deadline, normal provider/database work,
or production rollout.

At the exact merge, CI/CD run `31245091797` passed all 13 jobs and
`All Checks Complete` verified all 11 required results. Documentation Audit run
`31245091796` passed 311/311 with current generated indexes. Repository-
registration run `31245091806` was workflow-green although its non-critical
backend registration request returned HTTP 400. Auxiliary documentation-
analysis run `31245091805` failed for the already recorded missing
`ARCANOS_JOB_READ_CAPABILITY_SECRET` startup fixture. Railway Auto Deploy run
`31245615516` enforced hold `20260727-dag-snapshot-generation-v1` and skipped
production job `93073631689`.

Railway repository integration separately started 18 web/worker deployments
across nine environments marked non-production and distinct from the #1423
preview environment; six succeeded and 12 failed. Commit-status history
does not prove current lifecycle state or cleanup. No production deployment,
database operation, provider/model call, live-memory mutation, or provider-
configuration change is credited to #1423.

## Active implementation queue

This order supersedes every older queue in the historical narrative.

| Order | Priority | Slice | Completion contract |
| --- | --- | --- | --- |
| 1 | Older ranked | Predictive/reactive self-heal approval | Re-integrate the explicit-approval candidate on current `main`; preserve policy ownership and prove no predictive path performs an unapproved reactive effect |
| 2 | Older ranked | Hard versus advisory worker-budget semantics | Ratify the product semantics, implement them at the authoritative ownership seam, and align readiness/diagnostic claims |
| 3 | P2 | `/dispatch` GPT-ID validation before quota admission | Move deterministic canonical identifier rejection before public-provider admission and prove invalid IDs consume no quota in ready, exhausted, and unavailable-store states |
| 4 | P2 | `/dispatch` parser/auth/admission ordering | Characterize and introduce bounded selector/route parsing before broad parsing without weakening DAG authentication, admission, or unrelated route contracts |
| 5 | P2/P3 | Remaining observability, readiness, privacy, Redis, architecture, scale, warning, and cleanup cluster | Subdivide the residuals enumerated in [findings.md](findings.md): generic-model and GPT-log cardinality, rate-policy epoch, corrupt-counter integrity, real-Redis capability proof, public-health minimization, and raw-path pre-decode bounds; then continue shadow MCP registry, ActionPlan transport duplication, measured stale-recovery/worker-discovery/index planning, GPT Access contract extraction, provider-option/Trinity limits, and behavior-preserving warning or excluded-test cleanup |

Do not combine these into a broad refactor. Each slice needs its own red
characterization, smallest safe implementation, focused regression evidence,
and current-source review.

## Bounded follow-ups

| Follow-up | Deadline or trigger | Current disposition |
| --- | --- | --- |
| Repair the auxiliary Analyze Documentation Updates startup fixture by supplying its required sealed `ARCANOS_JOB_READ_CAPABILITY_SECRET` test value | Next workflow-maintenance slice | Still open. Exact-merge runs `31468287618`, `31522967336`, `31526489082`, and `31529904611` repeated the inherited fixture-only failure through #1430; each maintained Documentation Audit and required main-CI gate passed |
| Re-review and remove the temporary npm-audit platform-profile exception rather than extending it silently | 2026-08-10 | Deadline reached and the follow-up remains open; no silent extension is authorized. PR #1422 patched Hono to `4.12.34` and removed the obsolete Hono and `@hono/node-server` exceptions; the remaining exact platform profiles still require re-review |
| Reverify preview teardown and other provider lifecycle state | Before claiming cleanup | The #1422 and #1423 preview absences were previously attested. A 2026-08-10 Railway inventory did not contain #1424 preview `275ef5a6-1c59-4820-9330-40ef34465ec3`, and both former preview health URLs returned HTTP 404. #1427 preview cleanup run `31468287960` passed after merge and the transient preview deployment was reported inactive; this supports preview teardown, not deletion of every historical artifact. #1427's nine non-production merge-SHA deployment records were also inactive at the 2026-08-11 GitHub readback |
| Restore automatic paired production promotion | Before expecting a merge to promote automatically | Closed by PRs #1428–#1430. The hold is exact sentinel `none`; a dedicated production project-token secret and explicit project/environment/web/worker variables are configured; native Railway triggers remain disabled; and run `31531116356` automatically promoted and jointly verified exact worker/web merge `98d6ad99`. The obsolete web-only repository variable was removed. The documented non-atomic partial-failure reconciliation remains an operational residual |
| Reverify production topology, edge policy, logs, retained-job inventory, and drain readiness | Before the next audit-scoped production promotion | #1427 retains the bounded job/schema/279-row protection evidence. Automatic #1430 acceptance freshly verified exact target/role/readiness/active-ID state and the strict post-deploy timeout/budget watchdog for both deployed roles. Live new-row retention/deletion, edge-policy detail, log-retention duration, and a measured provider-level rollback remain unexercised |

## Production and rollout state

The previous authorized production reconciliation was performed on 2026-08-02 at
the PR #1415 generation (`8bb0b80350d39a663c5dde0eefd81abfe27e4bf8`).
That operation applied and verified the job-claim, DAG-snapshot, and worker
statistics database contracts, restored the original database access policy,
rotated a credential exposed in private tool output, and ended with healthy web
and worker deployments. The provider backup existed, but restorability was not
tested.

A read-only Railway reconciliation on 2026-08-08 confirmed production
environment `fb583147-6c39-4343-9267-500f357d25ab` still serving the exact
August 2 baseline with healthy web and worker roles. A later 2026-08-10 check
found web deployment `4865a033-5cbe-4f9d-9ef4-4fad18a7be33` serving unrelated
Gaming merge `b270997a356071fdfa63823ca67beabde897b67f` and worker deployment
`12098d15-923e-4c15-91c0-d02225f7fe4d` without commit provenance. That Gaming
state predates the #1427 promotion and is not audit-slice evidence.

On 2026-08-11 an authorized coordinated cutover stopped both prior application
writers after confirming zero active jobs and the required DAG snapshot-
generation schema. It then deployed exact #1427 merge
`2db3d41a58d9d34be6ee2119f7da9c0d682ac31e` to web deployment
`8fce3a96-e7c2-408c-9eae-f28e55dce823` and worker deployment
`71f3c370-9054-43f7-a44f-dd37fe7e6147`. Both provider records and running
instances report the exact merge. Their effective manifests use `/readyz`, a
300-second activation timeout, 60-second drain, one replica, and
`start-railway-service-with-integrity.mjs`; both public readiness endpoints
returned HTTP 200 with `ready: true`.

Bounded sanitized logs showed readiness/startup markers and no fatal condition.
A startup worker inspection emitted the designed aggregate-only legacy-null
protection warning. A read-only database transaction then found zero active
jobs; a valid non-null BIGINT `dag_runs.snapshot_generation` plus its validated
nonnegative constraint; 23 unstamped completed/cancelled Ask rows; 256
unstamped completed/cancelled DAG-node rows; and zero stamped rows in either
allowlisted family. The 279 legacy rows therefore remained protected. No live
writer was invoked and no row was aged or deleted, so production deployment is
verified while live retention stamping and cleanup deletion are not.

That #1427 automatic run was blocked by policy rather than red required CI:
the tracked hold still named `20260727-dag-snapshot-generation-v1`, no paired
service selector or dedicated production project-token secret existed, and
Railway-native triggers were absent. PR #1428 subsequently changed the hold to
the exact inactive `none` sentinel and introduced the reviewed single-job,
worker-first pair. Its first run failed before mutation on a stale four-check
web-readiness contract. PR #1429 corrected the five-check contract; its run
passed preflight and enqueued only the worker before the 100-record deployment
history overflowed the bounded observer. That detached worker became active,
while the old ready web remained active; no runtime/schema difference existed
between those revisions.

PR #1430 reduced the observation window to the newest 20 records and retained
the exact-ID and fixed-output fail-closed checks. Automatic run `31531116356`
then promoted exact merge `98d6ad998e936d4db26b1330b28a9edff1331018`
to worker `d20a6833-2448-4677-89df-84e46a0d2567` and web
`e59f6a27-2d2a-4e24-b9e8-f9ba5d26dd41`. Both roles and both active IDs were
reverified together, and the post-deploy watchdog passed. GitHub now supplies
the only automatic production trigger; both Railway-native triggers remain
disabled. The obsolete repository variable `RAILWAY_SERVICE_ID` was removed
after acceptance.

The #1422 and #1423 merges each triggered 18 Railway repository-integration
deployments across nine non-production environments, and #1424/#1427 produced
similar fan-out. Those records are not production credit; the bounded #1427
readback found all nine merge-SHA deployment records inactive. Before any later
rollout, freshly reverify exact provenance, schema/writer compatibility,
integrity behavior, retained and active jobs, consumers, old-replica drain,
provider configuration, and promotion policy.

## Current repository-health verdict

| Dimension | Verdict |
| --- | --- |
| Architecture | Substantially improved. Executable dependency boundaries and cycle gates exist; remaining debt is localized to named coordination and transport seams rather than repository-wide spaghetti |
| Correctness | Stronger database/job/DAG/Backstage/Research contracts, fail-closed required PostgreSQL/aggregate CI truth, backend-timeout truthfulness, protected-digest tooling, and prospective successful non-GPT terminal retention are merged through audit-scoped PR #1427; delivery controls are reconciled through #1430. Self-heal approval and worker-budget semantics remain explicit work; live terminal stamping/deletion is not yet exercised |
| Security | The scoped ingress, disclosure, admission, Backstage, Research, exact MCP body-cap, Hono remediation, backend-timeout truthfulness, protected-digest generation, and six-runtime-pin startup gate addressed by PRs #1409–#1424 plus #1427's privacy-bounded retention cleanup are closed in merged source. Broader dispatch/pre-admission parser, log/metric, Redis-integrity, and public-health residuals remain open in the finding register |
| Scalability | Public provider admission, bounded DAG/Backstage/Research persistence, stale-recovery batching, Research aggregate cancellation, and bounded deterministic Ask/DAG terminal cleanup are present. Legacy-null cutover, deletion latency under live scale, replica-policy assumptions, and hard/advisory worker budgets still need explicit contracts or measured evidence |
| Maintainability | Ownership and documentation improved materially. Large coordinators, duplicate transport contracts, warnings, and stale/manual tests remain isolated cleanup candidates |
| Delivery and operations | Exact #1427 product/schema/legacy protection remains verified, and #1430 was automatically promoted as one exact worker-first pair with joint activation/readiness and watchdog evidence. The hold is `none`, canonical two-role configuration and the dedicated secret are present, the legacy web-only selector is removed, and native Railway triggers remain disabled by design. Provider-level atomicity, partial-failure reconciliation, stale non-production history, and the auxiliary documentation-analysis fixture remain operational debt |

## Delivered program summary

PRs #1408–#1424 plus audit-scoped product PR #1427 and delivery-control PRs
#1428–#1430 delivered the capability foundation and repository-health
remediation program in reviewable stages. Unrelated
Gaming PRs #1425/#1426 are present in #1427's base but excluded from this audit.
The durable merge ledger and exact evidence live in
[evidence.md](evidence.md). In broad terms,
the program:

- introduced protected productivity and local-agent capabilities with a
  TypeScript-owned protocol boundary and a private outbound Python daemon;
- removed dependency cycles and established executable layer/cycle gates;
- hardened authentication, credential isolation, pre-parser ingress,
  confirmation, disclosure, filesystem/process containment, and public error
  shaping;
- normalized OpenAI, queue, cancellation, runtime-admission, and terminal-state
  semantics;
- added job-claim and DAG-snapshot generation fencing, serialized cancellation,
  bounded retention, and PostgreSQL concurrency evidence;
- hardened release provenance, dependency policy, documentation checking,
  Railway preview containment, and production-promotion gates;
- contained memory, worker diagnostics, generic-job reads/cache behavior,
  dispatch/provider admission, and GPT metric identities;
- bounded worker accounting, stale recovery, Backstage mutation/roster/storyline
  lifecycles, Research inputs/storage and aggregate execution, and effective MCP
  pre-parser admission;
- made required PostgreSQL commands and the aggregate CI gate fail closed,
  patched the transitive Hono runtime, retired its obsolete audit exceptions,
  and removed an inert Node/backend timeout setting while preserving the
  Python daemon's distinct live seconds-valued controls;
- added one canonical protected-configuration digest command plus a fail-closed
  Railway startup gate for the six runtime-owned pins, with the seventh generic
  JSON entry retained as manual-only tooling;
- added prospective database-clock retention for completed/cancelled Ask and
  DAG-node rows plus deterministic bounded `SKIP LOCKED` cleanup that protects
  idempotency, observation windows, and unstamped legacy rows; and
- restored one serialized worker-first automatic production pair with exact
  revision/role/readiness/active-ID verification, bounded detached-deployment
  observation, and a strict post-deploy timeout/budget watchdog.

## Update discipline

Within this audit bundle, each future slice should update only:

1. the source identity and latest closed slice in **Current reconciled
   snapshot**;
2. the ranked **Active implementation queue**;
3. the affected row in [findings.md](findings.md);
4. one compact dossier in [evidence.md](evidence.md) containing base, reviewed
   head, merge, tree, final validation, review disposition, preview or production
   proof, limitations, and external mutations; and
5. the production row only after exact deployed-revision attestation.

Do not duplicate full command logs, intermediate green reruns, commit-by-commit
narratives, worktree inventories, or repeated authorization disclaimers.
