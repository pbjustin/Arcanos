# Predictive Self-Healing

## Architecture Overview

Predictive self-healing adds a rules-first layer on top of the existing reactive self-heal loop.

- Background loop:
  - reuses the existing self-heal loop cadence instead of introducing a second scheduler
  - polls metrics every `SELF_HEAL_LOOP_INTERVAL_MS` tick
  - runs predictive decisions only when `PREDICTIVE_HEALING_ENABLED=true`
  - auto-executes only when confidence clears the configured threshold and `AUTO_EXECUTE_HEALING=true`

- Metrics source:
  - rolling request window from `runtimeDiagnosticsService`
  - queue and worker health from `workerControlService`
  - in-process worker runtime state from `workerConfig`
  - process memory from `process.memoryUsage()`
- Decision engine:
  - implemented in `src/services/selfImprove/predictiveHealingService.ts`
  - evaluates rolling trends instead of single snapshots
  - leaves a clean advisor seam for a future ML model by centralizing rule evaluation in one service
- Executors:
  - scale in-process workers up
  - recycle a local in-process worker
  - restart the worker runtime through `healWorkerRuntime`
  - activate prompt-route mitigation to preempt hard failure
  - refuse unsupported traffic-shift actions explicitly
- Surfaces:
  - `POST /api/self-heal/decide`
  - `GET /status/safety`
  - `GET /status/safety/self-heal`

## Config / Env Vars

The predictive layer is off by default and should be rolled out in dry-run first.

- `PREDICTIVE_HEALING_ENABLED`
- `PREDICTIVE_HEALING_DRY_RUN`
- `AUTO_EXECUTE_HEALING`
- `PREDICTIVE_DRY_RUN`
  - alias for `PREDICTIVE_HEALING_DRY_RUN`
- `PREDICTIVE_AUTO_EXECUTE`
  - alias for `AUTO_EXECUTE_HEALING`
- `PREDICTIVE_HEALING_WINDOW_MS`
- `PREDICTIVE_HEALING_MIN_OBSERVATIONS`
- `PREDICTIVE_HEALING_STALE_AFTER_MS`
- `PREDICTIVE_HEALING_MIN_CONFIDENCE`
- `PREDICTIVE_AUTO_EXECUTE_CONFIDENCE_THRESHOLD`
  - alias for `PREDICTIVE_HEALING_MIN_CONFIDENCE`
- `PREDICTIVE_HEALING_ACTION_COOLDOWN_MS`
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

1. Enable `PREDICTIVE_HEALING_ENABLED=true` with `PREDICTIVE_DRY_RUN=true` and `PREDICTIVE_AUTO_EXECUTE=false`.
2. Watch `GET /status/safety/self-heal` for `predictiveHealing.recentAudits`.
3. Exercise `POST /api/self-heal/decide` with `simulate` payloads to validate rule behavior.
4. Tune thresholds until dry-run recommendations are stable.
5. Enable `PREDICTIVE_AUTO_EXECUTE=true` only after reviewing cooldown behavior and audit logs.

## Example Request

```json
POST /api/self-heal/decide
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
