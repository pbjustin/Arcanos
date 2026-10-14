# Predictive Self-Healing

## Architecture Overview

Predictive self-healing adds a rules-first layer on top of the existing reactive self-heal loop.

The dedicated `jobRunner` production entry point owns the canonical
`selfHealingLoop` scheduler after database, autonomy and module initialization
and the all-consumer readiness barrier. Successful scheduler installation
precedes its ready sentinel. The explicit web role suppresses automatic startup
and interval ticks; the direct/local server lifecycle remains supported. The
legacy `controlLoop` scheduler is retired, and Trinity V2 does not install a
second scheduler. Repeated initialization is idempotent, concurrent ticks do not
overlap, and shutdown aborts and drains active evaluation before dependencies
stop. A failed scheduler installation fails bootstrap; a failed later evaluation
is reported independently of queue processing. See
[process ownership](ARCHITECTURE.md#self-healing-process-ownership).

Mitigation state is process-local. This boundary does not establish delivery
between a dedicated Worker and web service or across replicas. Automatic effects
require enabled daemon mode, configured and effective autonomy at least 3, and
both freeze controls false. The production Trinity failure and prompt-timeout
consumers also consult the effective shared kill switch before automatic
activation. Explicit commands retain their caller scopes and applicable server
feature gates. No missing flag or selected actuator grants autonomous execution.

Dispatched reactive failures consume the same cooldown and bounded
per-diagnosis attempt budget as successful dispatches. Rejected worker-repair
preflight does not consume an actuator attempt. Trinity and provider recovery
verification pins the affected consumer route from the failure baseline and
requires the configured verification sample threshold (three by default) from
strictly later request completions on that route. Health checks, unrelated
traffic, unknown route attribution, and empty or stale windows cannot establish
recovery. Insufficient evidence expires at the existing incident-window limit,
records failure and ineffective-action cooldown, and releases verification
ownership. Improved Trinity verification also requires the active command's
matching-generation consumer success threshold; diagnostic pings on a consumer
route do not supply those receipts. Provider reload recovery additionally
requires sufficient fresh `openai.resilience.success` receipts from the existing
bounded telemetry buffer, excluding cached replies and the reload receipt itself.
Worker repairs additionally require an observed improvement in
worker runtime activity, health, or stalled jobs; healthy HTTP traffic alone
cannot close an unchanged worker incident. Missing worker inspection is not a
zero-stall observation.

Trinity and prompt-route mitigations carry process-local generation identities.
Consumer outcomes, verification, and rollback reject an older generation after
replacement. Both prompt policies expire after ten minutes, including when no
controller runs; the next state or policy read restores normal execution.
Actual failed Trinity mitigation consumers count toward the existing rollback
budget, while caller cancellation does not. Per-stage failure observations retain
only the samples needed for the configured activation threshold.

- Background loop:
  - reuses the existing self-heal loop cadence instead of introducing a second scheduler
  - polls metrics on `PREDICTIVE_HEALING_INTERVAL_MS` when set, otherwise on the `SELF_HEAL_LOOP_INTERVAL_MS` cadence
  - evaluates predictive decisions on each loop tick and reports whether predictive healing is enabled
  - permits predictive actuation only with the common execution policy, `PREDICTIVE_HEALING_ENABLED=true`, and `PREDICTIVE_HEALING_DRY_RUN=false`
  - auto-executes only when confidence clears the configured threshold and `PREDICTIVE_AUTO_EXECUTE=true`; authorization is checked again after asynchronous diagnosis

- Metrics source:
  - rolling request window from `runtimeDiagnosticsService`
  - queue and worker health from `workerControlService`
  - in-process worker runtime state from `workerConfig`
  - process memory from `process.memoryUsage()`
- Decision engine:
  - implemented in `src/services/selfImprove/predictiveHealingService.ts`
  - evaluates rolling trends instead of single snapshots
  - builds deterministic rule candidates, then asks the bounded `ARCANOS:CORE` advisor to choose among them
  - falls back to the rules decision when the AI provider is unavailable, unhealthy, in cooldown, or returns invalid output
- Coordinator approval boundary:
  - when prediction is enabled, its disposition owns that loop tick; a refusal, unsupported action, cooldown, recommendation-only result, dry run, or deterministic fallback cannot authorize a different reactive action or the automatic self-improvement controller
  - a confirmed predictive action is recorded only when prediction is enabled and execution reports a coherent live mode, `attempted: true`, and `status: executed`, without a second reactive dispatch
  - a failed, attempted, or automatic/operator execution result with no confirmed completion blocks reactive retry because partial side effects are uncertain
  - a rejected predictive call fails closed while prediction is enabled because its execution phase is unknown; when prediction was explicitly disabled before the call, automatic execution was impossible and the legacy reactive/controller gates remain available
  - a due successful verification rollback owns and ends its loop tick before predictive execution is requested; prediction resumes on a later tick, so rollback and predictive actuation cannot overlap or hide one another in accounting
  - when prediction is explicitly disabled and returns a passive `recommend_only` result, the older reactive action and automatic controller retain their existing independent gates
  - manual self-improve runs and direct `POST /api/self-heal/decide` execution retain their existing caller scopes and server feature gates; this coordinator policy does not replace those owners or create a new human-approval token
  - the one-shot debug heal override is available only in development and test environments and cannot retry an uncertain or completed predictive execution
- Executors:
  - reinitialize the provider in the current process
  - scale, recycle or restart the separate in-process listener runtime only where that runtime is actually owned; these controls are unavailable in the dedicated Worker
  - use the existing remote worker-helper actuator only for its supported runtime with exact target validation and fresh action-matched operator approval
  - activate bounded Trinity mitigation for consumers in the current process
  - activate prompt-route mitigation only in a process that owns the HTTP consumer; the dedicated Worker rejects this action
  - refuse unsupported traffic-shift actions explicitly
- Surfaces:
  - `POST /api/self-heal/decide`
  - `GET /api/self-heal/runtime`
  - `GET /api/self-heal/events`
  - `GET /api/self-heal/inspection`
  - `GET /api/self-heal/provider-health`
  - `GET /status/safety`
  - `GET /status/safety/self-heal`

The direct `/api/self-heal/*` and `/api/self-improve/*` namespaces and detailed
`GET /status/safety/self-heal` are control-plane authenticated. Requests need
the purpose-bound control-plane bearer and operator principal.
Passive diagnostics require `arcanos:read`; an active provider probe adds
`self-heal:probe`; predictive decisions require `self-heal:decide`; and a
request with `execute: true` adds `self-heal:execute`. The decision route also
retains the `self_improve_admin` agent-capability or automation check as a
secondary compatibility prerequisite. Its caller-selected agent ID is not
identity-bound authorization. The `source` request field remains a descriptive
label and is not caller identity. Manual self-improve runs require both
`self-heal:decide` and `self-heal:execute`; freeze, unfreeze, and autonomy
changes require `self-improve:control`.

Simulation is never an actuator input: a request containing `simulate` must set
`dryRun: true` and must not set `execute: true`. Live HTTP execution also
requires `PREDICTIVE_HEALING_ENABLED=true` and
`PREDICTIVE_HEALING_DRY_RUN=false`; request overrides cannot weaken those
server-side guards.

### Native PR preview approval contract

The contained Railway PR web preview exposes the sealed, effect-free
`POST /self-heal/approval-contract` component contract. Its six fixed selectors
exercise the same pure approval functions used by `selfHealingLoop`: denied
predictive outcomes, coherent completed execution, incoherent completed
execution, explicitly disabled legacy authorization, manual-controller
independence, and production debug-override denial. Caller input selects only a
fixture name; it cannot supply an action, target, execution disposition, runtime
configuration, or credential. Responses state that provider, database, memory,
worker, outbound-network, and effects boundaries were not reached.

When the exact-revision hosted verifier is actually run successfully, this
provides component E2E evidence from Railway preview HTTPS ingress through the
contained application and production approval-policy component. The fixture's
presence alone is static implementation evidence. It is not a
normal-runtime self-heal tick, provider decision, actuator, database, worker, or
live-memory test. The normal `/api/self-heal/*` and `/api/self-improve/*` routes
remain unavailable in the native preview, and the worker preview remains
health-only.

## Config / Env Vars

The predictive layer is off by default. The
[effective configuration matrix](CONFIGURATION.md#self-healing-coordinator-and-execution-policy)
defines defaults, alias precedence and authorization for observation,
recommendations, local effects and privileged repair. Missing or malformed
predictive dry-run values retain dry-run. A request cannot override server
dry-run, freeze, disabled execution or insufficient autonomy.

- `PREDICTIVE_HEALING_ENABLED`
- `PREDICTIVE_HEALING_DRY_RUN`
- `PREDICTIVE_DRY_RUN`
  - alias for `PREDICTIVE_HEALING_DRY_RUN`
- `PREDICTIVE_AUTO_EXECUTE`
- `AUTO_EXECUTE_HEALING`
  - alias for `PREDICTIVE_AUTO_EXECUTE`
- `PREDICTIVE_HEALING_INTERVAL_MS`
  - falls back to `SELF_HEAL_LOOP_INTERVAL_MS`, then 30 seconds
- `PREDICTIVE_HEALING_WINDOW_MS`
- `PREDICTIVE_HEALING_MIN_OBSERVATIONS`
- `PREDICTIVE_HEALING_STALE_AFTER_MS`
- `PREDICTIVE_HEALING_MIN_CONFIDENCE`
- `PREDICTIVE_AUTO_EXECUTE_CONFIDENCE_THRESHOLD`
  - alias for `PREDICTIVE_HEALING_MIN_CONFIDENCE`
- `PREDICTIVE_HEALING_COOLDOWN_MS`
- `PREDICTIVE_HEALING_ACTION_COOLDOWN_MS`
  - alias for `PREDICTIVE_HEALING_COOLDOWN_MS`
- `PREDICTIVE_HEALING_AI_IDLE_COOLDOWN_MS`
- `PREDICTIVE_HEALING_AI_ACTIVE_COOLDOWN_MS`
- `PREDICTIVE_HEALING_AI_FAILURE_COOLDOWN_MS`
- `PREDICTIVE_HEALING_OBSERVATION_HISTORY_LIMIT`
- `PREDICTIVE_HEALING_AUDIT_HISTORY_LIMIT`
- `PREDICTIVE_ERROR_RATE_THRESHOLD`
- `PREDICTIVE_LATENCY_CONSECUTIVE_INTERVALS`
- `PREDICTIVE_LATENCY_RISE_DELTA_MS`
- `PREDICTIVE_MEMORY_THRESHOLD_MB`
- `PREDICTIVE_MEMORY_GROWTH_THRESHOLD_MB`
- `PREDICTIVE_MEMORY_SUSTAINED_INTERVALS`
- `PREDICTIVE_QUEUE_PENDING_THRESHOLD`
- `PREDICTIVE_QUEUE_VELOCITY_THRESHOLD`
- `PREDICTIVE_SCALE_UP_STEP`
- `PREDICTIVE_SCALE_UP_MAX_EXTRA_WORKERS`
- `ARCANOS_WORKER_HELPER_TOKEN`
  - required on both caller and target when the selected repair mode is `remote_worker_helper`
  - must satisfy the strict purpose-bound 32–4096 character worker-control credential contract
- `SELF_HEAL_WORKER_SERVICE_URL`
  - preferred exact remote worker-helper origin
- `WORKER_HELPER_BASE_URL`, `RAILWAY_SERVICE_ARCANOS_WORKER_URL`, and
  `ARCANOS_WORKER_PUBLIC_URL`
  - compatibility origin aliases; every configured URL alias must normalize to the same exact origin

## Remote Worker Repair Boundary

The dedicated database-backed Worker rejects this actuator because it controls
the separate EventEmitter listener runtime, not `jobRunner`. Selecting a remote
mode does not turn it into a dedicated Worker restart mechanism. No new remote
executor or Railway deployment capability is introduced.

The public `worker-helper status` command remains credential-free. Remote repair
is different: the actuator is available only when it resolves one valid
credentialed target. Every configured URL alias must be an explicit exact HTTPS
origin without user information, path, query, or fragment; an exact HTTP origin
is accepted only for loopback. Missing worker-helper credentials and invalid or
conflicting URL aliases make the remote actuator unavailable.

Configure the identical `ARCANOS_WORKER_HELPER_TOKEN` on the calling process and
target service. The actuator re-resolves the strict, collision-free token
immediately before fetch, sends it only through
`x-arcanos-worker-helper-token`, and rejects redirects. There is no outbound
Authorization carrier.

Remote success data is capped at 64 KiB and must be JSON with a matching
`requestedForce` value and a valid restart object. The actuator returns only
`requestedForce`, `restart.started`, `restart.alreadyRunning`,
`restart.runWorkers`, and a locally generated `restart.message`. The bounded
target-controlled message is validated as part of the response contract but
discarded, so arbitrary remote text and fields cannot enter logs or telemetry.

## Action and Process Ownership

Every coordinator effect requires the common execution policy above. Predictive
execution adds its enabled/dry-run/automatic gates, and privileged repair retains
its separate operator approval. Detection windows and mitigation identities
belong to the observing process unless a row explicitly names the shared ledger.

| Action | Detection and target owner | Application and authorization | Recovery evidence | Rollback or expiry |
| --- | --- | --- | --- | --- |
| Provider reinitialization | Local telemetry; provider client in the same process | Existing provider reload after common policy checks | Fresh affected-route completions plus fresh provider success receipts; reload receipt alone is insufficient | Bounded verification and ineffective-action cooldown; no claim of another process's recovery |
| Trinity V2 mitigation | Local stage failures; same-process Trinity consumers, including queued Worker jobs | Identity-fenced bounded command; production automatic consumers also check effective freeze/autonomy | Matching-generation consumer successes and fresh post-action affected-route completions | Existing TTL, failed-consumer budget and identity-fenced rollback |
| Prompt short-answer or direct-answer policy, including predictive `mark_node_degraded` | Local prompt telemetry; HTTP prompt consumer in that process | Local policy command; dedicated Worker returns `cross_process_prompt_route_unavailable` | Fresh post-action prompt completions for the active mitigation | Ten-minute TTL and identity-fenced rollback; old verification cannot clear a replacement |
| Stale-job recovery | Shared PostgreSQL queue/lease evidence; durable job ledger | Existing `recoverStaleJobs` recovery under common policy and lease/ownership fences | Actual queue/runtime improvement; missing inspection and healthy HTTP alone are insufficient | Existing retry/dead-letter and ownership rules; no arbitrary process restart |
| Scale, recycle or heal listener runtime | Local listener health; separate EventEmitter worker runtime | Existing listener controls only in a compatible owning runtime; unavailable in dedicated `jobRunner` | Bounded receipts plus observed runtime improvement | Existing bounded recovery/cooldown; no substitution with Railway restart |
| Remote helper or privileged repair | Supported runtime and exact approved target | Existing purpose-bound target/credential validation plus unexpired action-matched operator approval; unavailable from the dedicated Worker helper path | Bounded validated receipt and fresh target improvement | Existing approval expiry and cooldown; no unrestricted remote command |
| Traffic shift or cross-service prompt/Trinity delivery | No supported target control channel | Unavailable; local memory changes cannot report cross-service success | No success claimed | No action applied |
| Existing proposal/rollback fallback | Local drift; existing reflection/evidence stores and shared kill switch | Canonical automatic policy plus the controller's own controls; daemon mode does not create a PR. Cancellation prevents later stages after an awaited operation. | Proposal/evidence output is not runtime recovery proof | Freeze remains governed by the kill switch; no automatic unfreeze, code rollout or production restart |

The Worker initializes the existing shared Redis lifecycle before coordinator
startup. Configured Redis unavailability restricts effective controls to frozen
and autonomy 0; it does not add a dependency gate to queue readiness. Healthy
jobs, heartbeats or HTTP responses do not establish cross-process healing.

## Decision Rules V1

- Error rate above threshold:
  - recommend or execute `heal_worker_runtime`
- Latency rising for consecutive intervals:
  - recommend or execute `scale_workers_up`
- Memory high and still growing:
  - recommend or execute `recycle_worker_runtime`
- Queue backlog growing faster than workers drain it:
  - recommend or execute `scale_workers_up`
- Single unhealthy worker with spare capacity:
  - recommend `recycle_worker`
- Prompt route trending degraded before failure:
  - recommend `mark_node_degraded`
- AI provider unavailable or unhealthy:
  - recommend or execute `reinitialize_ai_provider`
- Trinity stages repeatedly timing out or failing:
  - recommend or execute `activate_trinity_mitigation`

The engine prefers the smallest safe action first, refuses stale data, and blocks low-confidence actions.

## Audit Logging

Structured lifecycle events distinguish `self_heal.coordinator.started`,
`self_heal.coordinator.disabled`, `self_heal.coordinator.start_failed`,
`self_heal.coordinator.stopped` and `self_heal.coordinator.tick_failed`. Metadata
includes bounded role, mode, interval, state/reason and validated deployment
identity where available; credentials, complete environment values and payloads
are excluded. Authenticated runtime inspection separately exposes coordinator
`RUNNING`, `DISABLED`, `BLOCKED`, `FAILED` or `UNKNOWN`, scheduling and observation
timestamps. `RUNNING` establishes scheduler ownership, not successful recovery
or permission to actuate; `operatingMode` and `policyObservedAt` describe the
last observed execution policy. Web inspection reports remote coordinator state
as `UNKNOWN` rather than inferring it from Worker health.
Action-executed events identify `effectScope` as `current_process`,
`shared_job_queue` for stale-job recovery, or `actuator_reported_target` for
worker-repair operations; the last label requires the actuator's target receipt
and does not itself prove that target recovered.

Every predictive evaluation stores:

- input observation snapshot
- derived trends
- chosen rule and action
- confidence
- execution mode
- execution result
- recovery outcome summary
- compact execution log entries in `/status/safety/self-heal` under `predictiveHealing.recentExecutionLog`

Actionable predictive decisions are also mirrored into the existing self-heal telemetry event stream.

## Rollout Plan

Deployment and live acceptance require separate owner authorization. This
repair's live acceptance is **NOT_RUN** and production promotion is
**NOT_AUTHORIZED**. Before an authorized rollout, verify exact source/toolchain,
service roles, effective flag provenance, shared safety-store access and existing
deployment holds. Confirm the Worker coordinator lifecycle and observation
evidence independently of queue readiness. Process-local effects require a
consumer in that same process; the blocked cross-service actions remain blocked.

For a separately approved predictive rollout:

1. Enable `PREDICTIVE_HEALING_ENABLED=true` with `PREDICTIVE_HEALING_DRY_RUN=true` and `PREDICTIVE_AUTO_EXECUTE=false`.
   While prediction is enabled, recommendation-only and dry-run outcomes do not fall through to a separate reactive action or automatic controller. Set prediction explicitly disabled to retain the legacy reactive policy during a rollback.
2. With the control-plane bearer and `arcanos:read`, watch
   `GET /status/safety/self-heal` for `predictiveHealing.recentAudits`.
3. Grant a bounded operator `self-heal:decide` scope and exercise
   `POST /api/self-heal/decide` with `simulate` payloads to validate rule
   behavior, always with `dryRun: true`. Keep `self-heal:execute` absent during
   this stage.
4. Tune thresholds until dry-run recommendations are stable.
5. Consider execution only after reviewing cooldown behavior, fresh recovery
   evidence and audit logs, with explicit owner authorization for every required
   enabled/daemon/autonomy/dry-run/automatic setting. No step here changes those
   settings automatically.

## Example Request

```http
POST /api/self-heal/decide HTTP/1.1
Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>
X-Agent-Id: <self-improve-admin-agent>
Content-Type: application/json

{
  "dryRun": true,
  "simulate": {
    "avgLatencyMs": 2300,
    "p95LatencyMs": 3200,
    "workerHealth": {
      "pending": 9,
      "running": 2
    }
  }
}
```

## Example Response

```json
{
  "status": "ok",
  "predictiveHealing": {
    "decision": {
      "action": "scale_workers_up",
      "matchedRule": "latency_rising_scale_up",
      "confidence": 0.82
    },
    "execution": {
      "status": "dry_run",
      "mode": "dry_run"
    }
  }
}
```
