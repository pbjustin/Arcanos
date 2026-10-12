# PR #1539 synthetic verification and code merge readiness

The owner deferred Railway live-service verification and authorized local synthetic assessment and bounded application repairs. This report evaluates code merge readiness under that policy. **Live acceptance is NOT_RUN; production operational readiness remains unverified.** No application was deployed, no Railway resources were created, and no production configuration, service, database, Redis or queue was mutated in this assessment. PR #1539 must remain open and unmerged.

Repository files/commits and protection/review details are captured in [repository state](synthetic-repository-state.md). Exact CI job, artifact and disposable database/Redis receipts are in [CI evidence](synthetic-ci-evidence.md).

## Exact state and evidence scope

- Repository/PR: `pbjustin/Arcanos` [#1539](https://github.com/pbjustin/Arcanos/pull/1539), branch `codex/targeted-security-healing-20261012`, target `main`.
- Assessment start: head `1aca3cbf82c95a89cd9c7b5bad8c6478e1fa2988`; base/current main observed `3fd305b37ba410cf21684a8fed7619a1ba180b48`. Starting PR was OPEN/non-draft, MERGEABLE/CLEAN, auto-merge disabled. Eight commits after approved source `4b4e31a54b819a3597ef3ee163a46e1a7b59fc67` changed audit documentation only.
- Final executable tested: **`400be1912b9e429c9ea0ffdd8f0d07950a82d80c`**. Source-equivalent pre-publication CI/review receipt: [CI and review receipts](synthetic-ci-evidence.md): documentation head `a7355c8cbe28ac5fdd285c45b031a4c07e416d22`, CI/CD [38310400872](https://github.com/pbjustin/Arcanos/actions/runs/38310400872), required `docs:check` and `All Checks Complete` PASS; PR open/non-draft, CLEAN/MERGEABLE, zero unresolved threads. Final documentation-head receipts are linked in the PR description after fresh checks. New executable changes are authorized for local testing; they have not been authorized or used for deployment.
- Unit evidence executes isolated state/policy functions. Synthetic integration executes real application controller/authorization/actuator/consumer logic with deterministic external adapters. Local process E2E executes fresh real Node source processes. None of these is a Railway deployment or real-provider availability result.
- Clocks are controlled, inputs are synthetic and external mutations are forbidden. The SDK fixture admits only a bounded authenticated loopback origin/path/model and finite request/reply/transcript sizes. Real socket/SDK execution remains real; provider responses are deterministic substitutes. No paid provider was called.

## Reproducible commands

Commands below run from the repository root. Shared package outputs must be built before direct Jest. Exact Node `24.18.1` / npm `11.16.0` are mandatory. This credential-empty envelope is used for the lead's final runs; the synthetic key and intentionally unavailable loopback provider URL prevent ambient provider use. Jest's inspected repository wrapper supplies `NODE_ENV=test` and strips production-only settings.

```sh
pr1539() {
  env -i PATH=/tmp/arcanos-preview-recovery-toolchain/node-v24.18.1-linux-x64/bin:/tmp/pr1539-synthetic-python-venv/bin:/usr/local/bin:/usr/bin:/bin \
    CI=true OPENAI_API_KEY=mock-api-key FORCE_MOCK=true OPENAI_BASE_URL=http://127.0.0.1:9/v1 "$@"
}
# C_TOOLCHAIN
pr1539 node --version
pr1539 npm --version
# C_PACKAGES — already included by full npm test/type-check/build
pr1539 npm run build:packages
# C_CONTROLLER
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/self-healing-synthetic-controller.integration.test.ts tests/self-healing-loop.test.ts tests/self-heal-control-loop-startup.test.ts --runInBand --coverage=false
# C_TRINITY
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/self-healing-v2.test.ts tests/prompt-route-mitigation.test.ts tests/self-healing-trinity.integration.test.ts tests/openai-prompt.test.ts --runInBand --coverage=false
# C_TRINITY_WIDE
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/trinity.test.ts tests/trinity-direct-answer-mode.test.ts tests/trinity-direct-answer-stage.test.ts tests/trinity-cancellation.test.ts tests/trinity-stage-budget.test.ts tests/trinity-integrity-recovery.test.ts tests/trinity-model-policy.e2e.test.ts tests/trinity-writing-pipeline.test.ts tests/query-finetune-trinity.test.ts tests/worker-trinity-pipeline.test.ts --runInBand --coverage=false
# C_SECURITY
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/self-healing-security-synthetic.integration.test.ts tests/security-rate-limit.test.ts tests/query-finetune-rate-limit.test.ts tests/public-provider-rate-limit-store.test.ts tests/public-provider-admission.test.ts tests/control-plane-http-auth.test.ts tests/self-heal-http-boundary.test.ts tests/self-heal-auth-composition.test.ts tests/self-improve-auth-composition.test.ts tests/self-healing-control-rate-limit.test.ts tests/worker-repair-actuator.test.ts --runInBand --coverage=false
# C_WORKER
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/self-healing-worker-synthetic.integration.test.ts tests/self-healing-restart.test.js tests/app-runtime-worker-startup.test.ts tests/worker-duplication-suppression.test.ts tests/worker-restart-threshold-recovery.test.ts tests/redis-startup-lifecycle.test.ts tests/safety-v2-redis-lifecycle.test.ts tests/self-heal-telemetry-redis.test.ts tests/server-startup-resilience.test.ts tests/unified-config.worker-mode.test.ts tests/job-runner-ask-terminal-retention.test.ts tests/worker-autonomy-service.test.ts tests/job-runner-runtime.test.ts tests/worker-trinity-pipeline.test.ts tests/job-runner-backstage-admission.test.ts tests/redis-operation-boundary.test.ts tests/unified-health-redis.test.ts --runInBand --coverage=false
# C_PREVIEW_CONTRACTS — preserved static contracts, no deployments
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/native-pr-preview-import-boundary.test.js tests/railway-pr-preview-lifecycle.test.js tests/pr-preview-workflow-safety.test.js --runInBand --coverage=false
# C_FULL — includes package builds and normal repository coverage configuration
pr1539 npm test -- --maxWorkers=1 --workerIdleMemoryLimit=768MB --json --outputFile=/tmp/pr1539-synthetic-full-jest.json
# C_RUNTIME_INTEGRATION / C_RUNTIME_SECURITY — root Jest excludes this workspace
pr1539 npm run test:runtime-integration
pr1539 npm --prefix arcanos-ai-runtime test
# C_STATIC — each command has its own exit/result; this is not a shell pipeline
pr1539 npm run type-check
pr1539 npm run lint
pr1539 npm run build
pr1539 npm run validate:railway
pr1539 npm run validate:backend-cli:contract
pr1539 env PYTHON_DOTENV_DISABLED=1 DATA_DIR=/tmp/pr1539-synthetic-python-data npm run validate:backend-cli:offline
pr1539 npm run sync:check
# C_DOCS
pr1539 npm run docs:check
pr1539 npm run docs:links -- --local-only
git diff --check
```

Workstream exploratory runs used the same pinned toolchain and repository wrapper, with additional literal synthetic environment/adapter isolation inside their fixtures. Their logs are preliminary evidence; final committed-source results replace them. Do not sum overlapping workstream/full/CI sweeps as unique coverage. Red runs selected the named regression fixture with `--runInBand --coverage=false`; `--testNamePattern` where noted deliberately excludes other cases and those exclusions are not final skipped coverage.

## Committed-source focused union

```sh
pr1539 node scripts/run-jest.mjs --runTestsByPath tests/app-runtime-worker-startup.test.ts tests/control-plane-http-auth.test.ts tests/job-runner-ask-terminal-retention.test.ts tests/job-runner-backstage-admission.test.ts tests/job-runner-runtime.test.ts tests/native-pr-preview-import-boundary.test.js tests/openai-prompt.test.ts tests/pr-preview-workflow-safety.test.js tests/prompt-route-mitigation.test.ts tests/public-provider-admission.test.ts tests/public-provider-rate-limit-store.test.ts tests/query-finetune-rate-limit.test.ts tests/query-finetune-trinity.test.ts tests/railway-pr-preview-lifecycle.test.js tests/redis-operation-boundary.test.ts tests/redis-startup-lifecycle.test.ts tests/safety-v2-redis-lifecycle.test.ts tests/security-rate-limit.test.ts tests/self-heal-auth-composition.test.ts tests/self-heal-control-loop-startup.test.ts tests/self-heal-http-boundary.test.ts tests/self-heal-telemetry-redis.test.ts tests/self-healing-control-rate-limit.test.ts tests/self-healing-loop.test.ts tests/self-healing-restart.test.js tests/self-healing-security-synthetic.integration.test.ts tests/self-healing-synthetic-controller.integration.test.ts tests/self-healing-trinity.integration.test.ts tests/self-healing-v2.test.ts tests/self-healing-worker-synthetic.integration.test.ts tests/self-improve-auth-composition.test.ts tests/server-startup-resilience.test.ts tests/trinity-cancellation.test.ts tests/trinity-direct-answer-mode.test.ts tests/trinity-direct-answer-stage.test.ts tests/trinity-integrity-recovery.test.ts tests/trinity-model-policy.e2e.test.ts tests/trinity-stage-budget.test.ts tests/trinity-writing-pipeline.test.ts tests/trinity.test.ts tests/unified-config.worker-mode.test.ts tests/unified-health-redis.test.ts tests/worker-autonomy-service.test.ts tests/worker-duplication-suppression.test.ts tests/worker-repair-actuator.test.ts tests/worker-restart-threshold-recovery.test.ts tests/worker-trinity-pipeline.test.ts --runInBand --coverage=false --json --outputFile=/tmp/pr1539-synthetic-focused.json
```

## Eighteen-scenario matrix

Every row applies to final executable `400be1912b9e429c9ea0ffdd8f0d07950a82d80c` only after final rerun. “PASS” records verified synthetic application behavior; live acceptance remains separately NOT_RUN. All eighteen scenarios passed the committed-source 47-suite/1,379-test focused run. Final full-regression and CI receipts are reported separately below. `C_*` command labels are fully defined above; fixture names below are repository paths under `tests/`.

| ID | Injected condition | Expected behavior | Observed application behavior | Command / fixture assertion | Status | Evidence / limitations |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | Healthy diagnostics and ordinary local SDK response. | No mitigation or competing controller. | Real coordinator remains healthy; normal Trinity performs four authorized loopback POSTs with no active command; sub-threshold state stays inactive. | C_CONTROLLER/C_TRINITY; `self-healing-synthetic-controller.integration.test.ts` healthy/sub-threshold; `self-healing-trinity.integration.test.ts` healthy real consumer. | PASS | Synthetic integration; diagnostics/provider externally substituted. |
| S02 | Actual SDK intake transport abort/timeout. | Bounded recovery, no escalation for one transient failure. | One authority direct fallback; no threshold activation; next real consumer resumes normal stages. Caller cancellation is distinct from finite timeout backstop and does not mark mitigation ineffective. | C_TRINITY; transient transport, finite timeout backstop and caller-cancellation cases. | PASS | Real SDK/loopback transport, deterministic provider; no public-provider outage proof. |
| S03 | Sustained synthetic 503 and failed/throwing reload. | Bounded degraded behavior or escalation. | Five SDK attempts open actual circuit; next fails before HTTP; finite probes restore it. Real coordinator limits reload attempts to three per incident window and bounded escalation. Explicit `ok:false` cannot create recovery. | C_TRINITY/C_CONTROLLER; sustained provider and bounded provider-attempt cases. | PASS | Real circuit/controller policies, external actuator/advisor boundary injected. |
| S04 | Authorized reasoning degradation/final bypass command. | Real Trinity consumer applies command. | Reasoning command changes simple request to one authority POST with reasoning omitted. Final bypass uses three POSTs vs normal four and emits its actual bypass flag; final-authority recovery remains enforced. | C_TRINITY; complete controller/three-consumer cycle and final-bypass cases. | PASS | Actual consumer/SDK transcript; no pass inferred solely from selected action. |
| S05 | Redis ECONNREFUSED, unavailable commands, generation interruption/flapping. | Safe reconnect/fail-closed controls; no corrupted shared replacement. | Real lifecycle degrades, blocks operation callbacks, bounds backoff/deadlines and reconnects once. Privileged safety fails closed; telemetry retains local events and merges/flushes once; public provider admission does not replace shared budget with memory. | C_WORKER/C_SECURITY; `redis-startup-lifecycle`, `safety-v2-redis-lifecycle`, `self-heal-telemetry-redis`, `public-provider-rate-limit-store`. | PASS | Real lifecycle/consumer policy with synthetic Redis client, not server failover or Lua atomicity. |
| S06 | Transient/sustained queue executor failure, duplicate/stale lease. | Bounded retry and no stale duplicate effect. | Actual consumer/policy/repository issue 100ms then 200ms retry and one terminal dead-letter at persisted two-retry limit. Initial heartbeat fence miss invokes no executor; old generation cannot alter completed/new-generation row. | C_WORKER; `self-healing-worker-synthetic.integration.test.ts` transient, sustained, duplicate claim. | PASS | Actual SQL/fencing branching with CAS storage substitute; real PostgreSQL atomicity belongs to disposable CI. |
| S07 | One/two then three qualifying failure observations. | Activate only at threshold. | First two V2 failures remain inactive, third activates. Coordinator's healthy/sub-threshold samples do not mutate state. | C_TRINITY/C_CONTROLLER; `self-healing-v2.test.ts` threshold; controller healthy/sub-threshold. | PASS | Controlled clock and actual V2 threshold, not production traffic. |
| S08 | Time reaches exact mitigation TTL with no controller traffic. | Clear temporary policy and restore consumer. | V2 and both prompt modes expire exactly at ten minutes; no timer required. Next actual Trinity/handlePrompt executes normal stages/timeouts with no degraded response/warnings. | C_TRINITY; `prompt-route-mitigation.test.ts`, `self-healing-v2.test.ts`, real consumer expiry and `openai-prompt.test.ts`. | PASS | Common lazy read expiry; continued unhealthy traffic may validly fast-trip again. |
| S09 | Empty/stale/same-time/one-request, wrong route, missing worker health. | Require sufficient fresh attributed consumer/worker evidence. | Existing repairs reject health-only/unknown baseline, one sample and inclusive same-clock completions; require three affected-consumer samples; empty or unrelated traffic cannot close an unchanged worker stall. Missing/exceptional worker inspection is not zero stalled jobs. DAG/control labels are excluded. Diagnostic-only completions cannot recover Trinity without three actual same-ID consumer successes, or a provider reload without three fresh non-cached provider success receipts. | C_CONTROLLER; freshness, unknown attribution, DAG control, worker inspection unavailable and starved verification cases. | PASS | Actual diagnostics/verifier and matched command state; worker boundary injected. Joined SDK tests provide real non-cached execution receipts. |
| S10 | Reload actuator throws on each permitted dispatch. | Retry budget remains enforced. | Three dispatches maximum per incident window; fourth blocked; cooldown/escalation do not produce retry storm. Failed actuator creates no success/pending recovery. | C_CONTROLLER; bounded provider-attempt fixture. | PASS | Actual coordinator budget; actuator is deterministic throw-on-use substitute. |
| S11 | Concurrent ticks, queue incident plus Trinity incident, simultaneous intake/final commands. | Deterministic ownership and no cross-incident rollback. | Actual coordinator dispatches once for overlapping ticks, verifies queue improvement before independent command; real Trinity consumes deterministic intake priority, clearing intake leaves final active, then final is actually consumed. 1,000 failures retain only three stage samples. | C_CONTROLLER/C_TRINITY; concurrent tick/incident and independent-stage consumer cases. | PASS | In-process serialization and actual consumer; replica-wide locking not established. |
| S12 | Explicit web role with autonomous healing enabled; duplicate bootstrap calls. | Disabled controllers remain disabled, single rightful startup owner. | Web startup/interval paths stay disabled; twelve fresh-child failure observations cause no automatic action; workers cannot be forced into web. Manual authorized web command still reaches actual Trinity. App bootstrap is once per app. | C_TRINITY/C_WORKER/C_CONTROLLER; web-role consumer, `self-healing-restart.test.js`, startup ownership suites. | PASS | Synthetic role configuration plus genuine fresh Node process; live deployed role wiring unverified. |
| S13 | Forged bearer/agent/automation identity, missing execute scope/capability, uncertain predictive ownership. | Reject without actuator side effects. | Actual HTTP gates return 401/403, zero coordinator ticks/effects and unchanged real mitigation/kill-switch state; sanitized denial audit. Uncertain predictor produces no reload/queue/escalation. Actual worker actuator refuses unsafe scope/approval before fetch/deploy. | C_SECURITY/C_CONTROLLER; `self-healing-security-synthetic.integration.test.ts`, uncertainty and worker actuator denial. | PASS | Real auth/actuator boundaries; external persistence/advisor inputs injected. |
| S14 | Active V2 command followed by fresh process; old completion after queue reclaim. | Explicit transient invalidation or safe restored state. | Fresh child has zero attempts/actions/observations/cooldown; one new failure stays below threshold, no replay. Different PIDs; stale worker completion does not terminalize replacement owner; new generation completes once. | C_WORKER; `self-healing-restart.test.js` fresh process; worker stale-completion case. | PASS | Local process E2E for V2; queue storage is synthetic CAS, not OS-crash database durability. |
| S15 | Old same-action completion/fallback and old prompt verification after replacement at TTL/same clock. | Old cycle cannot verify, clear or roll back newer command. | Immutable command IDs travel through actual consumer/outcome/controller rollback. Old completion's counters remain zero; stale rollback rejected; same-clock prompt replacement stays active. | C_TRINITY/C_CONTROLLER; older consumer/intake timeout, prompt replacement cases. | PASS | Deterministic response gate and real consumer; process-local identity, not distributed fencing. |
| S16 | 11,000 unique callers, oversized key, saturated Redis/cache starts. | Bounded memory and accurate retry headers. | Actual limiter stores exactly 10,000 distinct fixed SHA-256 keys; overflow denied without eviction; retained actor still denied; Retry-After900/exact expiry restore capacity. Redis cache/start/concurrency guards also bounded. | C_SECURITY; hard map ceiling, earliest varied expiry and Redis-start/load-shed cases. | PASS | Allocation/counter proof, not production RSS benchmark. |
| S17 | Rotate Forwarded/XFF/X-Real-IP/session/credential; spoof trusted-chain leftmost hop. | Preserve trust boundary and admission identity. | Actual GPT limiter permits first direct request only; ten rotated attempts denied. Explicit proxy policy chooses first untrusted hop; leftmost spoof cannot create budget. Railway real-IP admission separately requires opt-in+peer+valid edge marker. | C_SECURITY; direct/trusted-chain GPT consumer, `security-rate-limit`, `public-provider-admission`, query route. | PASS | Actual Express/socket semantics; deployment ingress trust remains unverified. |
| S18 | Repeated decisions during normal/ineffective cooldown; no fresh verification traffic. | Bound actions without permanent incident starvation. | Failed action cooldown uses the same dispatch key; no extra reload. Evidence-starved verification expires at existing incident window, logs failure and releases ownership for later repair. | C_CONTROLLER/C_TRINITY; ineffective-provider cooldown, starved verification, failed V2 action. | PASS | Controlled time, actual cooldown maps; external repair effect injected. |

Named fixture/assertion references are stable test descriptions; line numbers are supplementary because the final repair can shift them. The actual implementations executed by these fixtures are:

| Fixture / assertion family | Real implementation exercised | External substitute |
| --- | --- | --- |
| `self-healing-synthetic-controller.integration.test.ts` | `selfHealingLoop.ts`, actual `runtimeDiagnosticsService.ts` aggregation, V2/prompt actuator state, predictive/reactive authorization policy. | Provider reload receipt, worker health/queue adapter, external proposal/advisor, event persistence. |
| `self-healing-trinity.integration.test.ts` | Canonical coordinator/V2 state, Trinity writing pipeline/engine, actual SDK HTTP calls, actual mitigation consumer/outcome. | Authenticated local SDK provider, diagnostics, unrelated memory/worker/proposal persistence. |
| `self-healing-worker-synthetic.integration.test.ts` | `runWorkerConsumerSlot`, `WorkerAutonomyService.handleJobFailure`, `jobRepository.scheduleJobRetry` and terminal SQL guards. | Storage CAS/rows, scheduler, measurement, domain executor and client. |
| `self-healing-restart.test.js` | Actual source state in distinct Node processes, command activation/reset and web-role suppression. | Explicit environment/import allowlist, forbidden provider/network, empty cwd. |
| `self-healing-security-synthetic.integration.test.ts` | Actual route/bearer/scope/capability/registry, kill switch, coordinator/consumer state, GPT-access limiter. | Prisma lookup, forbidden external/provider/Redis/Railway effects. |
| `self-healing-v2.test.ts` / `prompt-route-mitigation.test.ts` | V2 command state/threshold/TTL/identity/bounds and prompt common-policy expiry/rollback. | Controlled Date/environment. |

## Joined end-to-end synthetic paths

| Scenario | Joined application proof | Result / limit |
| --- | --- | --- |
| A — recovery | Normal four-POST real consumer → controlled unhealthy diagnostic window → real canonical diagnosis/authorization/V2 application → three actual one-POST direct consumers → sufficient fresh improved verification → TTL expiration → normal consumer/no command. | PASS, `self-healing-trinity.integration.test.ts` complete cycle. A second joined case proves provider reload acknowledgement followed by three normal Trinity executions, twelve real loopback SDK POSTs and actual emitted resilience receipts; reload effect itself remains an injected acknowledgement. |
| B — unrecoverable | Sustained SDK failure opens real circuit; actual coordinator's throwing/failed provider boundary exhausts bounded attempts, ineffective verification escalates without retry storm; actual failed mitigation consumers roll back after two failures and restore normal path. | PASS, joined C_CONTROLLER/C_TRINITY. Escalation adapter is recorded synthetic stub, not a created remote PR or paid advisor. |
| C — concurrency | Overlapping ticks dispatch once; queue verification precedes independent Trinity decision; independent intake/final IDs use deterministic actual-consumer priority and isolated clearing; observation memory bounded. | PASS, C_CONTROLLER/C_TRINITY. No replica-wide state-sharing or real database lock proof. |
| D — restart | Actual active command in one Node source process → distinct fresh child → transient state explicitly absent → one new failure below threshold, no replay; stale queue generation cannot modify reclaimed owner. | PASS, C_WORKER. Local process-level proof; does not claim restoration of distributed incidents. |
| E — security | Untrusted HTTP mutation → actual bearer/scope/capability rejection → no coordinator/consumer/safety mutation → sanitized denial event. Positive authorized freeze reaches actual kill-switch, proving protected action is executable. | PASS, C_SECURITY plus predictive/worker actuator denials. External identity store is synthetic. |

These paths exercise the real consumer and actuator boundaries. They are deliberately joined deterministic application scenarios, not a new verification framework and not a claim of one live web/worker deployment.

## Confirmed defects and bounded repairs

| Cause reproduced before fix | Small correction | Failing then green evidence |
| --- | --- | --- |
| V2 compared stage/action only; old request completion or stage-timeout fallback credited a same-action replacement. | Add monotonic process-local command ID; carry captured ID through actual Trinity outcome/failure and conditional rollback; mismatched old stage failure returns no owned action. | `self-healing-v2.test.ts`; real SDK older consumer/intake tests; `/tmp/pr1539-trinity-red.log`, `...-consumer-red.log`, `...-timeout-replacement-red.log`. |
| Actual failed direct/final-bypass consumers omitted verification failure accounting. | Record consumed-command failure, preserve error/ID; caller cancellation stays excluded. Two failures roll back and impose existing cooldown. | Actual two-failure consumer cases; `/tmp/pr1539-trinity-consumer-failures-red.log`. |
| Composite intake degradation+final bypass reported intake's action to final verifier. | Report actual `bypass_final_stage` command and log identity. | Real architectural final-bypass fixture; `/tmp/pr1539-trinity-composite-red.log`. |
| Both prompt mitigation modes persisted indefinitely; old verifier could clear replacement. | Fixed ten-minute common lazy expiry and generation-checked rollback; preserve default budgets on expiry. | Prompt TTL/replacement and actual `handlePrompt` restoration; `/tmp/pr1539-trinity-red.log`, `/tmp/pr1539-synthetic-controller-red.log`. |
| V2 retained all failure timestamps after action budget exhaustion. | Retain only newest three threshold samples per stage. | 1,000-failure fixture observed1,000 before/three after; `/tmp/pr1539-trinity-observations-red.log`. |
| Recovery accepted health-only, unknown baseline, one/same-clock sample and overly broad control-route attribution. | Pin affected known consumer, exclusive post-command time, three fresh samples; do not substitute global HTTP traffic. Exact writing-route allowlist excludes control-plane labels, and success additionally requires matching command consumer receipts. | Actual diagnostic freshness cases; `/tmp/pr1539-synthetic-controller-red.log`, `...-unknown-route-red.log`, `...-worker-control-route-red.log`. |
| Explicit reload failure still began verification; empty traffic then appeared improved. | Begin provider verification only on successful receipt; require fresh sufficient affected-consumer evidence. | `/tmp/pr1539-synthetic-controller-provider-red.log`, `...-provider-worker-red.log`. |
| Ineffective cooldown key differed from dispatch's tracking key. | Store/lookup the same actual action key. | Exactly bounded dispatch/cooldown fixture; `/tmp/pr1539-synthetic-controller-provider-red.log`. |
| Worker recovery inferred improvement from vanished/unrelated HTTP traffic or unavailable health interpreted as zero stalled jobs. | Use fresh available worker health/runtime evidence, not unrelated traffic; require successful worker inspection and a finite observed queue counter; missing data cannot appear as zero stalls. | `/tmp/pr1539-synthetic-controller-worker-traffic-red.log`, `...-missing-worker-observation-red.log`. |
| Strict freshness follow-up could leave pending provider verification indefinitely and block later incidents. | Invalidate evidence-starved pending command at existing incident window, record failure/cooldown, release ownership. | `/tmp/pr1539-synthetic-controller-starved-verification-red.log`; follow-up implementation regression caught before finalization, not a separately claimed original defect. |

Product corrections are confined to `src/core/logic/trinity.ts`, `src/services/selfImprove/selfHealingV2.ts`, `src/services/selfImprove/selfHealingLoop.ts` and `src/services/openai/promptRouteMitigation.ts`, with their bounded regression fixtures and maintained documentation. No distributed persistence, dependency upgrade, permanent fault-injection endpoint or live infrastructure was added. Fixture import/export or expectation setup failures are not counted as application defects or red-to-green product evidence.

Red evidence log basenames above use these complete prefixes; they are outside the repository and contain synthetic data only:

```text
/tmp/pr1539-trinity-red.log
/tmp/pr1539-trinity-consumer-red.log
/tmp/pr1539-trinity-timeout-replacement-red.log
/tmp/pr1539-trinity-consumer-failures-red.log
/tmp/pr1539-trinity-composite-red.log
/tmp/pr1539-trinity-observations-red.log
/tmp/pr1539-synthetic-controller-red.log
/tmp/pr1539-synthetic-controller-unknown-route-red.log
/tmp/pr1539-synthetic-controller-worker-control-route-red.log
/tmp/pr1539-synthetic-controller-provider-red.log
/tmp/pr1539-synthetic-controller-provider-worker-red.log
/tmp/pr1539-synthetic-controller-worker-traffic-red.log
/tmp/pr1539-synthetic-controller-missing-worker-observation-red.log
/tmp/pr1539-synthetic-controller-starved-verification-red.log
```

The retained deterministic regression fixtures are the durable failing-condition evidence. Sanitized expected/observed assertions and original log hashes are preserved in [red-to-green evidence](synthetic-red-to-green-evidence.md); temporary logs alone are not claimed as a long-lived PR artifact. Full provider transcripts, credentials or private payloads must not be copied into documentation.

## Deferred framework removal and coverage accounting

Removed PR-added `.github/workflows/railway-self-healing-preview-preflight.yml`, `scripts/railway-self-healing-preview-preflight.mjs`, `scripts/railway-self-healing-preview-profile.mjs`, their two test files and the associated normal-deployment documentation bullet. Reference inspection found no normal `src` import, package script or generated-index dependency; retained native preview import/lifecycle/security contracts still pass locally. No replacement infrastructure was created. Historical references use immutable source commit `1aca3cbf82c95a89cd9c7b5bad8c6478e1fa2988` rather than dangling current paths.

The retired **73 profile+35 preflight=108 framework tests** verified deferred planning/profile infrastructure, not runtime healing or live acceptance. They must be explained separately from new application regression coverage; do not hide their removal by summing repeated sweeps. Historical staging attempts remain failed/blocked history with cleanup subsequently confirmed, never retroactively successful deployments.

## Local executor and tooling limitations

The first full local attempt used four workers on this executor's two-CPU quota. Existing `gaming-hybrid-lifecycle.integration.test.ts` and `native-pr-preview-application.test.ts` hit their unchanged five-second test limits. The partial run was preserved and stopped with exit130; it is not a complete regression PASS. The corrected full command uses one worker and a 768MB worker memory limit, without changing repository timeouts or skipping tests. Both formerly timed-out suites passed in that run.

That full run initially lacked `pwsh`, causing existing GateR1/R2 projector contract process admission to fail with ENOENT. Verified official PowerShell7.4.20LTS was installed only under `/tmp`, with transparent execution through the already configured test PATH. After installation, GateR2 passed38tests/1existing Windows-only skip, and GateR1 passed17tests/1existing Windows-only skip. Those reruns are the same assertions, not new unique test coverage; the original failures remain separately reported. Complete GitHub sweeps have the required tooling and independently execute these contracts without failures.

The backend/CLI offline validator initially lacked the declared Python SDK. An isolated Python3.12.14venv installed OpenAI2.30.0 and repository CI's minimal protocol dependencies, without changing manifests or locks. The offline rerun used `PYTHON_DOTENV_DISABLED=1` and a private temporary `DATA_DIR`; it passed with explicit mock generation/stream/vision/transcription and zero provider calls. GitHub CI independently uses Python3.11. The venv PATH is included in the command envelope so normal transport tests execute instead of skipping for missing schema dependencies.

The audit forward-link introduced during report preparation failed source `400be191`be191's documentation check (977/978 checks passed). Documentation-only correction `a7355c8cbe28ac5fdd285c45b031a4c07e416d22` points to the existing acceptance index and passes the fresh required Docs workflow. No prior failed check is silently represented as passed.

## Results and final checks

| Scope | Result | Counts/limitations |
| --- | --- | --- |
| Combined focused source run | PASS | 47 suites /1,379 tests, zero skipped; exact selected paths in the command below. |
| Complete local root run | FAIL | 899 suites /17,540 tests passed, two suites /44 assertions failed solely from missing `pwsh`,13 suites /167 tests skipped;1902.259s. |
| Unchanged failing-suite reruns | PASS | GateR2:38passed/1Windows-onlyskip; GateR1:17passed/1Windows-onlyskip. All44 failing assertions re-executed successfully. |
| Complete GitHub root sweeps | PASS | Each901suites/17,584tests passed,13suites/167tests skipped. Do not add repeat jobs as unique coverage. |
| Filtered GitHub integration | PASS | 37suites/744tests passed,12suites/162tests skipped; overlaps root suite. |
| Guarded disposable PostgreSQL18 | PASS | Local agent1suite/6tests; fencing15suites/202tests; no skips. Swift HTTP proof19assertions separately. |
| Standalone runtime / actual disposable Redis | PASS | Runtime79, Redis/BullMQ4, public-provider Redis14, separately scoped; no skips. |
| Local standalone runtime commands | PASS | Smoke/security70; integration79; overlapping commands, no skips. |
| Compiled local application | PASS | Model-policy4; heartbeat6; synthetic loopback processes, zero external attempts. |
| Type-check / lint / build | PASS | Exact Node24.18.1/npm11.16.0; lint77existing warnings,0errors; no new warning. |
| Static Railway / backend-CLI / docs | PASS | Static compatibility, manifest, isolated Python offline validator, sync, docs/indexes and maintained local links; no Railway operation. |

The local full run remains FAIL as recorded; the replay and complete CI establish correction of executor setup, not a rewritten successful original run. No test timeout, skip marker or CI coverage threshold was weakened.


Final full-suite/skip/coverage results: Full CI: 901 suites / 17,584 tests passed; 13 suites / 167 tests skipped. Complete local sweep: 899 suites / 17,540 tests passed; two suites / 44 assertions failed before PowerShell was available, all subsequently passed unchanged in two focused reruns (55 passed, two existing Windows-only skips). Repeated sweeps are not added as unique tests. Source-equivalent exact-head required CI and review evidence: [CI and review receipts](synthetic-ci-evidence.md): documentation head `a7355c8cbe28ac5fdd285c45b031a4c07e416d22`, CI/CD [38310400872](https://github.com/pbjustin/Arcanos/actions/runs/38310400872), required `docs:check` and `All Checks Complete` PASS; PR open/non-draft, CLEAN/MERGEABLE, zero unresolved threads. Final documentation-head receipts are linked in the PR description after fresh checks. No result for a prior or superseded head substitutes for these final receipts.

Preliminary workstream scopes: security11suites/264tests; worker combined17suites/311tests; Trinity focused4suites/39tests plus distinct broader10suites/160tests; preserved preview contracts3suites/519tests. Controller final scope3suites/93tests includes22new integration cases; Trinity focused scope is now4suites/39tests after the actual provider-receipt join. Final combined committed-source selection is47suites/1,379tests, zero failures/skips. All these passing scopes had zero skips, but overlap each other and full CI and are not additive. Standalone local runtime integration79tests and smoke/security70tests also overlap each other; keep distinct from root Jest. CI's guarded disposable PostgreSQL/Redis tests must be reported separately from local adapter evidence.

At initial published head both actual required contexts (`docs:check`, `All Checks Complete`) passed. One historical review thread was resolved/outdated, none unresolved; CodeRabbit was paused, so its green context is not fresh review of these repairs. Legacy branch-protection fine print was integration-inaccessible, while server-required flags and mergeability were available. Fresh final-head required flags, dependency/terminal run results, all thread pages and main/base identity must be rechecked before final gate changes.

Coverage: current source-equivalent CI reports statements/lines93.57%, branches87.33%, functions95.79%. The source `400be191` CI/CD branch sample was87.32%, one fewer covered branch; both full thresholds passed. Previous statements/lines93.52%, branches87.33%, functions95.79% show no material regression. Previous899suites/17,640tests minus the two retired infrastructure suites/108tests plus four new fixture suites/52additional application assertions gives901suites/17,584tests. The167skips are unchanged; guarded disposable CI executes its required PostgreSQL/Redis cases without skips.

The final audit-only head must pass fresh checks before completion; its immutable SHA and receipts are supplied in the PR description. All executable/test/build/dependency files remain identical to400be191. This does not infer a PASS for a superseded executable or for Railway.

## Residual risk and gates

Mitigation and canonical incident state remain process-local/transient. Restart safely invalidates state, but independent web/worker processes do not gain durable shared incidents or replica-wide actuator deduplication. Deployment role ownership, real provider recovery, Redis/PostgreSQL network/atomicity/durability, ingress identity fairness and resource wiring remain unverified live behavior. Generic/GPT admission honors Express trust/socket identity and can aggregate proxied clients; some existing protected route-specific compatibility keys retain caller-session scoping. No synthetic evidence waives a reproduced recovery or authorization defect.

| Gate | Result | Evidence |
| --- | --- | --- |
| SYNTHETIC_E2E_VERIFIED | PASS | Final combined A–E rerun tied to executable SHA. |
| SELF_HEALING_RECOVERY_VERIFIED | PASS | Final fresh/attributed/available-worker S09 correction and positive recovery. |
| TRINITY_CONSUMPTION_VERIFIED | PASS | Final-source real SDK consumer transcript assertions. |
| FAILURE_ESCALATION_VERIFIED | PASS | Final-source bounded failed actuator/consumer escalation assertions. |
| RETRY_AND_COOLDOWN_VERIFIED | PASS | Final-source budget/cooldown/expiry suites. |
| CONCURRENCY_VERIFIED | PASS | Final-source concurrent/coordinator/generation fencing assertions. |
| RESTART_SAFETY_VERIFIED | PASS | Final-source fresh Node process and stale worker ownership cases. |
| SECURITY_BOUNDARIES_VERIFIED | PASS | Final-source real HTTP/actuator rejection and saturation/spoofing suite. |
| PRODUCTION_COMPATIBILITY_VERIFIED | PASS | Final type-check/build/lint/static deployment and startup contracts. |
| REGRESSION_TESTS_PASSED | PASS | `Full CI: 901 suites / 17,584 tests passed; 13 suites / 167 tests skipped. Complete local sweep: 899 suites / 17,540 tests passed; two suites / 44 assertions failed before PowerShell was available, all subsequently passed unchanged in two focused reruns (55 passed, two existing Windows-only skips). Repeated sweeps are not added as unique tests.`, no unclassified failure or material regression. |
| REQUIRED_CI_PASSED | PASS | [CI and review receipts](synthetic-ci-evidence.md): documentation head `a7355c8cbe28ac5fdd285c45b031a4c07e416d22`, CI/CD [38310400872](https://github.com/pbjustin/Arcanos/actions/runs/38310400872), required `docs:check` and `All Checks Complete` PASS; PR open/non-draft, CLEAN/MERGEABLE, zero unresolved threads. Final documentation-head receipts are linked in the PR description after fresh checks. Recorded source-equivalent required contexts reached terminal success. |
| REVIEW_THREADS_RESOLVED | PASS | Fresh complete thread/review pagination, no unresolved blocker. |
| LIVE_ACCEPTANCE | NOT_RUN | Owner deferred; historical Railway attempts stay blocked. |
| MERGE_READY | PASS | Every mandatory non-live gate PASS, residual risk expressly retained. |

**A separate production deployment review is required.** Code merge-readiness PASS authorizes neither merge nor production deployment and does not reclassify deferred live acceptance as passed. Leave PR #1539 open for owner review.
