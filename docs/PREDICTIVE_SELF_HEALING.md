# Predictive Self-Healing

## Architecture Overview

Predictive self-healing adds a rules-first layer on top of the existing reactive self-heal loop.

- Background loop:
  - reuses the existing self-heal loop cadence instead of introducing a second scheduler
  - polls metrics on `PREDICTIVE_HEALING_INTERVAL_MS` when set, otherwise on the `SELF_HEAL_LOOP_INTERVAL_MS` cadence
  - runs predictive decisions only when `PREDICTIVE_HEALING_ENABLED=true`
  - auto-executes only when confidence clears the configured threshold and `PREDICTIVE_AUTO_EXECUTE=true`

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
- Executors:
  - reinitialize the AI provider
  - scale in-process workers up
  - recycle a local in-process worker
  - restart the local worker runtime through `healWorkerRuntime`
  - repair a remote worker runtime through the authenticated worker-helper actuator
  - activate bounded Trinity self-healing mitigation
  - activate prompt-route mitigation to preempt hard failure
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

## Config / Env Vars

The predictive layer is off by default and should be rolled out in dry-run first.

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

1. Enable `PREDICTIVE_HEALING_ENABLED=true` with `PREDICTIVE_HEALING_DRY_RUN=true` and `PREDICTIVE_AUTO_EXECUTE=false`.
2. With the control-plane bearer and `arcanos:read`, watch
   `GET /status/safety/self-heal` for `predictiveHealing.recentAudits`.
3. Grant a bounded operator `self-heal:decide` scope and exercise
   `POST /api/self-heal/decide` with `simulate` payloads to validate rule
   behavior, always with `dryRun: true`. Keep `self-heal:execute` absent during
   this stage.
4. Tune thresholds until dry-run recommendations are stable.
5. Enable `PREDICTIVE_AUTO_EXECUTE=true` only after reviewing cooldown behavior and audit logs.

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
