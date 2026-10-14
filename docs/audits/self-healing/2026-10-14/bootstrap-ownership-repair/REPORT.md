# Self-healing Worker bootstrap and ownership repair

Date: 2026-10-14. Repository: `pbjustin/Arcanos`.

The original bootstrap audit and failure receipts below are retained as historical
evidence. The [final review](#final-review-and-blocker-repair) records the later
review, repairs and current readiness decision.

- Audited source/base: `7aee3bb9ace55e1fc19f1e83d0b6dfeca169c383`.
- Safety reference: merged PR #1539, final synthetic-verification head
  `031cf38acea5f022a867bf3e0899fc3584a80c21`.
- Tested repair source: `489aa313f48c8bbb6e70f00d7b74958e2d5aec8c`, including
  the final controller-cancellation repair. The subsequent documentation commit
  and exact PR head are recorded in the draft PR; its executable source and
  tests match this commit.
- Scope: source repair and local/synthetic verification. Live acceptance is
  **NOT_RUN**; production promotion is **NOT_AUTHORIZED**.

## Confirmed findings and repairs

1. The normal integrity wrapper invokes `scripts/start-railway-service.mjs`.
   Its explicit web role starts `dist/start-server.js`; its worker role starts
   `dist/workers/jobRunner.js`. The server called the canonical coordinator,
   while explicit web-role policy suppressed it. The dedicated Worker's guarded
   entry point started consumers without that coordinator. This left the split
   production topology without the intended scheduler. `app.ts` did not supply
   a hidden alternative; `controlLoop` is retired and V2 has no second timer.
2. `runJobWorker()` now starts the existing canonical scheduler after database,
   autonomy, module registry and all-consumer dispatcher readiness, before the
   ready sentinel. An installation failure rejects bootstrap. The production
   entry guard still invokes this same body and handles failure with process
   exit. No independent healing controller was introduced.
3. Worker startup now initializes the existing Redis lifecycle and primes
   existing self-heal telemetry. An unstarted lifecycle previously could not
   expose configured shared-store failure to the kill switch. A configured
   unavailable store now restricts healing to frozen/autonomy 0 without adding
   a Redis dependency to queue readiness.
4. Coordinator initialization is idempotent; interval work and manual ticks
   share the in-flight fence. Shutdown clears the timer, propagates cancellation
   and drains the scheduled evaluation before stopping telemetry/Redis. Existing
   queue claims, heartbeat, lease recovery and all-slot readiness remain in
   their owning lifecycle. Tick failure is reported and can recover without
   poisoning job processing.
5. Canonical reactive and predictive effects now enforce enabled daemon mode,
   configured and effective autonomy at least 3, and both freeze controls false.
   Predictive execution also requires enabled prediction and server dry-run off;
   automatic execution requires its additional flag. Authorization is checked
   after asynchronous diagnosis. Production Trinity failure and prompt-timeout
   consumers consult effective shared safety controls before automatic activation.
   Malformed dry-run values now retain the safe default instead of granting
   execution. Flag and alias precedence has deterministic coverage.
6. Prompt-route state cannot reach a web consumer from the dedicated Worker.
   That action now returns `cross_process_prompt_route_unavailable`. The
   EventEmitter listener repair/scale/recycle controls do not own `jobRunner`
   and are unavailable there. Local provider and Trinity effects remain usable
   only for same-process consumers; stale-job recovery retains shared database
   ownership fences. No cross-service success is fabricated.
7. Structured lifecycle events and authenticated inspection distinguish actual
   scheduling and observation from configured intention. A tick timestamp alone
   is no longer proof of a successful observation. Current-process inspection
   cannot attest to a remote coordinator and reports that state as `UNKNOWN`.
8. A refused or throwing repair cannot fall through to a different controller
   effect in the same tick. Existing bounded escalation remains possible on a
   later tick after a recorded dispatch, without duplicate dispatch.
9. Final read-only review found that scheduled fallback `runSelfImproveCycle`
   did not receive cancellation, so an awaited operation could settle after
   shutdown and allow a later freeze, reflection, provider, PR or evidence effect.
   The canonical loop now forwards an optional signal. Controller entry and
   post-await checks prevent subsequent effects, and its catch rethrows
   cancellation before further evidence writing. Already-dispatched dependency
   I/O still drains cooperatively; this does not claim force cancellation inside
   third-party operations. Six deterministic cases extend the existing
   controller-decision suite; focused verification passes 4 suites / 128 tests.

Source owners: `src/workers/jobRunner.ts`, `src/server.ts`,
`src/services/selfImprove/selfHealingLoop.ts`,
`src/services/selfImprove/controller.ts`,
`src/services/selfImprove/predictiveHealingService.ts`,
`src/services/selfImprove/selfHealingV2.ts`,
`src/services/openai/promptRouteMitigation.ts`,
`src/services/selfImprove/workerRepairActuator.ts`,
`src/services/selfHealRuntimeInspectionService.ts`, `src/routes/safety.ts`,
`src/core/logic/trinity.ts`, `src/transport/http/controllers/openaiController.ts`
and `src/platform/runtime/unifiedConfig.ts`.

## Production inventory and unknown running state

The source establishes the missing Worker bootstrap call; it does not prove
which historical production incidents resulted from it. A fresh read-only
Railway connector inspection verified the Arcanos project, production environment,
`ARCANOS Worker` service and repository source. Direct service configuration and
fully rendered variable-name inventory agree: three requested names are present,
the other six are absent, and none of the requested flags is supplied by the
environment's shared variables. The service configuration reports one Worker
replica and no staged changes. OAuth reports `valuesRedacted=true`, so the three
present values are withheld and remain **UNKNOWN** here.

| Requested setting | Current Railway inventory / provenance | Actual value | Source fallback if absent |
| --- | --- | --- | --- |
| `ARCANOS_PROCESS_KIND` | Present in direct and rendered service inventory | Withheld / UNKNOWN | No launcher default; explicit role required |
| `RUN_WORKERS` | Present in direct and rendered service inventory | Withheld / UNKNOWN | `true` outside tests, `false` in tests; explicit role overrides it |
| `SELF_IMPROVE_ENABLED` | Absent from rendered and shared inventory | No configured entry | `false` |
| `SELF_IMPROVE_ACTUATOR_MODE` | Present in direct and rendered service inventory | Withheld / UNKNOWN | `pr_bot` |
| `SELF_IMPROVE_AUTONOMY_LEVEL` | Absent from rendered and shared inventory | No configured entry | `0` |
| `SELF_IMPROVE_FREEZE` | Absent from rendered and shared inventory | No configured entry | `false` |
| `PREDICTIVE_HEALING_ENABLED` | Absent from rendered and shared inventory | No configured entry | `false` |
| `PREDICTIVE_HEALING_DRY_RUN` | Absent from rendered and shared inventory | No configured entry | `true` |
| `PREDICTIVE_AUTO_EXECUTE` | Absent from rendered and shared inventory | No configured entry | `false` |

The inspected names `RAILWAY_PREDICTIVE_HEALING_ENABLED`,
`RAILWAY_PREDICTIVE_HEALING_DRY_RUN`, `PREDICTIVE_DRY_RUN`,
`RAILWAY_PREDICTIVE_AUTO_EXECUTE`, `AUTO_EXECUTE_HEALING`,
`RAILWAY_AUTO_EXECUTE_HEALING` and `RAILWAY_PREDICTIVE_DRY_RUN` are also absent.
Thus the six missing settings are absent in the rendered Railway inventory,
rather than inherited from its shared variables. The source fallback column is
separate evidence: no process execution, logs or probes were used to verify the
currently running revision's effective configuration or shared runtime overrides.
Those values and actual coordinator state remain **UNKNOWN**. No Railway
configuration was mutated. Before PR publication, a read-only Railway API query
also confirmed `prDeploys=false` for both accessible projects, `Arcanos` and
`Arcanos Live PR 1527`; no provider-native PR environment is enabled there.

## Ownership and configuration

```mermaid
flowchart LR
  subgraph Before
    BW[Web startup] --> BN[Coordinator suppressed by role]
    BJ[Worker entry] --> BQ[Consumers without coordinator]
  end
  subgraph After
    AW[Web startup] --> AN[Coordinator suppressed by role]
    AJ[Worker entry] --> AB[Dependencies and all slots ready]
    AB --> AC[One canonical coordinator]
    AC --> AR[Ready sentinel]
    AC --> AE[Authorized same-process effects]
    AC --> AX[Unsupported cross-process effects blocked]
  end
```

The maintained [configuration matrix](../../../../CONFIGURATION.md#self-healing-coordinator-and-execution-policy)
documents all nine requested settings, defaults, aliases and policy for
observation, diagnosis, recommendations, local mitigation, predictive execution
and privileged repair. Missing self-improvement flags remain disabled, `pr_bot`,
autonomy 0; predictive defaults remain disabled, dry-run true and auto-execute
false. The freeze default alone never grants execution. Role determines
`RUN_WORKERS`, and inherited environment takes precedence over local `.env`.

The [action-to-process matrix](../../../../PREDICTIVE_SELF_HEALING.md#action-and-process-ownership)
documents detection, target/state owner, authorization, delivery, recovery and
expiry for provider, Trinity, prompt, stale-job, listener, remote and unsupported
traffic-shift actions. The existing exact-target worker-helper/privileged
approval boundary remains intact; it is not a cross-process prompt transport or
a dedicated Worker restart API.

PR #1539 guarantees retained: dispatch attempt/cooldown accounting, rejected
preflight accounting, mitigation identity fences, bounded failed-consumer
accounting, TTLs, route-attributed fresh post-action observations, matching
consumer/provider receipts, stale-evidence rejection and replacement-safe
rollback. A reload receipt, HTTP health, cached reply or unrelated route does
not prove recovery.

## Synthetic scenario inventory

The entries below identify real production bodies versus component fixtures.
External providers and production database/network boundaries are substituted.
Clocks are mostly injected; local SDK/transport integration uses some real timing
against synthetic endpoints. None establishes live acceptance.

| # | Required scenario | Deterministic coverage and boundary |
| --- | --- | --- |
| 1 | Web suppresses canonical loop | `server-startup-resilience.test.ts` invokes actual `startServer`; lifecycle integration also checks role suppression. |
| 2 | Worker starts canonical loop | `self-healing-worker-bootstrap.integration.test.ts` invokes exported `runJobWorker`, the same body used by the guarded production entry point. |
| 3 | One coordinator per Worker startup | Worker-bootstrap fixture executes actual all-consumer readiness and observes one canonical scheduler. |
| 4 | Repeated initialization idempotent | `self-healing-coordinator-lifecycle.integration.test.ts` repeats real scheduler initialization after the actual readiness barrier. |
| 5 | Shutdown stops evaluations | Worker-bootstrap fixture invokes installed SIGTERM callback; lifecycle fixture aborts/drains in-flight observation and advances fake time. Existing controller-decision tests cover pre-abort, cancellation during autonomy/freeze reads, reflection completion, and provider resolve/reject, preventing later PR/evidence effects. |
| 6 | Startup failure without false readiness | Both bootstrap/lifecycle suites reject timer-installation failure before the production ready sentinel. |
| 7 | Disabled flags cannot act | `unified-config.predictive-flags.test.ts`, `self-healing-loop.test.ts` and predictive-execution fixtures cover defaults and disabled execution. |
| 8 | Frozen/low autonomy cannot act | Reactive/predictive fixtures plus actual Trinity and prompt consumers test configured and effective restrictions; Worker bootstrap proves configured degraded Redis freezes effects while claims continue. |
| 9 | Predictive dry-run cannot mutate | `predictive-healing-execution.test.ts` rejects caller override; config fixtures preserve malformed/absent dry-run safety. |
| 10 | Unauthorized remote repair rejected | `worker-repair-actuator.test.ts` asserts absent approval prevents fetch; existing self-heal security fixtures preserve authenticated execution scopes. |
| 11 | Local effect reaches actual consumer | `prompt-route-mitigation.test.ts` exercises authorized same-process prompt policy; `self-healing-trinity.integration.test.ts` runs actual controller activation and consumers. |
| 12 | Cross-process false success rejected | Predictive, synthetic-controller, prompt and worker-actuator suites reject dedicated Worker prompt/listener actions. |
| 13 | Provider outage bounded | Synthetic-controller cooldown/attempt/escalation cases and real Trinity consumer over mocked transport bound sustained failures. |
| 14 | Worker retry and ownership fencing | `self-healing-worker-synthetic.integration.test.ts` runs actual consumer code with deterministic shared-ledger adapter: bounded retry, stale completion, lost first heartbeat and unavailable claim admission. |
| 15 | Recovery requires fresh evidence | Trinity integration requires actual matching consumer/provider receipts plus fresh route traffic; synthetic-controller fixtures enforce thresholds. |
| 16 | Stale evidence rejected | Synthetic-controller rejects pre-command same-clock, missing, unrelated, health-only and diagnostic-only samples. |
| 17 | Mitigation expires | `self-healing-v2.test.ts`, prompt mitigation and Trinity integration advance clocks through existing TTLs. |
| 18 | Replacement rollback safe | Prompt, V2, synthetic-controller and Trinity integration reject old outcomes/rollback after newer command installation. |
| 19 | Concurrent ticks serialized | Synthetic-controller and lifecycle integration hold an evaluation pending and reject overlapping ticks/restart while draining. |
| 20 | Controller failure/recovery preserves queue | Actual `runJobWorker` completes one fenced partition job while its coordinator is FAILED, then the coordinator recovers without a duplicate job effect. Worker-bootstrap/worker-synthetic verification passes 2 suites / 7 tests; lifecycle coverage also reports FAILED then RUNNING. |

Entry-path limits: the Worker fixture calls the real guarded entry body rather
than spawning the literal compiled integrity wrapper/launcher chain. It invokes
the installed signal callback rather than delivering an OS signal. Database,
autonomy persistence, Notion, transports and Redis networking are substituted;
it does not prove PostgreSQL locking, Redis connectivity, OS termination or
Railway orchestration. The existing local launcher/preview suites provide
separate contract coverage, not live Worker recovery. No generic live-verifier
infrastructure was added.

## Commands and results

Toolchain: Node `24.18.1`, npm `11.16.0`; Python `3.11.7`. Commands ran at the
repository root unless noted. Results below are local evidence, and overlapping
focused runs must not be summed into a unique test count. Final head-wide checks
must be refreshed after all edits; pending rows are not passes. The full root
command below ran with `CI=true`, `DISABLE_EXTERNAL_CALLS=true` and
`FORCE_MOCK=true`.
The historical 23-suite and first two full-root runs precede the final
controller-cancellation repair. The final combined focused run covers that repair.

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 897 packages added. Existing audit summary: 52 vulnerabilities (4 moderate, 47 high, 1 critical); no dependency remediation in this repair. |
| `npm run type-check` | PASS after final controller-cancellation repair. |
| `npm run build` | PASS after final controller-cancellation repair. |
| `npm run lint` | PASS after final controller-cancellation repair, 0 errors / 77 warnings. |
| `npm run validate:railway` | PASS local static validation; no deployment. |
| `node scripts/run-jest.mjs --runTestsByPath tests/unified-config.predictive-flags.test.ts --coverage=false --runInBand` | PASS 1 suite / 28 tests. |
| `node scripts/run-jest.mjs --runTestsByPath tests/self-healing-worker-bootstrap.integration.test.ts tests/self-healing-coordinator-lifecycle.integration.test.ts --coverage=false` | PASS 2 suites / 10 tests after Redis integration. |
| Previous command plus `tests/server-startup-resilience.test.ts tests/job-runner-runtime.test.ts tests/self-healing-worker-synthetic.integration.test.ts` | PASS 5 suites / 70 tests in combined lifecycle regression run. |
| `node scripts/run-jest.mjs --runTestsByPath tests/prompt-route-mitigation.test.ts tests/worker-repair-actuator.test.ts tests/predictive-healing-execution.test.ts tests/predictive-healing-service.test.ts tests/self-healing-v2.test.ts tests/openai-prompt.test.ts tests/self-healing-synthetic-controller.integration.test.ts tests/self-healing-trinity.integration.test.ts tests/trinity-cancellation.test.ts --coverage=false --runInBand --silent` | PASS 9 suites / 177 tests, 6.458 s. |
| `node scripts/run-jest.mjs --runTestsByPath <first 22 exact test files listed below> --coverage=false --runInBand --json --outputFile=C:/Users/pbjus/.codex/tmp/self-heal-focused-final.json` | PASS 22 suites / 385 tests, 0 failures; earlier combined evidence retained. |
| `node scripts/run-jest.mjs --runTestsByPath <all 23 exact test files listed below> --coverage=false --runInBand --json --outputFile=C:/Users/pbjus/.codex/tmp/self-heal-focused-head.json` | PASS 23 suites / 387 tests, 0 failures, 21.973 s; includes the corrected restart fixture. |
| `node scripts/run-jest.mjs --runTestsByPath tests/self-improve-controller-decisions.test.ts tests/self-healing-loop.test.ts tests/self-healing-synthetic-controller.integration.test.ts tests/self-healing-coordinator-lifecycle.integration.test.ts --coverage=false --runInBand --silent` | PASS 4 suites / 128 tests, 6.362 s after controller-cancellation repair; `self-heal-controller-cancellation-focused.log`. |
| Final focused command below | PASS 24 suites / 404 tests, 0 failures, 22.923 s after all source and test edits; `self-heal-focused-cancellation.json`. |
| Focused Worker-bootstrap and worker-synthetic suites | PASS 2 suites / 7 tests after strengthening the failed-coordinator queue-completion assertion. |
| `npm test -- --maxWorkers=6 --workerIdleMemoryLimit=768MB --json --outputFile=C:/Users/pbjus/.codex/tmp/self-heal-full-test-final.json` | FAIL: 915 passed / 13 skipped / 2 failed suites; 18,092 passed / 165 skipped / 6 failed tests, 18,263 total, 362.306 s. Four unchanged Windows receipt/symlink failures and two Windows ESM restart-fixture failures; original evidence retained below. |
| `npm test -- --maxWorkers=6 --workerIdleMemoryLimit=768MB --json --outputFile=C:/Users/pbjus/.codex/tmp/self-heal-full-test-head.json` | FAIL after restart fixture repair: 916 passed / 13 skipped / 1 failed suites; 18,094 passed / 165 skipped / 4 failed tests, 18,263 total, 388.065 s. Only the unchanged Windows receipt/symlink failures remain. This run precedes the final controller-cancellation repair. |
| `npm test -- --maxWorkers=6 --workerIdleMemoryLimit=768MB --json --outputFile=C:/Users/pbjus/.codex/tmp/self-heal-full-test-cancellation.json` | Final source FAIL: 916 passed / 13 skipped / 1 failed suites; 18,100 passed / 165 skipped / 4 failed tests, 18,269 total, 382.259 s. Only the four unchanged Windows receipt/symlink failures remain; all healing and cancellation tests pass. |
| `npm run test:runtime-integration` | PASS 79 tests / 7 suites. |
| `npm run test:preview-e2e` | PASS 18 tests. |
| `npm run test:native-pr-preview-e2e` | PASS 42 tests. |
| `npm run test:live-pr-preview:offline` | PASS 16 tests; no hosted preview invoked. |
| `npm run test:model-policy:app:e2e` | PASS 4 tests against the compiled local application. |
| `npm run test:heartbeat:app:e2e` | PASS 6 tests against the compiled local application. |
| `npm run test:live-validation:offline` | FAIL 86 passed / 15 failed of 101: Windows symlink, POSIX spawn, CRLF regex, Git null-device and mode-bit assumptions; retained platform blockers. |
| `npm run test:stacked-draft-preview` | FAIL 115 passed / 20 failed of 135: Windows symlink/POSIX-shell/umask/npm-spawn assumptions; retained, not suppressed. See safety note below. |
| `python daemon-python/validate_backend_cli_offline.py` | PASS. |
| `python -m pytest daemon-python/tests/ -q --cov=daemon-python/arcanos --cov-report=xml:C:/Users/pbjus/.codex/tmp/self-heal-python-coverage.xml` | PASS 965 / 18 existing skips, 25.61 s with nonhidden task temp. |
| `npm run validate:backend-cli:contract` | PASS. |
| `npm run reindex` and `npm run reindex:check` | PASS; coupled inventories regenerated, 2,045 TypeScript / 271 Python files. |
| Staged `npm run guard:commit` and `git diff --check` | PASS for source commit; commit-hook `sync:check` reports 0 errors / 0 warnings / 5 informational entries. |
| `npm run docs:check` | PASS 1,064 checks, 0 failures / warnings; generated indexes current. |
| `npm run docs:links -- --local-only` | PASS 728 local targets, 0 failures across 153 maintained Markdown files; external network checks skipped. |
| `git diff --check` | PASS after documentation updates. |

Final focused command (PowerShell line continuations); the earlier 23-suite run
excluded the controller-decisions file, and the 22-suite run also excluded restart:

```powershell
node scripts/run-jest.mjs --runTestsByPath `
  tests/self-healing-security-synthetic.integration.test.ts tests/self-heal.runtime.route.test.ts `
  tests/self-heal-control-loop-startup.test.ts tests/self-heal-auth-composition.test.ts `
  tests/server-startup-resilience.test.ts tests/self-healing-loop.test.ts `
  tests/self-healing-trinity.integration.test.ts tests/openai-prompt.test.ts `
  tests/self-healing-worker-synthetic.integration.test.ts tests/job-runner-runtime.test.ts `
  tests/safety-self-heal.route.test.ts tests/self-healing-worker-bootstrap.integration.test.ts `
  tests/trinity-cancellation.test.ts tests/unified-config.predictive-flags.test.ts `
  tests/safety-self-heal-status.test.ts tests/predictive-healing-service.test.ts `
  tests/predictive-healing-execution.test.ts tests/self-healing-v2.test.ts `
  tests/self-healing-synthetic-controller.integration.test.ts tests/worker-repair-actuator.test.ts `
  tests/self-healing-coordinator-lifecycle.integration.test.ts tests/prompt-route-mitigation.test.ts `
  tests/self-healing-restart.test.js tests/self-improve-controller-decisions.test.ts `
  --coverage=false --runInBand --json `
  --outputFile=C:/Users/pbjus/.codex/tmp/self-heal-focused-cancellation.json
```

Retained failure evidence (local `self-heal-*.log` files, not secret-bearing logs
committed to the repository):

The controller-cancellation gap was a final code-review finding, not an observed
test failure or live incident. The new regression cases pass; earlier green runs
did not exercise this missing propagation boundary.

- Initial parent focused run failed 5/85: four exposed same-tick fallback after
  refused/throwing repair once fixtures had explicit authorization; one expected
  healthy inspection without observation. Production fixes preserve the original
  safety assertions and subsequent focused checks pass.
- Lifecycle fixture initially had a duplicate declaration (zero tests), then
  eight setup/fake-clock failures: environment had been set after diagnostics
  import and faked `setImmediate` stalled two readiness cases. Corrected fixture
  order and real `setImmediate` produced 8/8; actual Worker-body cases passed
  2/2 initially and after Redis initialization.
- Mitigation tests initially failed 7/104 because previously authorized success
  fixtures omitted the newly required flags. Intermediate 1/138 reason mismatch
  and 1/138 escalation failures were resolved. A later 12/177 fixture run used a
  5,000 ms synthetic hold beyond the existing 2,000 ms maximum, cascading through
  the breaker, and omitted cancellation-fixture autonomy. Bounded fixture values
  and explicit synthetic authorization restored 177/177 without deleting tests.
- Initial full root run was interrupted while fixtures were still changing;
  preserved output includes Trinity/cancellation failures. It is not a completed
  flaky-pass claim. The completed full run is reported separately above. Four
  failures occur in unchanged
  `railway-production-readonly-inspection.test.js`: existing receipt-directory
  validation accepts POSIX absolute paths only, and Windows symlink creation
  returns `EPERM`. Its two `self-healing-restart.test.js` failures are Windows
  ESM file-URL construction in the test harness. Fixing that exposed two further
  fixture failures because Windows Node injects 11 operating-system environment
  names into the child, contrary to the existing exact allowlist assertion. The
  fixture now deletes non-allowlisted names before importing production code,
  without broadening the assertion. The corrected restart fixture passes 2/2
  and the combined focused run passes 23 suites / 387 tests. The completed full
  rerun also passes both restart tests and retains only the four unchanged
  platform failures. The original six full-run failures and intermediate two restart
  failures remain recorded; no assertion is suppressed.
- Initial Python run had 957 pass / 18 skip / 8 failures because the task temp
  under hidden `.codex` triggered the repository tools' existing hidden-path
  exclusion. An unchanged-source rerun under a nonhidden temp passed 965/18.
- Windows stacked-preview tests failed to intercept a POSIX Docker shell stub;
  a real `docker login ghcr.io` attempted authentication using the synthetic
  fixture token and was denied. Its actual `finally` also ran
  `docker logout ghcr.io`, which may have cleared pre-existing local GHCR
  credentials; their prior state is unknown. No credential inspection, restore
  or retry was attempted. Login rejection prevented tag/push, and no successful
  login, deployment or provisioning occurred. The suite was not rerun; this
  harness isolation gap and possible local credential impact remain evidence
  and must be resolved before relying on that suite on Windows.

## Remaining risks and production prerequisites

- FULL_CI is not established by a green base commit or selected tests. Base
  `7aee3bb...` has a successful GitHub `All Checks Complete` run
  `38539078823`; that result does not transfer to the repaired head. Final root,
  required service-backed tests and platform-blocked checks need explicit final
  outcomes. The final local full root run retains four Windows platform failures;
  final-head GitHub results are recorded in the draft PR. Do not mark MERGE_READY PASS while any required non-live gate lacks
  a pass at the final PR head.
- Local in-memory telemetry does not aggregate web and Worker replicas. No
  secure purpose-bound transport for web prompt/Trinity mitigation was found;
  those cross-process effects remain unavailable. Remote coordinator inspection
  remains `UNKNOWN`; absence of evidence must not become a healthy state.
- Coordinator singleton ownership is per Node process, not a distributed leader
  election. The inspected Worker configuration has one replica; review ownership
  and shared-action concurrency before any separately authorized replica scaling.
- Cooperative cancellation prevents later effects after awaited work settles,
  including the fallback controller; it cannot force-abort already-dispatched
  dependency I/O or prove real lease recovery under process termination.
  The existing 60-second outer drain and
  queue ownership behavior still need a separately approved deployment rehearsal.
- Existing dependency audit findings and 77 lint warnings are not repaired by
  this focused change. Windows harness failures are retained, not waived.
- Any future promotion requires owner authorization, exact head/check refresh,
  review of effective configuration and shared overrides, preserved deployment
  holds, verified Worker-first then web rollout, readiness and sole-active
  deployment evidence, coordinator started/observation evidence, and approved
  live recovery criteria. Do not elevate autonomy, disable dry-run, enable
  automatic execution or restart production as part of this repair.
- Repository PR lifecycle code requires open, non-draft, main-targeted and
  `railway-preview`-labelled PRs for reconciliation; a draft without that label
  returns before constructing the Railway client. Production auto-deploy requires
  a successful default-branch push or an explicit authorized dispatch. Keep this
  PR draft and unlabelled for preview. Read-only project configuration confirms
  native `prDeploys=false` in both accessible ARCANOS projects; no setting was
  changed to publish this draft.

## Historical bootstrap gates

| Gate | Local result; final-head CI remains separate |
| --- | --- |
| CODE_REPAIR | PASS local; final source type-check/build/lint and focused regression pass |
| WORKER_BOOTSTRAP | PASS local synthetic; actual entry body and readiness failure covered |
| SINGLE_CONTROLLER_OWNERSHIP | PASS local synthetic; idempotency, concurrent ticks and cancellation covered |
| CONFIGURATION_POLICY | PASS local; 28 focused config tests and shared-control checks |
| CROSS_PROCESS_EFFECT_SAFETY | PASS local synthetic; unsupported targets denied and actual local consumers exercised |
| SYNTHETIC_ACCEPTANCE | PASS local for the 20 mapped scenarios; final 24 suites / 404 tests including controller cancellation, restart and strengthened queue fixture pass; no live claim |
| SECURITY_REGRESSION | PASS focused local authorization, approval, TTL and ownership-fencing checks; broader platform failures retained |
| FULL_CI | BLOCKED / incomplete; platform failures retained |
| MERGE_READY | NOT_PASS until every required non-live gate passes |
| LIVE_ACCEPTANCE | NOT_RUN |
| PRODUCTION_PROMOTION | NOT_AUTHORIZED |

## Final review and blocker repair

Review began against freshly fetched head
`85a1775ce193d280d4eac995a946485c7fb38a50` and base/merge-base
`7aee3bb9ace55e1fc19f1e83d0b6dfeca169c383`: three commits ahead, zero behind,
38 changed files, clean checkout. The supplied observed head was still current;
no intervening repair existed. Work used the existing
`fix/self-heal-worker-ownership` branch. The PR remains open, draft and unmerged.

### Verified defects and repair commits

| Commit | Defect and repair | Regression evidence |
| --- | --- | --- |
| `dc8a3b1c849f441b616e3c618d3c635d8687ee1f` | HTTP shutdown began coordinator drain and dependency teardown concurrently. Stop admission, await listener/coordinator/pending-startup drains, then telemetry/Redis/database; duplicate calls share completion and one deadline bounds all phases. An uncertified or expired drain forces unsuccessful process exit without racing explicit dependency teardown. | 17 server lifecycle tests; nine added cases cover held operations, duplicate calls, rejection/synchronous failure, timeout, cleanup timeout and partial startup. |
| `3b7167e7eafd9524f8ba5041fe92ae152f7ab85e` | Status reads mixed last-tick authority with current configuration. Preserve the stored mode/timestamp pair. Also recheck configuration after awaited shared controls, reject predictive observation-only takeover during diagnosis, and retain completed-effect verification before honoring cancellation. | 20 new loop unit cases and three integrated coordinator cases; policy/recovery/security selection passes 8 suites / 216 tests. Original new-regression failures retained. |
| `dd49b77d4d0144ca30cf26808f0cd1607655cb11` | Concurrent predictive requests passed cooldown before awaiting authorization and dispatched twice. Reserve the action after final authorization, recheck cooldown, hold ownership through settlement, release in `finally`, and charge uncertain thrown dispatches a cooldown. | 2 suites / 38 tests, including simultaneous policy reads, long-running overlap, failed-attempt retry and seven policy changes during authorization. |
| `f7589d6a78f5e6a9b28fc9b9facb432ba668c0c9` | Failed coordinator installation left queue consumers polling while dependencies closed. Abort process admission with an accurate failure reason, await every slot, then drain coordinators and clean resources. Preserve the original failure and clean partially installed timers. | 6 actual worker-bootstrap tests, including held slot-finalization, no later claims, aborted-process restart refusal, cleanup errors, telemetry rejection and non-RUNNING coordinator return. |
| `ae162fc7b38a3c973913b2c089e119e222c9d689` | Windows receipt validation assumed POSIX paths/modes/symlink privileges; publisher PATH interception could reach host Docker. Use native absolute paths, real junction fixtures and explicit restrictive-open assertions. A Node preloader denies external process/network APIs and positively records exact injected publisher commands. | Linux receipt 44/44, stacked-preview 136/136, live-validation 234/234, final publisher 10/10. The Windows CI job now runs the receipt and publisher fixtures. |
| `eadbb27d13da45e3caf9a2aad776dd5d7d6898fd` | The maintained startup guide still described concurrent dependency teardown. Align it with the repaired drain ordering and deadline. | Documentation validation. |
| `d53370a226427812b1f8bc8869a1a48f7fe6926d` | Full CI logs exceeded the connector response limit, obscuring exact test counts. Retain a bounded artifact and job summary containing exact-head Jest counters for both test selections. | Workflow YAML parses; test exit status, coverage upload and thresholds remain unchanged. |
| `e264bf5a487555111efc56c47f648d2aaab6d058` | The supply-chain test correctly rejected the changed receipt-writer digest. After independently reviewing the portable path and filesystem-adapter change, update the pinned digest. | All five supply-chain containment tests pass; the original full-run failure is retained. |

No execution flags/defaults, production permissions, coverage thresholds or
production-source coverage exclusions were relaxed. The independent review
inspected every original changed file, including all 13 production files,
the affected tests, configuration and maintained/generated documentation.
The generated-index command produced only timestamp changes; those incidental
timestamp edits were discarded after confirming no index-content drift.

### Review and Codecov evidence

The two inline CodeRabbit findings were verified against code, rather than
accepted solely from their suggested diffs:

- Shutdown ordering: thread `PRRT_kwDOPKkVZ86sQ5YW`,
  [comment 4269462199](https://github.com/pbjustin/Arcanos/pull/1544#discussion_r4269462199),
  repaired by `dc8a3b1c`.
- Historical operating mode: thread `PRRT_kwDOPKkVZ86sQ5Yp`,
  [comment 4269462232](https://github.com/pbjustin/Arcanos/pull/1544#discussion_r4269462232),
  repaired by `3b7167e7`.

The walkthrough's additional cancellation/verification concern was also valid
and repaired by `3b7167e7`. Completed effects retain evidence; cancellation still
prevents subsequent dispatch. Both findings were resolved after committing,
verifying and pushing their repairs; the
[shutdown reply](https://github.com/pbjustin/Arcanos/pull/1544#discussion_r4274185190)
and [policy reply](https://github.com/pbjustin/Arcanos/pull/1544#discussion_r4274185784)
record the associated regression evidence. Final review state is refreshed
again after the audit commit.

The actual [Codecov report](https://app.codecov.io/gh/pbjustin/Arcanos/pull/1544)
on the original head was **74.19355% (23/31 changed lines)**, with seven missed
and one partial line, against the repository's **80%** patch target. The report
had the correct base and a complete successful upload. Missing paths were the
worker telemetry rejection, non-RUNNING start guard, optional recovery count and
literal entrypoint. Meaningful worker fixtures cover the important missing
failure branches; no instrumentation repair or policy exception was justified.
Only `jobRunner.ts` among this PR's changed production modules belonged to the
pre-existing explicit coverage scope, so patch coverage is not a substitute for
the broader self-healing regression suite.

Branch metadata and GraphQL `CheckRun.isRequired(pullRequestNumber: 1544)` agree:
**`docs:check` and `All Checks Complete`** are the required check contexts
(GitHub Actions app 15368). Codecov and CodeRabbit are informational to branch
protection. Full protection settings beyond check requirements were inaccessible
(403); ruleset/active-rule lists were empty. GitHub mergeability and engineering
readiness are evaluated separately; draft status is intentionally retained.

### Synthetic coverage and safety boundaries

| Scenarios | Real internal paths and deterministic fixtures |
| --- | --- |
| S01–S05 | Actual `runJobWorker`, all-slot readiness, one canonical scheduler, role suppression, repeated initialization, failed installation and refused restart: worker-bootstrap/coordinator-lifecycle/server-startup suites. |
| S06–S08 | Deferred coordinator/HTTP/startup drains, bounded failed shutdown and worker slot cleanup; actual worker completion with coordinator FAILED then RUNNING. |
| S09–S11 | Config parsing plus reactive/predictive/Trinity/prompt execution; disabled autonomy, configured/shared freeze and predictive dry-run always restrict effects. |
| S12–S13 | Worker prompt/listener actions explicitly unavailable; local prompt and Trinity mitigations reach their actual consumers. |
| S14–S17 | Tick serialization and predictive action reservation; identity-fenced replacement/rollback, TTL expiry, bounded attempts and fresh matching consumer/provider evidence. |
| S18–S20 | Historical mode remains paired with observation time; live action-boundary revocation; fresh-process isolation plus cancel/drain/restart retains completed repair verification without stale effect authority. |
| S21 | Actual auth composition, bearer/principal checks, decision/execute/probe/control scopes, capability checks, ingress/principal rate limits and bounded detailed inspection responses. |
| S22 | Credential-empty child fixtures, forbidden provider/storage adapters and positively asserted publisher interception; unexpected Docker/GHCR/Railway/GH/network paths fail before native execution. |

All transport/database/provider effects in these scenarios are substituted.
They do not establish production acceptance. Coordinator authority remains
process-local, with one scheduler per process rather than distributed leader
election. A web observation cannot establish remote-worker health: remote state
remains `UNKNOWN`. Existing PR #1539 recovery, TTL, identity, replacement,
failed-consumer, cooldown, bounded-history and rollback protections remain.

### Cross-platform findings and retained failures

The exact four historical Windows root failures were all in
`railway-production-readonly-inspection.test.js`:

- `writes only the fixed private receipt and refuses overwrites`
- `retains a blocked receipt when bounded inventory with 5000-byte definitions exceeds artifact size`
- `retains a blocked receipt when bounded inventory with 8192-byte definitions exceeds artifact size`
- `refuses symlinked output and an oversized receipt`

Native `path.isAbsolute` fixes the application path defect. Directory
junctions exercise real link refusal without elevated Windows file-symlink
privileges. Tests retain exclusive-open/no-overwrite/protected-target assertions
and verify requested `0600` mode and descriptor cleanup. Comparing native mode
representation to an independent restrictive reference does **not** establish
NTFS ACL privacy.

The original Windows raw files under `C:/Users/pbjus/.codex/tmp` were unavailable
in this Linux workspace. Their original report and counts above are retained;
no historical receipt was erased or converted to a pass. Linux baseline receipt
tests passed 39/39 before repair; repaired tests pass 44/44. Supplemental Linux
deployment fixtures still intentionally exercise `sh`/`bash`, Unix modes and
umask; this is not a claim of full Windows parity for every deployment fixture.
No broad skip or platform exemption was introduced. The exact repaired Windows
contracts have their own CI execution within the existing Windows job.

The historical synthetic-token Docker login/logout escape was an isolation
defect. This review executed no real registry login, push, logout or credential
repair. Owner-local GHCR credential availability remains unknown after that
historical logout and should be checked only if needed for the owner's workflow.

New failing receipts are also preserved: policy revocation (97 pass/1 fail),
predictive observation-only takeover (98 pass/2 fail), cancelled completion
(25 pass/1 fail), duplicate predictive dispatch (one selected failure), and
worker bootstrap closing dependencies before slot finalization (one selected
failure). The first shutdown fixture run failed on an unsupported Jest matcher;
the assertion was rewritten as exact call-array equality. Later clean runs do
not erase these original results. Raw local receipts are retained under
`/tmp/arcanos-pr1544-evidence/`; predictive-race receipts are also retained under
`/tmp/arcanos-pr1544-predictive-race-*.log`.

The first Linux full-root attempt also exposed setup drift: installed
`proxy-addr` was 2.0.7 versus locked 2.0.8, and the MCP SDK was 1.30.0 versus
locked 1.31.0. A direct pinned-Node Express reproduction attributed the
proxy-trust security assertion failures to the old dependency. `pwsh` was also
missing, so projector fixtures failed with `ENOENT`. PowerShell 7.6.7 was
installed in the isolated task toolchain from the official release, verified
against both the release asset digest and published SHA256 list. Its focused
rerun passed 55 tests with two existing Windows-only skips. These are environment
prerequisites; no assertion or application permission was weakened. The first
full-run receipt is retained separately from validation after locked dependency
installation.

That first Linux root attempt completed with **18,105 passed, 48 failed and
167 skipped** across 930 suites (912 passed, five failed, 13 skipped).
The failures comprised 44 missing-PowerShell assertions, three assertions
against the older installed `proxy-addr`, and one expected receipt-writer
integrity-pin mismatch. The pin was updated only after reviewing the writer's
source diff. `npm ci` restored the exact lockfile versions without manifest or
lockfile changes; the security/integrity focused rerun passed 50/50.

The first push was rejected by GitHub's private-email protection (GH007).
Only the eight new, unpublished commits were recreated with the authenticated
account's GitHub noreply address. Every tree was preserved, and the original
PR history was unchanged. The successful push used the commit IDs above;
rejected-publication metadata and the old-to-new mapping remain in the local
evidence directory.

The second Linux root attempt was deliberately interrupted after eight passing
and three failing suite markers. Three Jest workers competed with type-checking
under a two-core cgroup quota (`cpu.max=200000 100000`); eight assertions timed
out across `native-pr-preview-application.test.ts`,
`native-pr-preview-import-boundary.test.js` and
`gaming-currentness-preview-failure.test.ts`. Its complete emitted log and
interruption metadata are retained; it is not counted as a completed full run.
An unchanged, isolated replay passed all **501 tests in those three suites**
with their existing timeouts. The subsequent full run uses two workers with no
competing build/type-check process. That third run's execution session vanished
after 150 passing suite markers and no failure markers; it emitted neither a
Jest result file nor a final exit receipt. The execution service subsequently
also reported a disconnected transport. No OOM event was recorded. The partial
log and interruption record are preserved, and this is **not** reported as a
completed local pass. Complete exact-head GitHub root and integration runs
supply the full-suite evidence below. No timeout, assertion or platform gate
was relaxed.

### Final validation and exact-head gates

The complete behavioral repair is commit
`e264bf5a487555111efc56c47f648d2aaab6d058`, based on
`7aee3bb9ace55e1fc19f1e83d0b6dfeca169c383`. The repair expands the original
38-file diff to 47 files, including the narrowly scoped fixture and CI changes.
The audit-only commit containing this final section does not change executable
code. Its exact SHA and a fresh full-CI/check/thread snapshot are recorded in the
owner-facing final review handoff, after that commit's checks finish; earlier
green runs do not satisfy that final publication gate. This avoids embedding a
commit's own hash in its contents while retaining an exact behavioral SHA and
an independently verified final publication SHA.

Local validation uses Node 24.18.1, npm 11.16.0, locked dependencies and
PowerShell 7.6.7. Build, type-check, lint (zero errors; 77 existing warnings),
static Railway compatibility, backend/CLI contract, documentation/local links
and generated-index checks pass. No production environment was used.

| Validation | Actual result at the behavioral repair SHA |
| --- | --- |
| Full root Jest | First completed run: 18,105 passed / 48 setup or reviewed-pin failures / 167 skipped. Subsequent interrupted runs are retained above; complete passing full-suite evidence comes from exact-head GitHub CI below. |
| Focused policy/recovery/security | 8 suites / 216 passed. |
| Server shutdown | 17 passed. |
| Predictive execution and decisions | 38 passed. |
| Worker bootstrap | 6 passed. |
| Environment/security/integrity replay | 50 passed. |
| Isolated timing-failure replay | 501 passed, original timeouts unchanged. |
| Linux receipt / publishing | 44 / 10 passed. |
| Stacked-preview / live-validation offline | 136 / 234 passed. |
| Runtime integration | 79 passed. |
| Preview / containment / live-preview offline | 18 / 42 / 16 passed. |
| Compiled model policy / heartbeat | 4 / 6 passed. |

These selections overlap; their counts are not summed as unique tests.
Service-backed and native Windows validation comes from the supported CI matrix:

| GitHub matrix component | Actual result at the behavioral repair SHA |
| --- | --- |
| Root Jest (`unit` job runs the full selection) | **18,153 passed, zero failed, 167 skipped**; 917 passed / 13 skipped suites, 930 total. |
| Integration Jest selection | 863 passed, 162 skipped; 41 passed / 12 skipped suites. |
| Windows Python 3.11 | 970 passed, 13 skipped. |
| Windows receipt / publishing isolation | 44 / 10 passed, no skips. |
| PostgreSQL 18 | 6 local-agent concurrency plus 202 fencing/storage tests passed. |
| Linux Docker sandbox | 29 passed. |
| Standalone runtime / real Redis / provider bridge | 79 / 4 / 14 passed. |
| Compiled model policy / heartbeat | 4 / 6 passed. |
| Lint, type-check, build, security and convergence | PASS. |
| Railway/Docker build and deployment-fixture validation | PASS; preview 18, containment 42 and stacked-preview 136 tests passed. |
| Documentation Audit | PASS; 15 tests passed / one skipped, 1,066 documentation checks. |
| PR CI and API Endpoint Tests | PASS. |

The native Windows receipt and publisher results close the four reported root
portability failures and the registry-interception defect. NTFS ACL privacy is
not inferred from POSIX mode bits, and Linux shell/umask deployment fixtures are
not advertised as general Windows application contracts. These are bounded,
evidence-backed nonblocking limits; no blanket platform exclusion was added.

The [main CI run 38608261630](https://github.com/pbjustin/Arcanos/actions/runs/38608261630)
completed all 13 jobs successfully. The separate
[PR CI](https://github.com/pbjustin/Arcanos/actions/runs/38608261681),
[Documentation Audit](https://github.com/pbjustin/Arcanos/actions/runs/38608262120)
and [API Endpoint Tests](https://github.com/pbjustin/Arcanos/actions/runs/38608262358)
also passed. Exact-head Jest counter artifacts retain the complete counts above;
oversized or inaccessible raw logs were never treated as evidence of success.
Live inspection and Railway preview execution were intentionally skipped.

Codecov at this exact behavioral SHA reports **93.82716% (76/81 changed lines)**,
four missed lines and one partial line, against the unchanged 80% target and
the correct base SHA. `codecov/patch=SUCCESS`; no policy exception is needed.
Both required checks (`docs:check`, `All Checks Complete`) are successful.
Both original review threads are resolved, with bot acknowledgments and no new
unresolved findings. CodeRabbit's walkthrough says draft PRs are not
automatically reviewed, so its status is not claimed as a fresh full review;
the independent source review supplies that evidence.

| Gate | Exact behavioral-head verdict and evidence |
| --- | --- |
| CODE_REPAIR | PASS — focused repairs committed and independently reviewed; build/type/lint/full CI pass. |
| WORKER_BOOTSTRAP | PASS — actual entry body, readiness and failed-startup drain fixtures. |
| SINGLE_CONTROLLER_OWNERSHIP | PASS — role suppression, one scheduler, repeated start and restart fencing. |
| SHUTDOWN_DRAIN_ORDERING | PASS — held operations, normal/failed/timed-out drain, duplicate calls and partial startup. |
| CONFIGURATION_POLICY | PASS — fail-closed defaults, historical snapshots and current action-boundary authorization. |
| CROSS_PROCESS_EFFECT_SAFETY | PASS — unsupported worker prompt/listener effects explicitly unavailable; actual local consumers verified. |
| RECOVERY_AND_ROLLBACK | PASS — fresh evidence, TTL, identity fencing, replacement, cooldown and cancellation receipts retained. |
| SECURITY_REGRESSION | PASS — authentication, scopes, rate limits, bounded inspection and CI security policy. |
| SYNTHETIC_E2E | PASS — S01–S22 mapped above; full exact-head suites pass. |
| CROSS_PLATFORM_VALIDATION | PASS — supported Linux/Windows CI; explicit nonblocking NTFS-ACL/Linux-shell limits above. |
| CODECOV_PATCH | PASS — 93.82716%, above 80%; correct head/base and completed upload. |
| REQUIRED_GITHUB_CHECKS | PASS — both required contexts independently verified. |
| REVIEW_THREADS | RESOLVED — zero unresolved threads after committed verification. |
| MERGE_READY | PASS for this behavioral head under the owner's synthetic policy; the audit-only final head must independently pass its checks before handoff. |
| LIVE_ACCEPTANCE | NOT_RUN — owner deferred. |
| PRODUCTION_PROMOTION | NOT_AUTHORIZED. |

GitHub reports `MERGEABLE` / `CLEAN` for the behavioral head, but the PR remains
draft, open and unmerged. Those metadata do not replace engineering gates or
authorize merging. The owner still reviews the repaired diff and final-head
evidence before changing draft status or merging. No production action was
performed or authorized.

Residual limits are explicit: these tests do not prove live Railway recovery,
distributed scheduler leadership or remote-web mitigation delivery. Existing
dependency advisories and lint warnings remain under the repository's current
policy. The historical Windows Docker logout may have affected owner-local
GHCR credentials; checking those is only necessary if the owner's local workflow
needs them and is separate from PR merge readiness.
