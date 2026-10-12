# Self-healing regression report

PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Branch: `codex/targeted-security-healing-20261012`.
Baseline inspected head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.
First local correction commit: `f6cbd320eaaf032e6d8c500bc5cb4bfd4d9705aa`.
Final tested source commit: `4178766998a598553b3a5e4c6804ee9a8cacc0fc`.
Final published artifact-containing head: see authenticated PR delivery receipt.

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
