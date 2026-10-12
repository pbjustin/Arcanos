# Self-healing regression report

PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Branch: `codex/targeted-security-healing-20261012`.
Baseline inspected head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.
First local correction commit: `f6cbd320eaaf032e6d8c500bc5cb4bfd4d9705aa`.
Final tested source commit: `4178766998a598553b3a5e4c6804ee9a8cacc0fc`.
Final published artifact-containing head: see authenticated PR delivery receipt.

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
