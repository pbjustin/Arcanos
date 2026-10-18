# Self-healing inference cost containment — 2026-10-17

## Scope and evidence boundary

This repair preserves the self-healing scheduler, deterministic diagnosis,
predictive advice, incident detection, and authorized repair paths. Work is
limited to source changes, mocked tests, static validation, and read-only
deployment metadata. No production application probes, live Redis tests, paid
inference, credential changes, deployments, or merges were performed.

The owner reported 60 fine-tuned completions and 72,469 tokens during the
October 17, 2026 14:10–14:40 EDT healthy-idle interval. These figures are incident
context supplied by the owner, not newly measured production acceptance.
The owner-revoked OpenAI credential was not tested, replaced, or reactivated.

## Confirmed root cause and execution chain

The baseline and inspected main revision were
`4b961a0df8a700340dcf795a7f41223685211a31`. Three interacting defects allowed
unnecessary diagnosis: inactivity was treated as failure without pending work;
AI selection happened without a predictive-enabled/actionable-incident gate;
and generic provider-health timestamps could replace the recent diagnosis
timestamp used for cooldown. Process-local state also could not coordinate
inference across runtime instances. Execution authorization prevented repairs
in the reported configuration but did not prevent provider calls.

| Stage | Current source reference and repaired behavior |
| --- | --- |
| Scheduler ownership | `src/workers/jobRunner.ts`, `startSelfHealingLoop` bootstrap; `src/services/selfImprove/selfHealingLoop.ts`, `startSelfHealingLoop`. The dedicated Worker installs one coordinator after readiness; explicit web scheduling remains suppressed. |
| Observation and watchdog | `src/services/selfImprove/selfHealingLoop.ts`, `observeSelfHealingRuntime`; `src/services/workerControlService.ts`, `readWatchdogView`. Queue work, activity, heartbeat, and explicit dependency evidence remain distinct. |
| Worker classification | `src/services/workerControlService.ts`, `hasPendingOrStalledQueueWork` and `deriveWorkerOperationalStatus`; `selfHealingLoop.ts`, `diagnoseSelfHealingRuntime`. Old activity alone cannot degrade healthy idle workers, including seven idle slots beside one running job; running-job liveness and explicit dependency failures remain detectable. |
| Predictive candidates | `src/services/selfImprove/predictiveHealingService.ts`, `buildObservationFromSources`, `buildCandidates`, and `evaluatePredictiveHealingRules`. Healthy idle has no worker-repair candidate; stalled work remains actionable. |
| Inference eligibility | `predictiveHealingService.ts`, `resolveAiDecision`. Automatic inference requires enabled prediction, fresh actionable evidence, a credential, and a provider circuit whose existing retry window permits an attempt. Simulations never infer. |
| Provider snapshots | `predictiveHealingService.ts`, `buildAiProviderStatusSnapshot`; `src/services/openai/serviceHealth.ts`, `getOpenAIServiceHealth`. Recent diagnosis timestamps remain monotonic; current authentication blocking is distinguished from historical provider failure. |
| Cooldown and concurrency | `src/services/selfImprove/selfHealingInferenceAdmission.ts`. Atomic shared Redis admission uses Redis time and dedicated diagnosis/probe records, independent of generic provider probes. |
| Fine-tuned Core routing | `predictiveHealingService.ts`, `runArcanosCoreQuery` call; `selfHealingInferenceClient.ts`. Existing Core/model policy and adapter remain in use, with one Responses request, 512 output tokens, zero SDK retries, and no optional memory or side effects. |
| Repair authorization | `predictiveHealingService.ts`, execution policy and action reservation; `selfHealingLoop.ts`, `executeActionPlan`; `src/routes/self-heal.ts`. Existing scopes, feature flags, dry-run, freeze/autonomy, target ownership, approval, and repair budgets remain independent of inference admission. |
| Audit and accounting | `predictiveHealingService.ts`, diagnosis skip/request/result/fallback events and `recordPredictiveTelemetry`; `src/core/adapters/openai.adapter.ts`, `instrumentOpenAIOperation`. Existing usage accounting remains behind the original adapter-bound SDK method. |

The provider-reinitialization path also previously forced a health probe after
local reload, including predictive execution that ignored provider backoff.
Self-heal reloads now suppress probing an unchanged credential/endpoint with a
recorded authentication failure. Authentication history is retained; it does not
permanently block a subsequently changed configuration. No credential is changed
by the repair. Explicit provider-health probes retain separate scope and budget.

## Baseline reproduction

Three new regression cases were run against the original predictive implementation
before its repair. They failed for the intended behavioral reasons:

| Regression | Expected | Baseline result |
| --- | --- | --- |
| Healthy idle with eight workers and old activity | `action: none`, no inference or repair | Worker-heal action selected. |
| Recent diagnosis plus deliberately stale provider snapshot | One provider call across the cooldown window | Two provider calls. |
| Predictive healing disabled | Zero automatic provider calls | One provider call. |

The corrected implementation passes these cases. Tests retain real incident
fixtures for authorized repair and do not turn failing scenarios into idle ones.

## Regression coverage

All named suites below are under `tests/` and use mocks or local synthetic data.
The shared-store fixtures exercise independent coordinator instances and atomic
contention; they do not claim a live Redis deployment was tested.

| Required case | Coverage |
| --- | --- |
| 1. Twenty healthy-idle scheduler ticks | `self-healing-loop.test.ts`; `predictive-healing-execution.test.ts`: zero worker repairs and zero inference. |
| 2. Eight healthy workers, empty queue | `worker-control-service.test.ts`; predictive twenty-tick fixture: healthy classification despite old activity. |
| 3. Stale provider-health timestamp | `predictive-healing-execution.test.ts`: provider snapshot from the previous day cannot reopen admission. |
| 4. Recent diagnosis authoritative | Same regression plus `self-healing-inference-admission.test.ts`: retained timestamp survives coordinator replacement. |
| 5. Repeated authentication failures | Predictive execution/probe tests and `worker-openai-budget-wiring.test.ts`: one failed request, twenty blocked retries/reloads. |
| 6. Revoked or missing key | `self-healing-inference-admission.test.ts`; predictive execution: missing key does not touch the store/provider; revoked identity stays blocked. |
| 7. Predictive healing disabled | Predictive execution and `predictive-self-heal.route.test.ts`: no automatic AI; explicit scoped manual diagnosis remains available. |
| 8. Repair execution disabled | Predictive execution: eligible diagnosis remains available while repair stays unattempted. |
| 9. Genuine stalled jobs | `self-healing-loop.test.ts` stale-job recovery; `predictive-healing-service.test.ts` dedicated-worker stalled candidate; real Core and mocked SDK transport in `self-healing-inference-core.integration.test.ts`. |
| 10. Failed heartbeat with pending jobs | Loop and worker-control tests retain incident classification with zero HTTP requests. |
| 11. Simultaneous diagnosis | Inference admission/client and predictive execution tests admit one provider request and deny duplicate expansion. |
| 12. Cooldown expiry | Admission and predictive execution tests verify active, idle, and failure windows plus a permitted later retry. |
| 13. Recovery to healthy idle | Loop and predictive execution recovery cases retain historical evidence without creating a new idle diagnosis. |
| 14. Multiple runtime instances | Admission tests share one fixture store across instances/restarts, enforce the rolling hourly cap, and verify service-independent Redis keys. |

Additional cases cover invalid timestamps, clock rollback, uncertain atomic
writes, stale reservation completion, unavailable coordination, circuit recovery,
simulation isolation, explicit probe budgets, and preserved operator approvals.
The real Core/adapter/SDK fixture verifies one fine-tuned Responses transport,
11 input plus 7 output tokens accounted as 18 total, and single-attempt 401/503
handling without fallback transport. Native fetch and unrelated effects fail
the fixture if reached.

## Independent review corrections for PR 1557

The review started from `b7ef97ac90cd37fa6ecccdb3117dc0cd3d92b4a1`,
which was still the remote head, against main
`4b961a0df8a700340dcf795a7f41223685211a31`. The PR was draft and mergeable,
with three unresolved CodeRabbit findings. All three were verified:

| Finding | Correction and regression evidence |
| --- | --- |
| A: running-only queues selected idle slots for repair | Both inactivity-specific worker-control checks require pending/stalled backlog. `worker-control-service.test.ts` covers one long-running job with seven idle slots, synthesized and retained watchdog recommendations, pending/stalled work, and genuine dispatcher failures. |
| B: reactive inactivity disagreed with predictive classification | `self-healing-loop.test.ts` runs twenty ticks for empty and running-only queues with prediction enabled and disabled. Every tick remains healthy with no incident, provider attempt or repair; genuine heartbeat/dependency failures remain detectable. `predictive-healing-service.test.ts` separately covers the running-only candidate classifier. |
| C: explicit probes inherited six-hour diagnosis cooldowns | Probe success and settled-failure cooldowns are 60 seconds; the later deadline wins. `predictive-healing-execution.test.ts` verifies rotation recovery, a second authorized attempt, third-attempt budget denial, circuit restrictions and unresolved-reservation blocking. Diagnosis cooldowns remain independent. |

A fresh full CodeRabbit review at `6be53879` identified one further valid
recovery defect: an unbilled `models.list` timeout retained the probe reservation
as if a paid completion had an uncertain outcome. Model-list failures now settle
as failure, or authentication failure for rejected credentials. Mocked recovery
tests verify retry eligibility after 60 seconds without clearing the rolling
budget; paid-request uncertainty continues to retain its reservation.

The subsequent full review at `7f7807a8` identified the corresponding
pre-dispatch timeout case in diagnosis and completion helpers. Before releasing
an unused reservation, the bounded client is now synchronously closed so a late
Core continuation cannot dispatch against that released allowance. Timeout,
abort and exhausted-budget regressions distinguish zero-request failures from
already dispatched or pending paid calls, whose uncertain holds remain intact.

The original failed runs [PR CI](https://github.com/pbjustin/Arcanos/actions/runs/39062649770)
and [CI/CD](https://github.com/pbjustin/Arcanos/actions/runs/39062649796)
reported 943 passing, two failing and 13 skipped suites; 19,431 passing,
two failing and 234 skipped cases. Their two causes were verified independently:

- `trinity-model-policy.e2e.test.ts` had no configured Redis fixture. The exact
  denial was `coordination_unavailable`, so deterministic fallback was correct.
  The repaired test first asserts that denial and zero requests, then supplies
  a synthetic atomic Redis command store while retaining the real coordinator,
  Core, SDK and loopback provider. One explicitly authorized request uses the
  expected model, a 512-output-token cap and 192 accounted tokens. Disabled
  inference, cooldown and healthy idle produce no additional request or repair.
- `redis-operation-boundary.test.ts` had an outdated inventory. The existing
  sixteen operations are rate-limit (2), kill-switch (2), diagnostics (3),
  safety lock (3), safety client (3), telemetry (2) and sealed preview (1).
  Admission adds the ledger/time read and atomic CAS (2). The test now checks
  eighteen calls and both exact new operation identities, rather than only
  increasing the count.

Independent security and reliability review identified and repaired these
additional defects in the admission boundary:

1. Rejected credentials could be forgotten after another rejected rotation.
   Normalized identities are retained in a bounded history; legacy records
   preserve their rejection and saturation denies admission without eviction.
2. A settled socket failure without an HTTP response could clear a reservation
   after a potentially accepted paid request. Ambiguous paid transport failures
   now retain the hold, including server errors whose completion is uncertain.
   Core/SDK and predictive regressions prove a single attempted request and
   continued denial after cooldown and credential change.
3. Credential changes during awaited admission could mismatch the request and
   recorded identity. Both diagnosis and probe paths recheck before transport.
   Client initialization failure before transport safely completes its charged
   reservation instead of leaving an unexplained permanent hold.
4. Recomputing environment scope between Redis read and CAS could target another
   ledger. Each operation binds one key; changed scope withholds admission and
   cannot complete the original reservation.
5. A diagnosis rejection did not block the same key on the independent probe
   path, or vice versa. Admission now reads both same-scope ledgers and checks
   their rejection histories; its CAS validates both snapshots before writing
   only the selected purpose. Tests cover both directions and a sibling rejection
   arriving between read and CAS, while preserving rotation and separate budgets.

The admission tests cover concurrency, lost acknowledgements, malformed state,
clock rollback, stale-token rejection, retained uncertainty and operator
reconciliation that preserves budgets and authentication history. The concrete
[reconciliation procedure](../../../PREDICTIVE_SELF_HEALING.md#reconciling-an-abandoned-reservation)
uses existing token-bound completion and atomic comparison. It adds no reset
endpoint, expiry, credential-management capability or repair authorization.

HTTP scopes, secondary capability checks, server dry-run, freeze/autonomy,
action-bound operator approval, actuator ownership and token accounting retain
their existing controls. Diagnosis and operator probes retain separate durable
budgets, cooldowns and reservations, while both enforce the rejection history
recorded in either ledger. Review did not establish a global denylist
across unrelated provider workflows or live Redis durability.

The three repaired finding suites and their adjacent suites passed 231 tests;
the two original CI regression suites passed 23 tests, and Core/SDK integration
passed four tests. Authorization/security-focused coverage also passed.
These results are offline fixtures. Full-suite and final-head hosted outcomes
are recorded in the PR report, independently of the historical validation below.

Branch protection requires `docs:check`, `All Checks Complete`, an up-to-date
base and resolved conversations. CodeRabbit's 6.38% versus 80% docstring warning
is advisory: its status was successful and it is not a protected required check.
Useful comments now explain backlog semantics, uncertain paid calls, retained
credential identities and ledger binding; boilerplate was not added to chase
that percentage. Draft status and owner merge permission remain separate gates.

## Initial implementation validation at b7ef97ac

Validation used Node `24.18.1` and bundled npm `11.16.0` in the isolated worktree.
Final focused coverage is **32 suites, 493 tests passing**. The aggregate run
passed 492 cases; its remaining assertion needed the newly added failure-cooldown
audit field in the expected shape. That suite then passed all 22 cases on rerun.
It includes predictive, worker/watchdog, coordinator/bootstrap, Trinity,
authorization, operator-approval, rate-limit, security, telemetry, and real-Core
mocked integration suites. No live-provider or production success is implied.

Type checking, ESLint (zero errors, 77 pre-existing warnings), full build, local
`validate:railway`, maintained documentation, local documentation links, and diff
checks passed. Generated indexes are updated together. Initial setup lacked
Prisma's generated type stubs; the repository's existing postinstall stub path
resolved that without database access or dependency changes. An intermediate
health snapshot type mismatch was fixed in its existing fallback constructor.
The full repository Jest sweep, live Redis, PostgreSQL integration, hosted
acceptance, and production checks were not run; relevant mocked suites were used.

## Deployment safety and remaining limits

Read-only Railway metadata contains two different source references:

- Both saved service source pins reference
  `3fd305b37ba410cf21684a8fed7619a1ba180b48`.
- Both current deployment CLI messages identify
  `6330eb9cd2e9449d3df74ed1b60e2559852ac9b1`; deployment `commitHash` is absent.
- Current main is `4b961a0df8a700340dcf795a7f41223685211a31`.
  The CLI-claimed revision to main changes YAML tooling, CI, tests and docs,
  with no changes in the relevant healing/worker/provider implementation.

The saved pin and CLI message do not independently attest to runtime binaries.
Both services have one successful active deployment and one running replica;
effective deployment manifests use the integrity wrapper, `/readyz`, a
300-second healthcheck timeout, and 60-second drain. No pending/staged changes
were observed. Native production GitHub triggers and native PR deployments are
disabled. The repository coordinated-writer hold remains active; the inspected
main workflow skipped deployment. A draft PR without preview opt-in does not
authorize or trigger production promotion.

Shared admission requires every participating runtime to use the same Redis
project/environment namespace and preserve its persistent state. Missing Redis,
invalid state, or failed atomic admission permits deterministic fallback only.
Reservations have no automatic expiry. Uncertain/crashed operations require
reviewed operator reconciliation proving completion and retaining cooldown,
authentication, and hourly-budget evidence; never delete records automatically.
This work does not prove live Redis durability, production token counts after
rollout, or deployed-source identity.

Dedicated Worker predictive recommendations do not gain listener-restart
authority: that actuator remains unsupported there. Existing authorized reactive
stale-job recovery remains available when prediction is disabled. This patch
does not introduce a new cross-service repair engine.

Any future rollout requires separate owner authorization and an approved exact
revision for both Worker and V2. Preserve the active writer hold and all existing
compatibility prerequisites; follow the approved worker-first sequence with
independent readiness, sole-active, and predecessor-removal evidence. Preserve
Redis admission state, credential revocation, and all repair controls.
Rollback requires a captured compatible baseline and protected-result/schema
review; do not guess `HEAD^`, clear admission state, restore the revoked key, or
automatically reintroduce the pre-repair inference loop. No rollout or rollback
has been authorized or executed by this task.
