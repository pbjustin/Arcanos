# Self-healing regression report

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

## Authenticated cleanup and operator-fixture validation — 2026-10-12

Approved application source remains
`4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
Inspection head `a8bb1c35eeea3d59be6fd86c0ce908e4e147767a` changes only the
five audit documents. No application code, dependency, build or permanent
fault-injection change was made, and no application was deployed.

Operator artifacts were prepared in `/tmp/pr1539-staging-operator`,
separate from the PR's executable/source and outside Railway infrastructure.
They contain finite synthetic faults, role-separated auth, bounded SDK relay
requests, cancellation/backstop distinctions, fresh-target allowlists,
unchanged preview/integrity guards, absolute expiry and fail-closed cleanup.
No production secret/provider credential was copied. Independent reviews
checked guards, schema, scope, deadlines and the supported role-only timeout
configuration. Thirty fake cleanup tests and163 synthetic operator assertions
pass; they do not execute ARCANOS or establish a live acceptance gate.

| Operator artifact | SHA256 |
| --- | --- |
| `provider-fixture.ts` | `3fcf8dedb3f49825fe93243ac5a906d485717e9080cfc6b8fccebd28e4f64b1a` |
| `loopback-bootstrap.mjs` | `f5064a414034ee5ba3c8f2493dc72a0a4012ce11f6a8c5f26113f71929fb3ef3` |
| `operator-verification.test.mjs` | `c63430d612e506acc732d475ff4f35d91a69823904b510cb3d9a9758da352007` |
| `immediate-project-delete.py` | `4feb2a25ff768c21247b04abf7e5c1551c750c5d6883db424d63b3797da33c59` |
| `cleanup-watchdog.mjs` | `1c6a9bf479c2b23a6d800a2dfe4ce960e1de6cb46296b060ef765ad7dbdc112e` |
| Pinned Railway5.23.3 executable | `0d6b51f7e708eeb28d5f0f649cef9d24bc00151d833329a84fc1cc47b1e8e040` |

Executed commands/results:

| Command | Result and boundary |
| --- | --- |
| `env -i PATH=/usr/local/bin:/usr/bin:/bin /tmp/arcanos-preview-recovery-toolchain/node-v24.18.1-linux-x64/bin/node /tmp/pr1539-staging-operator/operator-verification.test.mjs` | PASS at18:05:21.784Z:163 assertions, zero failures;500 quota-success requests counted separately. SDK6.25.0, only127.0.0.1 sockets, injected upstream, no ARCANOS/Bun start or external provider. |
| Same command using `/tmp/pr1539-staging-operator/frozen/operator-verification.test.mjs` | PASS at18:05:41.117Z:148 historical assertions; overlaps current163 and is not added to a unique total. |
| `python3 /tmp/pr1539-staging-operator/immediate-project-delete.test.py` | PASS:16 fake cases, zero failures/skips; no credentials/API. |
| `node --test /tmp/pr1539-staging-operator/cleanup-watchdog.test.mjs` on pinned Node24.18.1 | PASS:14 fake cases, zero failures/skips; no live CLI/API. |
| `node --check /tmp/pr1539-staging-operator/cleanup-watchdog.mjs` | PASS on pinned Node24.18.1. |
| CLI `whoami --json`, `project list --json`; fixed-receipt API `inspect` | Executed successfully; principal private details withheld; caller role not verified. |
| First actual short-deadline CLI cleanup watchdog | BLOCKED: scheduled48-hour deletion did not remove project. |
| Second actual detached immediate-delete watchdog | BLOCKED on first confirmation read; API deletion separately succeeded and fresh CLI/MCP absence was verified. |
| Corrected third detached watchdog | NOT_RUN to expiry: deliberately stopped after connected service deletion rejection. Local correction is not a live watchdog PASS. |
| Connected exact-owned service deletion, explicit-owner-authorized retry and separately authorized volume deletion | BLOCKED: two service rejections and one volume rejection, each “the user did not approve this action”; no changes. |

Two cleanup-diagnostics regressions failed before correction; failing-before
log SHA256:
`598766129a9498d02b33fdc26e6a74ff23049637e2d3ca7f9ffbe48b6db2e90d`.
The operator correction adds sanitized failure phase/exit/signal and at most
two retries after CLI exit/timeout failure, stopping on the third classified
confirmation-read failure. Successful presence polling remains bounded by six
minutes and the absolute deadline. The mutation is still dispatched once.
Invalid JSON, target drift, binary mismatch or malformed
adapter acceptance fails closed. The unknown original live confirmation cause
is not retroactively assigned. Exact scripted invocations, frozen source,
sanitized logs and project receipts remain in the operator directory.
No ARCANOS regression/fix is inferred from infrastructure/tool approval errors.

The provider/bootstrap preserves FORCE_MOCK and the protected launcher;
ordinary core Trinity/ask paths remain the intended scope. Web reasoning6000ms
and worker stage1000ms/runtime10000ms are supported test-profile settings, not
new application code. Worker stage also caps its whole watchdog, planner
baseline is unsupported, and SDK retries are disabled. Local503 recovery uses
a new caller request; it does not establish SDK retry behavior, real provider
availability, deployed consumer behavior, persistence or SQL idempotency.

Approved-source full CI remains PASS: CI/CD38267906072 and PR CI38267906079
each passed899suites/17,640tests,13suites/167tests skipped, zero failures.
These totals overlap all prior local application checks and are not summed.
Type-check, lint, build, security and disposable storage/queue checks passed
in that source CI; no local application checks were manually rerun for this
documentation diff. The original606local/897suites/17,532tests baseline is
historical; approved-source CI adds108passing tests/two suites with unchanged
skips. Coverage remains93.52% statements/lines,87.33% branches,95.79% functions.

Authenticated refresh now shows inspection-head CI/CD38282087675,
PR CI38282087682, Documentation Audit38282087689 and API Endpoint Tests38282087716
all completed SUCCESS. Those terminal metadata results do not newly prove
test totals or live deployment. Current documentation validation/final head
will be recorded in the delivery receipt. No fullCI workflow was manually
dispatched; no production test or paid external API ran.

The fourteen genuine staging scenarios are BLOCKED / execution NOT_RUN.
Cleanup and owner intervention are in the [current evidence](self-healing-preview-evidence.md);
all earlier validation below is retained with its historical environment scope.

## Revised authorization / cleanup preflight validation — 2026-10-12

Approved executable remains `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
Inspected head `450ab65d9955d7627f75fdb3a34fe1773faa23dc` differs only in five
audit Markdown files. No source, dependency, build or runtime correction was
made. The owner changed $10 from a hard ceiling to an operational target and
authorized the existing workspace; the financial blocker is superseded.

New read-only checks reconfirmed PR identity, documentation-only diff, workspace/
project inventory, credential readiness and supported CLI deletion/authentication
commands. CLI login was actually attempted, its activation link was relayed
promptly, and it expired without completion (exit 1). No resource, fault,
disposable deletion rehearsal, independent fallback or watchdog execution
occurred. No new runtime failure or regression fixture is claimed.

Both previously pending documentation-head full runs are now SUCCESS:
[CI/CD 38276098065](https://github.com/pbjustin/Arcanos/actions/runs/38276098065)
and [PR CI 38276098340](https://github.com/pbjustin/Arcanos/actions/runs/38276098340)
at `450ab65d9955d7627f75fdb3a34fe1773faa23dc`. This update verifies their terminal
metadata, without claiming newly parsed test totals. Approved-source full
counts below remain tied to `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
Neither result establishes genuine staging acceptance.

Only documentation is updated for this blocked attempt. Pinned-toolchain
documentation/link/whitespace/staged-guard outcomes and the final evidence
commit are recorded in the PR delivery receipt. No application startup or
behavioral test rerun is necessary for this documentation-only update.


## Dedicated staging validation — 2026-10-12

Approved deployment source: `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67`.
No staging runtime was deployed. The hard $10 cost bound was not established,
so execution stopped before provisioning. No live failure, new runtime defect,
regression fixture or source correction occurred.

Only the five required audit files changed on the existing PR branch. Publishing
evidence does not expand deployment authorization to its later documentation
commit. The approved source remains the SHA above; a different deployed source
needs explicit owner authorization.

Existing [CI/CD 38267906072](https://github.com/pbjustin/Arcanos/actions/runs/38267906072)
and [PR CI 38267906079](https://github.com/pbjustin/Arcanos/actions/runs/38267906079)
both passed at that exact approved source: **899 suites / 17,640 passed tests**,
**13 suites / 167 skipped tests**, zero failures; coverage 93.52% statements/
lines, 87.33% branches and 95.79% functions.
[Exact-source receipt](https://github.com/pbjustin/Arcanos/actions/runs/38267906072/artifacts/11756636250)
is retained. These previously observed results are not newly executed staging
scenarios or evidence for another source SHA.

New read-only checks: authenticated PR/head/base metadata; Railway workspace/
project/service identities; credential readiness; official pricing/cost-control/
volume-deletion docs; CLI `whoami --json` (exit 1, Unauthorized). No provider,
database, worker or controller was started as incidental verification.

Documentation checks use Node `24.18.1` / npm `11.16.0`:

```bash
npm run docs:check
npm run docs:links -- --local-only
git diff --check
npm run guard:commit
```

Actual outcomes and the documentation commit are recorded in the authenticated
PR delivery receipt. The guard must inspect the staged five-file diff. Audit
local links require explicit supplemental review because maintained-link
checks exclude `docs/audits/`. Application type-check/lint/build and behavioral
suites are not rerun locally for documentation-only work. Approved-source CI
remains separately identified; later CI is not substituted for live acceptance.

The earlier fixture/failure/correction reports below remain historical evidence.


PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Branch: `codex/targeted-security-healing-20261012`.
Baseline inspected head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.
First local correction commit: `f6cbd320eaaf032e6d8c500bc5cb4bfd4d9705aa`.
Final tested source commit: `4178766998a598553b3a5e4c6804ee9a8cacc0fc`.
Final published artifact-containing head: see authenticated PR delivery receipt.

## Authorized profile preparation

Preparation started at `4b365ce4271a4c13b39b37da3cbad9485b979581` after
owner authorization. No existing runtime, sealed launcher, provisioning
workflow or security control changed. New
`scripts/railway-self-healing-preview-profile.mjs` exports pure plan,
ownership-receipt and explicit-observation validation functions. New
`tests/railway-self-healing-preview-profile.test.js` provides 73 deterministic
local contract cases. These are new prerequisites, not repairs to a faulty
provisioning workflow or actual Railway operations.

The contract rejects wrong/fork/draft/closed PRs, stale inventory, production
or preexisting IDs, shared global service membership, cloned/shared resources,
incorrect private storage, absent credential provenance, partial observations,
role/source/deployment mismatches and serialized receipt drift. Its successful
result explicitly states `supportedRuntime: mock-baseline-only`,
`selfHealingRuntimeAcceptanceSupported: false`,
`authenticatedRuntimeExecutionVerified: false`,
`deploymentExecutionPerformed: false`, `storageAuthenticationVerified: false`,
`storageDurabilityVerified: false`, and `liveRuntimeAcceptance: NOT_RUN`.

Independent review caught two defects in the new, uncommitted contract. Two
PostgreSQL regressions failed before correcting the official version-18 image
mount from `/var/lib/postgresql/data` to `/var/lib/postgresql`. Two Redis
regressions failed before requiring an explicit AUTH startup command rather
than treating a `REDIS_PASSWORD` variable as server authentication. Both
failing-before runs and passing receipts are retained. Their 69/71 filtered
exclusions were deliberate case selection, not acceptance-suite skips. No
database was provisioned and no actual persistence/AUTH probe is claimed.

Focused command on pinned Node `24.18.1` / npm `11.16.0`:

```bash
node scripts/run-jest.mjs --runTestsByPath \
  tests/railway-self-healing-preview-profile.test.js \
  --coverage=false --runInBand --json \
  --outputFile=/tmp/self-healing-preview-profile-tests.json
```

Result: **one suite, 73 passed, zero failed/skipped**. `node --check` for the
new module, scoped test ESLint, documentation/index checks, 19 audit-package
relative links and `git diff --check` passed. Raw local log/JSON hashes are
retained in the sanitized evidence JSON. Fixture observations are synthetic;
no provider, storage, controller or consumer ran in a preview.

The mutation executor, platform observation collector, runtime supervisor and
trusted installation are not implemented by this planning module. CLI
authentication returned Unauthorized. The owner chose a protected trusted
workflow instead of supplying a token here; its safe installation and execution
remain external prerequisites.
No deployment or live acceptance was attempted. A new commit invalidates prior
head-specific receipts; final published-head CI is reported separately on the
PR and must not reuse the prior head's results.

The owner-run read-only preflight adds
`.github/workflows/railway-self-healing-preview-preflight.yml`,
`scripts/railway-self-healing-preview-preflight.mjs` and 35 local fixture cases
in `tests/railway-self-healing-preview-preflight.test.js`. They cover owner/main
provenance, clean controller identity, exact head/base/branch refresh, bounded
complete metadata pagination, absence of mutation capabilities, secret-error
redaction and exclusive 0600 artifact writes. Independent source review caught
missing-base acceptance and unconditional artifact upload before publication;
both now have regressions. No executed pre-fix failure is claimed for those
two review findings.

Combined new and existing compatibility command:

```bash
node scripts/run-jest.mjs --runTestsByPath \
  tests/railway-self-healing-preview-profile.test.js \
  tests/railway-self-healing-preview-preflight.test.js \
  tests/railway-pr-preview-lifecycle.test.js \
  tests/worker-diagnostics-preview-cleanup-workflow.test.js \
  --coverage=false --runInBand --json \
  --outputFile=/tmp/selfheal-owner-preflight-contract-tests.json
```

Result: **four suites, 180 passed, zero failed/skipped**. The 108 new cases are
73 profile plus 35 preflight; the remaining 72 overlap earlier contract and
full-CI evidence. Do not add overlapping runs into a new unique total. Full
`npm run lint` passed with zero errors and the same 77 existing warnings;
post-review scoped lint/syntax passed. `npm run docs:check` and
`npm run docs:links -- --local-only` passed (716 local targets; 109 external
network checks skipped). Separate audit-package checks passed 19 targets.
Both modules/workflow received independent review with no remaining blocker
within their declared read-only/mock-contract scope. No actual owner workflow
run or credentialed Railway query occurred.

## Preview recovery follow-up

Recovery source/head lock: `2fd4cf81833ba3be4592654bc7789dd3309374d7`.
No provisioning source, workflow, configuration or dependency change was made.
The later CI follow-up below changes one existing test's bounded time budget;
it adds no fixture or test case and changes no runtime behavior.
The missing preview was a correct `not-opted-in` no-op. Current provisioning
cannot meet the new mission because it requires production-shared service IDs
and a sealed/passive two-service runtime. No source-level provisioning defect
was reproduced; no security control was weakened or alternate environment made.

The resumed executor's default Node/npm differed from the repository pins.
Node `24.18.1` / npm `11.16.0` were restored from the checksum-verified official
archive before testing; installed locked `proxy-addr` remains `2.0.8`. The exact
new command was:

```bash
PATH=/tmp/arcanos-preview-recovery-toolchain/node-v24.18.1-linux-x64/bin:$PATH \
  node scripts/run-jest.mjs --runTestsByPath \
  tests/railway-pr-preview-lifecycle.test.js \
  tests/worker-diagnostics-preview-cleanup-workflow.test.js \
  --coverage=false --runInBand --json \
  --outputFile=/tmp/selfheal-recovery-contract-tests.json
```

Result: **two suites, 72 passed, zero failed/skipped**. These reuse existing
mocked adapters and synthetic cleanup fetches: admission, exact ownership,
deployment attestation, trusted workflow and cleanup contracts only. They are
not new fixtures and do not prove Railway provisioning or live recovery.

The previous head's full CI is preserved as exact-source regression evidence:
[CI/CD 38208119556](https://github.com/pbjustin/Arcanos/actions/runs/38208119556)
and [PR CI 38208119535](https://github.com/pbjustin/Arcanos/actions/runs/38208119535)
passed **897 suites / 17,532 tests**, with 13 suites / 167 cases skipped and zero
failures. Local acceptance remains the previous **606 passed, zero skipped**;
the 72 contract checks overlap that full CI and are not added to a grand total.
The CI source contained all four earlier repairs and 45 added test cases.

New artifact-only changes receive documentation, relative-link, JSON,
whitespace and staged-guard validation. The contract run had no failures;
a subsequent full CI test-budget failure is captured below. A fresh
normal-runtime self-healing live
suite remains BLOCKED. Type-check/lint/build/full behavioral reruns were not
invented for this documentation-only recovery update. The final PR receipt
records any automatically triggered final-head CI separately.

Recovery documentation validation on the pinned toolchain passed:
`npm run docs:check`, `npm run docs:links -- --local-only` (714 maintained local
targets passed, 109 external network checks skipped), separate new-package
relative links (12 passed), JSON parse/18-gate consistency and `git diff --check`.
The maintained link checker excludes audit directories, so its result was not
substituted for the separate package check. The staged `npm run guard:commit`
also passed before the recovery evidence commit.

### CI follow-up: structured-evidence success budget

The recovery evidence head `c32c31ad7f7d04e0c850fdac27af9cee18a43188`
passed all 13 jobs in
[CI/CD 38251503704](https://github.com/pbjustin/Arcanos/actions/runs/38251503704),
but [PR CI 38251503639](https://github.com/pbjustin/Arcanos/actions/runs/38251503639)
failed exactly one existing test:
`tests/gaming-structured-evidence-preview-failure.test.ts:25`,
`runs actual structural component assertions before preserving the trusted response`.
The failure was `Exceeded timeout of 5000 ms for a test`, with 17,531 passed,
one failed and 167 skipped cases. The identical suite passed in simultaneous
CI/CD (6.067 seconds suite duration), which passed all 17,532 cases with 167
skips. This was a test-budget failure under covered CI, not a Railway recovery
or production behavior failure.

Local covered reproduction before the correction passed all 32 selected cases;
the affected success itself took **4.697 seconds**, close to its five-second
budget. No deterministic local failure or artificial delayed fixture is claimed.
The authentic CI failure is the failing-before evidence. The existing test is
the regression fixture; no new implementation-mirroring timeout test was added.

Commit `6f58e16af9a0e202d7415942a2a7d8870db131dc` applies the already-used
bounded `30_000` ms budget to that success case only. Every status, invocation,
proof-header and response-body assertion remains unchanged. Failure and
build/meta cases retain their existing budgets. No global Jest timeout,
workflow coverage threshold, security check or runtime timeout was changed.

Before and after commands used the pinned toolchain:

```bash
node scripts/run-jest.mjs --runTestsByPath \
  tests/gaming-structured-evidence-preview-failure.test.ts \
  tests/gaming-hybrid-preview-failure.test.ts \
  tests/gaming-guide-assistance-preview-failure.test.ts \
  tests/gaming-source-acquisition-preview-failure.test.ts \
  --coverage --coverageThreshold='{}' \
  --coverageDirectory=/tmp/selfheal-recovery-structured-coverage-after \
  --maxWorkers=2 --workerIdleMemoryLimit=768MB --json \
  --outputFile=/tmp/selfheal-recovery-structured-budget-after.json
```

The before command used `-before` instead of `-after` in both output paths.
Partial-run aggregate coverage thresholds are disabled only for this selected
scope; instrumentation remains enabled and full-CI thresholds remain intact.
Both local runs: **four suites, 32 passed, zero failed/skipped**. Scoped ESLint,
whitespace and staged guard passed. Test count remains unchanged.

C32 CI/CD coverage was statements/lines 93.52%, functions 95.79%, branches
87.33% (7,194/8,237). Statements/lines/functions match the 2fd baseline;
branches are one covered branch below its CI/CD 87.34% and match its PR CI
87.33%. Full thresholds passed; this is not a material coverage regression.
Failure excerpts, raw-log hashes and local receipts are retained in JSON.
The final published head's CI receipts are recorded on the PR after the
test-only correction and artifact refresh; C32's failed PR CI is never
represented as an all-green result.

## Captured failures and smallest corrections

| Defect | Failing behavior captured before correction | Correction and regression |
| --- | --- | --- |
| Dispatched reactive exceptions bypass cooldown/budget | Four local tests failed: stale-job, provider and local-worker throwing actuators could retry immediately; degraded cooldown override could exceed the incident ceiling. | Record each actually dispatched attempt once on success or exception. Internal worker `onDispatch` fires only after approval/role/credential/target preflight at the real effect boundary. Denials remain non-dispatches. Twelve total added coordinator regressions include this and the verification fixes. |
| Railway worker target fallback could select the wrong environment | Eleven local failures in target tests; an absent preview name selected synthetic `environment-production` / `worker-production`. No real deployment call occurred. | Require an explicit project and environment ID or exact name; reject unmatched, conflicting or ambiguous aliases/identities/services instead of broadening search. Exact ID-only/name-only valid targets remain supported. Added 22 target/role cases and six dispatch-boundary cases. |
| Empty/stale traffic falsely verified Trinity recovery | Two local tests classified zero new requests as `improved`, including healthier old rolling samples. | Defer active Trinity verification without post-action requests; compare the measured post-action window when it exists. Dependency/worker health verification remains separate. Positive improvement and existing ineffective rollback are covered. |
| Deferred verification outlived its command | Follow-up independent review of the first correction produced four failing regressions: idle TTL/early rollback blocked new repairs, vanished commands claimed later recovery, old verification rolled back a replacement of the same action. | Fence verification by original stage/action/expiry before delay/sample checks. Invalidate stale pending state with explicit noop telemetry; no recovery or rollback claim, replacement command preserved. All four now pass. |

Pre-fix transcript summaries and hashes are preserved in
[sanitized JSON](self-healing-evidence.json). Filtered pre-fix runs intentionally
excluded unrelated tests; their exclusion counts are not acceptance skips.
Worker/deploy/provider effects in these failing fixtures were mocked or denied.
Every correction is on the existing PR branch; no production configuration,
new runtime debug endpoint or permanent fault-injection surface was added.

## Fixtures and evidence improvements

- Extended the existing synthetic loopback provider with a bounded held-response
  timeout (validated 1-2000 ms), socket/timer cleanup, and distinct
  `timeoutBackstopFired` evidence. The actual SDK timeout asserts client
  cancellation before the backstop; a negative control labels backstop cleanup.
- Added healthy, transient timeout, sustained 503/circuit admission and
  cancellation-control cases to actual coordinator/SDK/Trinity integration.
  Provider request transcripts and consumer decisions establish local path
  changes rather than merely selected-action logs.
- Added a two-process restart fixture with a literal synthetic child env,
  reviewed source-module allowlist, denied fetch and empty temporary cwd.
  A fresh process invalidates active mitigation; it does not resume incidents.
- Added exact-target, approval/dispatch, thrown-effect budget, measurable
  verification, TTL/rollback/replacement ownership regressions. Existing worker
  queue/idempotency, Redis lifecycle, authorization and preview-contract suites
  were reused.

There are 45 additional test cases relative to the acceptance baseline:
coordinator 12, worker actuator 28, Trinity integration four and restart one.
Fault injection is confined to test files. No production route, config flag or
live injector was introduced.

## Exact commands and local results

All commands run in `/workspace/Arcanos` with the checked repository pins:

```bash
export PATH=/tmp/node-v24.18.1-linux-x64/bin:$PATH
node --version # v24.18.1
npm --version  # 11.16.0
```

The aggregate focused run executes these 32 explicit paths (no broad pattern
selection):

```bash
node scripts/run-jest.mjs --runTestsByPath \
  tests/self-healing-loop.test.ts \
  tests/self-healing-v2.test.ts \
  tests/self-healing-trinity.integration.test.ts \
  tests/self-healing-restart.test.js \
  tests/self-heal-control-loop-startup.test.ts \
  tests/predictive-healing-service.test.ts \
  tests/predictive-healing-execution.test.ts \
  tests/self-heal-operator-approval.test.ts \
  tests/self-heal-auth-composition.test.ts \
  tests/self-improve-auth-composition.test.ts \
  tests/self-heal-http-boundary.test.ts \
  tests/self-healing-control-rate-limit.test.ts \
  tests/openai-fallback-sequence.test.ts \
  tests/openai-structured-reasoning-preview-chaos.test.ts \
  tests/worker-task-queue.test.ts \
  tests/worker-autonomy-service.test.ts \
  tests/worker-duplication-suppression.test.ts \
  tests/worker-restart-threshold-recovery.test.ts \
  tests/job-runner-runtime.test.ts \
  tests/job-queue.test.ts \
  tests/queue-job-lifecycle.test.ts \
  tests/job-repository.requeueFailedJob.test.ts \
  tests/worker-repair-actuator.test.ts \
  tests/workers-heal-route-security.test.ts \
  tests/workers-route-security.test.ts \
  tests/worker-helper-auth.test.ts \
  tests/redis-startup-lifecycle.test.ts \
  tests/redis-operation-boundary.test.ts \
  tests/safety-v2-redis-lifecycle.test.ts \
  tests/self-heal-telemetry-redis.test.ts \
  tests/generative-model-policy-transport.e2e.test.ts \
  tests/trinity-model-policy.e2e.test.ts \
  --coverage=false --maxWorkers=2 --workerIdleMemoryLimit=768MB \
  --json --outputFile=/tmp/selfheal-acceptance-final-regression.json
```

Result: **32 suites, 546 passed, zero failed, zero skipped**. The actual
orchestrated invocation used the same validated path set from the earlier JSON
receipt; file order differs only. Per-suite counts and assertion names are
preserved in sanitized JSON. No receipt contains credentials or private data.

The same 32-suite set was rerun after committing source head
`4178766998a598553b3a5e4c6804ee9a8cacc0fc`, with an explicit `git rev-parse HEAD`
equality check, writing `/tmp/selfheal-acceptance-final-source-head.json` and its
log. It passed the same 546 tests with zero skips; JSON retains that receipt's
timestamp and log hash. The artifact-only commit has no source/test changes;
its final-head repository CI is checked independently after publication.

| Additional command | Result | Execution boundary |
| --- | --- | --- |
| `npm run test:native-pr-preview-e2e` | PASS — 42 tests, zero skips | Local/offline verifier and response contracts; not a live Railway invocation. |
| `npm run test:preview-e2e` | PASS — 18 tests, zero skips | Local/offline preview orchestration contract. |
| `node scripts/run-jest.mjs --runInBand --runTestsByPath tests/self-healing-loop.test.ts --coverage=false` | PASS — 69 tests, zero skips | Includes all coordinator corrections; overlap with aggregate, not added to total. |
| `node scripts/run-jest.mjs --runTestsByPath tests/self-healing-trinity.integration.test.ts tests/self-healing-restart.test.js tests/generative-model-policy-transport.e2e.test.ts tests/trinity-model-policy.e2e.test.ts --coverage=false --runInBand --json --outputFile=/tmp/selfheal-acceptance-transport-cancellation.json` | PASS — four suites, 48 tests, zero skips | Real SDK/consumer with guarded synthetic transport and bounded subprocesses; overlaps aggregate. |
| `npm run type-check` | PASS | Source boundaries, shared-package builds and root TypeScript. |
| `npm run lint` | PASS — zero errors, 77 existing warnings | Maintained source/test/workspace lint scope. |
| `npm run build` | PASS | Boundary, source/compiled preview import, packages/workers/backend, alias and asset checks. |
| `npm run reindex` | PASS | Required generated indexes refreshed; no exports added. |
| `npm run docs:check` | PASS | Maintained documentation and read-only index drift check. |
| `npm run docs:links -- --local-only` | PASS | Local documentation targets/anchors; no runtime calls. |
| `git diff --check` and `npm run guard:commit` | PASS | Whitespace and required staged commit guard. |

The maintained link checker excludes historical audit directories. Its result
was 714 maintained local targets passed and 109 external URL checks skipped.
A separate read-only relative-link check of this new package passed all 12
references, with zero missing targets. The package's JSON parses successfully;
its inventories retain IDs/names and sanitized deployment metadata only.

**Distinct local test total: 606 passed, zero failed, zero skipped**
(546 Jest + 42 native preview contracts + 18 preview contracts). Component reruns
are not double-counted. Static/compilation gates have no test count.

## CI and explicitly unexecuted work

At the baseline head, existing CI/CD and PR CI runs passed:
[CI/CD 38203123235](https://github.com/pbjustin/Arcanos/actions/runs/38203123235)
and [PR CI 38203123337](https://github.com/pbjustin/Arcanos/actions/runs/38203123337).
CI/CD includes disposable PostgreSQL 18 and Redis 7.4 jobs. Those results belong
to the baseline SHA and are not final-head or Railway recovery evidence.
Final published-head CI run IDs/statuses are recorded in the PR delivery
receipt after publication; no baseline result is carried forward as an
exact-head result.

The local scope intentionally did not run real SQL/Redis mutation suites without
an explicitly disposable configured target, ordinary live app/worker startup,
webhooks, provider availability probes, billable model calls or production
smoke. All fourteen genuine Railway scenarios are BLOCKED/NOT_RUN because
exact-head target/isolation was unavailable. Daemon Python and unrelated
standalone runtime changes were outside the edited scope; their repository CI
is reported separately where run. No skipped local selected test was treated
as passing.

Synthetic V2 logs use fixture clock/request IDs, for example three intake
observations followed by `self_heal.v2.action_applied`, three verification
successes followed by `action_retained`, two failures followed by `rollback`,
and `action_expired` at the fake-clock TTL. These excerpts are in JSON and
prove local event behavior only. No live Railway controller/consumer logs,
incident IDs, deployment attestations or incident-close evidence are available.

Live redeployment/retest remained prohibited by the user stop condition. Each
new PR commit invalidates previous exact-head acceptance; no passing live
acceptance was asserted for any head. See the
[final gates](self-healing-merge-readiness.md) for the BLOCKED verdict.
