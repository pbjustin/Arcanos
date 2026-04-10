# Async GPT Job Board Backend Spec

Status: Proposed

Date: 2026-04-10

Scope: Backend and API only. No frontend, dashboard page, React app, or UI component work is included in this spec.

Railway context observed during authoring:
- Project: `Arcanos`
- Environment: `production`
- Web service: `ARCANOS V2`
- Worker service: `ARCANOS Worker`

## Evidence Log

| Hypothesis | Command | Result | Interpretation | Next Step |
| --- | --- | --- | --- | --- |
| ARCANOS production is split into web and worker planes. | `railway whoami` | Authenticated as `pbjustin@gmail.com`. | Railway CLI context is valid. | Target production explicitly. |
| The active environment is production and the project wiring is intact. | `railway environment production` | Production environment activated. | The remaining inspection should use production-scoped data. | Inspect service status and deployments. |
| The current live backend shape includes separate web, worker, Postgres, and Redis services. | `railway status --json` | Returned project and service metadata for `ARCANOS V2`, `ARCANOS Worker`, `Postgres-BTrN`, and `Redis-lQbV`. | The job board must read shared durable state, not in-memory process state. | Inspect recent web and worker deployments. |
| The web plane owns GPT enqueue and GPT read-path routing. | `railway deployment list --service "ARCANOS V2" --environment production --limit 3 --json` | Latest web deployment is healthy. | The web plane is the right home for a read-only job-board API. | Inspect live web logs for job events. |
| The worker plane owns execution, retry, timing, and expiry events. | `railway deployment list --service "ARCANOS Worker" --environment production --limit 3 --json` | Latest worker deployment is healthy. | The worker remains execution-only; the job board should not move there. | Inspect live worker logs. |
| Current GPT read and write signals are already observable in production logs. | `railway logs --service "ARCANOS V2" --environment production --since 30m --lines 300 --json` | Logs include `gpt.request.async_enqueued`, `gpt.request.async_pending`, `gpt.request.result_lookup`, and `/jobs/:id/result` requests. | Read-path versus write-path separation already exists and must be preserved. | Inspect worker lifecycle signals. |
| Worker job lifecycle telemetry is already present. | `railway logs --service "ARCANOS Worker" --environment production --since 30m --lines 300 --json` | Logs include `gpt.job.started`, `gpt.job.completed`, `gpt.job.completed_timing`, and `gpt.job.expired`. | The job board can reuse existing lifecycle event semantics instead of inventing new ones. | Inspect current helper endpoints and metrics. |
| ARCANOS already exposes queue and worker summaries that can seed the job board. | `GET /worker-helper/status` and `GET /worker-helper/health` | Returned queue totals, retry policy, worker snapshots, alerts, and recent failures. | The fastest path is a canonical read-only surface over existing services and repositories. | Define the formal job-board API. |
| Observability primitives already exist for queue depth, latency, and GPT lifecycle events. | `GET /metrics` | Returned `worker_queue_depth`, `worker_queue_latency_ms`, `worker_jobs_total`, `worker_failures_total`, `worker_retries_total`, `gpt_request_events_total`, `gpt_job_events_total`, and `gpt_job_timing_ms`. | The first rollout should extend existing metrics rather than introduce a second observability stack. | Finalize backend-only spec and rollout plan. |

## 1. Executive Summary

ARCANOS already has the critical primitives needed for a real-time async GPT job board:
- async GPT job creation through `POST /gpt/:gptId`
- canonical per-job result retrieval through `GET /jobs/:id/result`
- GPT-route read-only retrieval through `POST /gpt/:gptId` with `action: "get_result"`
- worker-side lifecycle, retry, timing, and expiry signals
- queue and worker summaries via existing helper routes
- Prometheus-compatible metrics

The recommended design is a read-only backend projection over the current durable job and worker state. It should live on the web service, expose canonical `/job-board/*` APIs for operators and internal services, and add explicit read-only `/gpt/:gptId` actions for ChatGPT-style agents that can only reach the GPT route. No frontend is required.

## 2. Current ARCANOS Job Architecture

Current live behavior:
1. `POST /gpt/:gptId` normalizes the incoming GPT request and decides whether the request should use the async job path.
2. For async GPT work, the backend persists a canonical row in `job_data` with idempotency and retention metadata.
3. The route either returns a pending payload quickly or waits briefly for fast completion before returning.
4. The worker service claims `job_type = 'gpt'` rows from the queue and executes them asynchronously.
5. The system stores result or error data back into durable state.
6. Clients retrieve state or results via `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /jobs/:id/stream`, or GPT read-only `action: "get_result"`.

Current live observability:
- Web logs emit `gpt.request.async_enqueued`, `gpt.request.async_pending`, and `gpt.request.result_lookup`.
- Worker logs emit `gpt.job.started`, `gpt.job.completed`, `gpt.job.completed_timing`, retry failure events, cancellation, and expiry.
- Existing helper endpoints expose queue summaries, worker health snapshots, and recent failures.
- Existing metrics already cover queue depth, queue latency, worker totals, retries, failures, GPT request events, GPT job events, and GPT timing.

Current live storage:
- `job_data` is the durable source of truth for async GPT jobs and shared queue entries.
- `worker_runtime_snapshots` is the durable source of truth for worker-slot snapshots and watchdog state.

## 3. Goals and Non-Goals

### Goals

- Expose current async job state for operators, services, and AI agents.
- Expose queue depth, wait times, and backlog aging.
- Expose worker slot health and current ownership.
- Expose retry state, retry exhaustion, terminal failure classification, and expiry semantics.
- Expose result-availability and retrieval metadata without forcing callers to know all HTTP routes.
- Preserve the current async job creation and execution behavior.
- Preserve GPT read-only result lookup semantics and extend that pattern for broader job-board reads.

### Non-Goals

- No frontend, dashboard page, charts, or UI component work.
- No change to worker execution logic, queue semantics, persistence mechanics, or streaming semantics for the existing job APIs.
- No attempt to replace logs with the job board as the system of record.
- No broad authorization redesign beyond defining recommended boundaries.

## 4. Job Board Backend Scope

The backend job board should cover:
- active jobs
- pending jobs
- running jobs
- completed jobs
- failed jobs
- cancelled jobs
- expired jobs
- retained versus purged lifecycle state
- queue depth and oldest pending age
- queue wait and execution timings
- worker slot health and current job ownership
- duplicate-job and dedupe visibility
- result-availability visibility
- retry state and retry exhaustion
- event and log correlation metadata

The backend job board should not cover:
- visual operator dashboards
- browser-specific UX flows
- frontend-rendered charts

## 5. Canonical Data Model

The job board should reuse current durable sources wherever possible.

### 5.1 Source of Truth

| Entity | Canonical Source | Notes |
| --- | --- | --- |
| job state | `job_data` | Includes current status, result, error, retry, retention, idempotency, and timestamps. |
| worker state | `worker_runtime_snapshots` | Includes slot health, watchdog state, current job, and activity timestamps. |
| aggregate queue summary | derived query over `job_data` | Current helper logic already does most of this. |
| board event feed | optional `job_board_events` table | Recommended only after basic snapshot APIs ship. |

### 5.2 Canonical Response Models

#### `JobBoardJobSummary`

```json
{
  "jobId": "uuid",
  "jobType": "gpt",
  "gptId": "arcanos-core",
  "executionStatus": "pending",
  "lifecycleStatus": "active",
  "retryState": "scheduled",
  "retryCount": 1,
  "maxRetries": 2,
  "createdAt": "2026-04-10T20:16:21.489Z",
  "startedAt": "2026-04-10T20:16:21.570Z",
  "completedAt": null,
  "queueWaitMs": 73,
  "executionMs": null,
  "endToEndMs": null,
  "originWorkerId": "api",
  "lastWorkerId": "async-queue-slot-1",
  "resultAvailable": false,
  "deduped": false,
  "dedupeReason": "new_job",
  "requestId": "req_123",
  "traceId": "trace_123"
}
```

#### `JobBoardJobDetail`

```json
{
  "jobId": "uuid",
  "jobType": "gpt",
  "gptId": "arcanos-core",
  "executionStatus": "failed",
  "lifecycleStatus": "retained",
  "retryState": "exhausted",
  "retryCount": 2,
  "maxRetries": 2,
  "createdAt": "2026-04-10T20:16:21.489Z",
  "startedAt": "2026-04-10T20:16:21.570Z",
  "completedAt": "2026-04-10T20:16:45.576Z",
  "queueWaitMs": 73,
  "executionMs": 24048,
  "endToEndMs": 24121,
  "originWorkerId": "api",
  "lastWorkerId": "async-queue-slot-1",
  "resultAvailable": false,
  "deduped": false,
  "error": {
    "family": "authentication",
    "code": "openai_auth_401",
    "message": "Redacted upstream authentication failure."
  },
  "retentionUntil": "2026-04-11T02:16:45.576Z",
  "idempotencyUntil": "2026-04-11T20:16:21.489Z",
  "expiresAt": "2026-04-11T02:16:45.576Z",
  "retrieval": {
    "httpResult": "/jobs/uuid/result",
    "httpStream": "/jobs/uuid/stream",
    "gptReadAction": {
      "action": "get_result",
      "payload": {
        "jobId": "uuid"
      }
    }
  }
}
```

#### `JobBoardQueueSummary`

```json
{
  "scope": "gpt",
  "snapshotAt": "2026-04-10T20:30:00.000Z",
  "pending": 2,
  "running": 1,
  "completedRetained": 14,
  "failedRetained": 3,
  "cancelledRetained": 0,
  "expiredRetained": 1,
  "purgedRecent": 4,
  "delayed": 0,
  "stalledRunning": 0,
  "oldestPendingAgeMs": 4200,
  "waitMsP50": 106,
  "waitMsP95": 636,
  "waitMsP99": 1200,
  "executionMsP50": 24048,
  "executionMsP95": 72555,
  "executionMsP99": 90000,
  "recentCompleted": 4,
  "recentFailed": 0,
  "retryScheduled": 0,
  "retryExhausted": 0
}
```

#### `JobBoardWorkerSnapshot`

```json
{
  "workerId": "async-queue-slot-1",
  "workerType": "async_queue",
  "healthStatus": "degraded",
  "currentJobId": null,
  "lastHeartbeatAt": "2026-04-10T20:16:41.571Z",
  "lastActivityAt": "2026-04-10T20:16:45.593Z",
  "lastProcessedJobAt": "2026-04-10T20:16:45.593Z",
  "inactivityMs": 702774,
  "processedJobs": 2,
  "scheduledRetries": 0,
  "terminalFailures": 0,
  "recoveredJobs": 0,
  "watchdog": {
    "triggered": false,
    "reason": null,
    "restartRecommended": false,
    "idleThresholdMs": 120000
  }
}
```

### 5.3 State Separation

The job board should separate execution state from lifecycle state.

Recommended execution states:
- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`

Recommended lifecycle states:
- `active`
- `retained`
- `expired`
- `purged`
- `not_found`

Recommended retry states:
- `not_applicable`
- `eligible`
- `scheduled`
- `exhausted`
- `terminal_non_retryable`

## 6. Recommended Endpoints

The job board should live under a dedicated read-only route group on the web service.

### 6.1 Endpoint Table

| Endpoint | Purpose | Request Parameters | Response Shape | Read or Write | Polling-Friendly | Streaming | AI-Agent-Friendly |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /job-board/summary` | One bounded operator or service snapshot. | `scope`, `window`, `activeLimit`, `include` | `JobBoardSnapshot` | read-only | yes | via summary stream | yes |
| `GET /job-board/jobs` | Filtered list of jobs. | `scope`, `gptId`, `executionStatus`, `lifecycleStatus`, `workerId`, `updatedSince`, `limit`, `cursor` | paginated `JobBoardJobSummary[]` | read-only | yes | no | yes |
| `GET /job-board/jobs/:id` | Detailed bounded job view without large result payload by default. | `include=correlation,error,retrieval,retry` | `JobBoardJobDetail` | read-only | yes | no | yes |
| `GET /job-board/queue` | Queue-only aggregate summary. | `scope`, `window` | `JobBoardQueueSummary` | read-only | yes | via summary stream | yes |
| `GET /job-board/workers` | Worker and slot health summary. | `health`, `workerType`, `limit` | `JobBoardWorkerSnapshot[]` plus totals | read-only | yes | via summary stream | yes |
| `GET /job-board/failures` | Recent retained failures and grouped reasons. | `scope`, `category`, `retryState`, `limit` | `JobBoardFailureSummary[]` plus grouped counts | read-only | yes | via summary stream | yes |
| `GET /job-board/events` | Recent normalized event feed. | `since`, `cursor`, `jobId`, `workerId`, `eventName`, `limit` | `JobBoardEvent[]` | read-only | yes | no | yes |
| `GET /job-board/stream` | Streaming summary and delta feed. | `scope`, `include`, `heartbeatMs`, `cursor` | SSE events | read-only | no | yes | no |

### 6.2 Route Design Rules

- `scope` should default to `gpt`, not `all`, because the shared queue contains more than GPT jobs.
- `GET /job-board/jobs/:id` should return summary, timings, correlation, error metadata, and retrieval pointers, but not large stored outputs by default.
- The full stored result should remain canonical at `GET /jobs/:id/result` and GPT `action: "get_result"`.
- The job board should reuse current helper logic rather than duplicate queue and worker calculations.

### 6.3 Example Request and Response Payloads

#### Example 1: Queue and worker snapshot

Request:

```http
GET /job-board/summary?scope=gpt&window=1h&activeLimit=10
```

Response:

```json
{
  "snapshotAt": "2026-04-10T20:30:00.000Z",
  "scope": "gpt",
  "queue": {
    "pending": 2,
    "running": 1,
    "completedRetained": 14,
    "failedRetained": 3,
    "expiredRetained": 1,
    "delayed": 0,
    "stalledRunning": 0,
    "oldestPendingAgeMs": 4200,
    "waitMsP50": 106,
    "waitMsP95": 636,
    "waitMsP99": 1200,
    "executionMsP50": 24048,
    "executionMsP95": 72555,
    "executionMsP99": 90000,
    "recentCompleted": 4,
    "recentFailed": 0,
    "retryScheduled": 0,
    "retryExhausted": 0,
    "lastUpdatedAt": "2026-04-10T20:16:45.576Z"
  },
  "workers": {
    "total": 8,
    "healthy": 7,
    "degraded": 1,
    "unhealthy": 0,
    "offline": 0
  },
  "recentFailures": [],
  "activeJobs": [
    {
      "jobId": "ac021f69-9bc4-4e5a-9186-36f0048ed03f",
      "gptId": "arcanos-core",
      "executionStatus": "running",
      "lifecycleStatus": "active",
      "resultAvailable": false
    }
  ]
}
```

#### Example 2: Single job detail

Request:

```http
GET /job-board/jobs/ac021f69-9bc4-4e5a-9186-36f0048ed03f?include=correlation,retrieval,retry
```

Response:

```json
{
  "jobId": "ac021f69-9bc4-4e5a-9186-36f0048ed03f",
  "jobType": "gpt",
  "gptId": "arcanos-core",
  "executionStatus": "completed",
  "lifecycleStatus": "retained",
  "retryState": "not_applicable",
  "retryCount": 0,
  "maxRetries": 2,
  "createdAt": "2026-04-10T20:16:21.489Z",
  "startedAt": "2026-04-10T20:16:21.570Z",
  "completedAt": "2026-04-10T20:16:45.576Z",
  "queueWaitMs": 73,
  "executionMs": 24048,
  "endToEndMs": 24121,
  "originWorkerId": "api",
  "lastWorkerId": "async-queue-slot-1",
  "resultAvailable": true,
  "deduped": false,
  "dedupeReason": "new_job",
  "error": null,
  "retrieval": {
    "httpResult": "/jobs/ac021f69-9bc4-4e5a-9186-36f0048ed03f/result",
    "httpStream": "/jobs/ac021f69-9bc4-4e5a-9186-36f0048ed03f/stream",
    "gptReadAction": {
      "action": "get_result",
      "payload": {
        "jobId": "ac021f69-9bc4-4e5a-9186-36f0048ed03f"
      }
    }
  }
}
```

#### Example 3: Worker health view

Request:

```http
GET /job-board/workers?health=degraded
```

Response:

```json
{
  "snapshotAt": "2026-04-10T20:30:00.000Z",
  "overallStatus": "degraded",
  "retryPolicy": {
    "defaultMaxRetries": 2,
    "retryBackoffBaseMs": 2000,
    "retryBackoffMaxMs": 60000,
    "staleAfterMs": 60000,
    "watchdogIdleMs": 120000
  },
  "workers": [
    {
      "workerId": "async-queue-slot-1",
      "workerType": "async_queue",
      "healthStatus": "degraded",
      "currentJobId": null,
      "lastHeartbeatAt": "2026-04-10T20:16:41.571Z",
      "lastActivityAt": "2026-04-10T20:16:45.593Z",
      "lastProcessedJobAt": "2026-04-10T20:16:45.593Z",
      "inactivityMs": 702774,
      "processedJobs": 2,
      "scheduledRetries": 0,
      "terminalFailures": 0,
      "recoveredJobs": 0,
      "watchdog": {
        "triggered": false,
        "reason": null,
        "restartRecommended": false,
        "idleThresholdMs": 120000
      }
    }
  ]
}
```

## 7. Real-Time Update Model

Recommended model: hybrid polling plus SSE.

Why:
- Polling already matches the existing `/jobs/:id`, `/jobs/:id/result`, and `/jobs/:id/stream` mental model.
- ChatGPT-style agents on `/gpt/:gptId` need bounded request-response reads, not sockets.
- ARCANOS already supports SSE for per-job streaming, so extending to summary streaming is low-friction.
- Railway is a good fit for standard HTTP and SSE without forcing a bidirectional socket architecture.

Recommendation:
- Make polling the canonical contract for all `/job-board/*` endpoints.
- Add `GET /job-board/stream` as an SSE summary feed only after snapshot APIs are stable.
- Do not make WebSocket support a first-phase requirement.

## 8. Retrieval Model for ChatGPT and Other AI Agents

This is the critical compatibility requirement. ChatGPT-style callers that only have access to `POST /gpt/:gptId` need bounded read-only actions that bypass async generation and return machine-readable payloads directly.

### 8.1 Recommended GPT Read Actions

| GPT Action | Purpose | Payload | Response |
| --- | --- | --- | --- |
| `get_result` | Existing full per-job result lookup. | `jobId` | current canonical stored result payload |
| `get_job_status` | One job detail lookup without large output by default. | `jobId`, `include` | `JobBoardJobDetail` |
| `get_job_board_snapshot` | One bounded board snapshot for queue, workers, active jobs, and recent failures. | `scope`, `window`, `activeLimit`, `include` | `JobBoardSnapshot` |
| `get_queue_status` | Queue-only summary. | `scope`, `window` | `JobBoardQueueSummary` |
| `get_worker_status` | Worker summary or filtered subset. | `health`, `limit`, `workerId` | worker summary payload |
| `get_recent_failures` | Recent retained failures and grouped reasons. | `scope`, `category`, `limit` | failure summary payload |

### 8.2 GPT Read-Action Rules

- Every read action must bypass normal async generation.
- No read action may enqueue a new job.
- Every read action should return deterministic JSON.
- Every read action should emit an explicit read-path log event.
- Every read action should reuse shared lookup helpers where possible.
- Validation failures should be machine-readable and not silently fall through to normal GPT generation.

### 8.3 Example `/gpt/:gptId` Read-Action Payloads

#### Example 1: Job board snapshot

```http
POST /gpt/arcanos-core
Content-Type: application/json

{
  "action": "get_job_board_snapshot",
  "payload": {
    "scope": "gpt",
    "window": "1h",
    "activeLimit": 10,
    "include": ["queue", "workers", "recentFailures"]
  }
}
```

#### Example 2: Specific job status

```http
POST /gpt/arcanos-core
Content-Type: application/json

{
  "action": "get_job_status",
  "payload": {
    "jobId": "ac021f69-9bc4-4e5a-9186-36f0048ed03f",
    "include": ["correlation", "retrieval", "retry"]
  }
}
```

#### Example 3: Queue status

```http
POST /gpt/arcanos-core
Content-Type: application/json

{
  "action": "get_queue_status",
  "payload": {
    "scope": "gpt",
    "window": "15m"
  }
}
```

### 8.4 Recommended GPT Response Envelope

```json
{
  "ok": true,
  "result": {
    "scope": "gpt",
    "snapshotAt": "2026-04-10T20:30:00.000Z"
  },
  "_route": {
    "requestId": "req_123",
    "gptId": "arcanos-core",
    "action": "get_job_board_snapshot",
    "route": "job_board",
    "timestamp": "2026-04-10T20:30:00.000Z"
  }
}
```

## 9. Logging and Event Contract

The job board should use structured event names and stable fields across web and worker logs.

### 9.1 Event Names

- `gpt.request.async_enqueued`
- `gpt.request.async_pending`
- `gpt.request.result_lookup`
- `gpt.request.job_status_lookup`
- `gpt.request.job_board_snapshot`
- `gpt.request.queue_status`
- `gpt.request.worker_status`
- `gpt.request.recent_failures`
- `gpt.job.started`
- `gpt.job.completed`
- `gpt.job.completed_timing`
- `gpt.job.retryable_failure`
- `gpt.job.non_retryable_failure`
- `gpt.job.cancelled`
- `gpt.job.expired`
- `job_board.request.summary`
- `job_board.request.jobs`
- `job_board.request.job_detail`
- `job_board.request.queue`
- `job_board.request.workers`
- `job_board.request.failures`
- `job_board.request.events`

### 9.2 Required Structured Fields

Every board-related event should carry as many of the following fields as are relevant:
- `requestId`
- `traceId`
- `jobId`
- `jobType`
- `gptId`
- `route`
- `action`
- `workerId`
- `executionStatus`
- `lifecycleStatus`
- `retryState`
- `retryCount`
- `maxRetries`
- `enqueueTime`
- `startTime`
- `completionTime`
- `queueWaitMs`
- `executionMs`
- `endToEndMs`
- `terminalClassification`
- `errorFamily`
- `errorCode`
- `resultAvailable`
- `retentionUntil`
- `expiresAt`
- `deduped`
- `dedupeReason`

### 9.3 Logging Rules

- Read-only lookups must never emit `gpt.request.async_enqueued`.
- Error messages must be redacted before surfacing in job-board API responses.
- Log lines should remain deterministic JSON for backend consumption.

## 10. Metrics and Alerting

### 10.1 Reuse Existing Metrics First

Existing metrics already present in production:
- `worker_queue_depth`
- `worker_queue_latency_ms`
- `worker_jobs_total`
- `worker_failures_total`
- `worker_retries_total`
- `gpt_request_events_total`
- `gpt_job_events_total`
- `gpt_job_timing_ms`

### 10.2 Recommended Additional Metrics

- `job_board_reads_total{surface,resource,outcome}`
- `job_board_snapshot_duration_ms{resource}`
- `gpt_read_actions_total{action,outcome}`
- `job_board_stream_clients`
- `job_board_scope_totals{scope,status}`

### 10.3 Recommended Alerts

- queue depth backlog beyond expected threshold
- oldest pending age above service-level target
- retry exhaustion rate spike
- worker unhealthy or offline count above zero
- repeated result-lookup failures
- read-only lookup accidentally emitting enqueue events
- mismatch between queue totals and worker totals beyond a small reconciliation window

## 11. Storage and Retention Semantics

Current lifecycle defaults already distinguish different retention horizons. The job board should present those clearly instead of collapsing them into a single opaque status.

Recommended presentation model:
- `executionStatus` reports the last execution outcome.
- `lifecycleStatus` reports whether the row is active, retained, expired, purged, or missing.
- `resultAvailable` reports whether a result can still be retrieved.

Recommended lifecycle semantics:
- `pending` and `running` are active execution states.
- `completed`, `failed`, and `cancelled` may still be `retained`.
- `expired` means the retained lifecycle window has passed even if the last execution state was terminal.
- `purged` means the durable row is no longer available and only aggregate counters or event history may remain.

Important recommendation:
- Preserve the last terminal execution outcome separately from the current lifecycle state so that an expired row does not lose the fact that it previously completed or failed.

## 12. Worker and Queue Visibility

The job board should surface:
- total worker count
- healthy, degraded, unhealthy, and offline workers
- current job ownership by worker
- last heartbeat and last activity timestamps
- processed job counters
- scheduled retry counters
- recent recovery counters
- watchdog status

The queue view should surface:
- pending count
- running count
- delayed count
- stalled running count
- oldest pending age
- recent completed count
- recent failed count
- retry scheduled count
- retry exhausted count
- timing percentiles

Operator flow should be:
1. check `GET /job-board/summary`
2. drill into `GET /job-board/jobs/:id` or `GET /job-board/failures`
3. inspect `GET /job-board/workers`
4. correlate `jobId`, `requestId`, `traceId`, and `workerId` in Railway logs

## 13. Failure, Retry, and Expired Job Handling

The job board should classify failures and retries explicitly.

Recommended failure families:
- `authentication`
- `validation`
- `provider`
- `network`
- `timeout`
- `rate_limited`
- `unknown`

Recommended terminal classifications:
- `completed`
- `cancelled_by_request`
- `cancelled_by_system`
- `retry_exhausted`
- `non_retryable_failure`
- `expired_before_completion`
- `expired_after_retention`

Expired jobs should still expose:
- last known execution outcome
- retention boundary timestamps
- whether result data is still retrievable

Recent failures should clearly distinguish:
- still-retryable failures
- retry-scheduled rows
- retry-exhausted rows
- retained terminal failures

## 14. Security, Auth, and Access Boundaries

- `/job-board/*` should require operator or service authorization.
- GPT read actions should follow the existing GPT auth boundary and action allow-list.
- Large result payloads should stay behind the canonical result retrieval path.
- Summary APIs should default to bounded payloads and redacted error content.
- Internal correlation identifiers should remain available to operators and internal services, but not necessarily to anonymous callers.
- Read-only routes must not mutate queue state, retry state, or worker state.

## 15. Railway Deployment Considerations

- Keep the job board on `ARCANOS V2`, not on `ARCANOS Worker`.
- Use Postgres-backed state and persisted worker snapshots as the source of truth.
- Treat Railway logs as a validation and forensic source, not as the primary board data source.
- Reuse existing `/metrics` exposure and do not create a second metrics surface.
- Use SSE only for optional summary streaming; do not make the board dependent on long-lived bidirectional socket state.

## 16. Incremental Rollout Plan

### 16.1 Recommended Minimal First Implementation Plan

1. Add a `jobBoardService` that composes existing queue, job-detail, worker-health, and failure-summary readers.
2. Add read-only endpoints:
   - `GET /job-board/summary`
   - `GET /job-board/jobs/:id`
   - `GET /job-board/workers`
   - `GET /job-board/failures`
3. Add GPT read-only actions:
   - `get_job_board_snapshot`
   - `get_job_status`
   - `get_worker_status`
4. Add structured read-path logs and board-read metrics.

### 16.2 Recommended Later Expansion Plan

1. Add `GET /job-board/jobs` with filtering and cursor pagination.
2. Add `GET /job-board/queue`.
3. Add `get_queue_status` and `get_recent_failures` GPT read actions.
4. Add `GET /job-board/events` backed by an optional `job_board_events` table.
5. Add `GET /job-board/stream` SSE summary streaming.
6. Preserve explicit final execution outcome for expired and purged lifecycle views.

## 17. Validation Plan

### 17.1 Railway CLI Commands Used for Inspection

```text
railway whoami
railway environment production
railway status --json
railway deployment list --service "ARCANOS V2" --environment production --limit 3 --json
railway deployment list --service "ARCANOS Worker" --environment production --limit 3 --json
railway logs --service "ARCANOS V2" --environment production --since 30m --lines 300 --json
railway logs --service "ARCANOS Worker" --environment production --since 30m --lines 300 --json
```

### 17.2 Validation Checks for the Job Board Rollout

- Confirm `/job-board/summary` agrees with current helper queue and worker summaries during rollout.
- Confirm GPT read actions return machine-readable payloads and do not enqueue work.
- Confirm normal GPT async creation still emits exactly one enqueue event per new job.
- Confirm `/job-board/jobs/:id` and `action: "get_job_status"` agree with `GET /jobs/:id/result` on status, lifecycle, and result availability.
- Confirm worker and queue counts reconcile with logs and metrics within a defined lag window.
- Confirm no regression in existing `/jobs/:id`, `/jobs/:id/result`, or `/jobs/:id/stream` behavior.

## 18. Open Questions and Risks

- Current queue summaries include non-GPT job types. The board must default to `scope = gpt` or operators will read inflated totals.
- Current retained failure payloads can surface raw upstream text. The board should redact before exposing those through stable APIs.
- Expired jobs can lose clear pre-expiry outcome semantics unless the last execution outcome is preserved separately.
- Some worker snapshots show long inactivity while watchdog restart is not recommended. The board should expose both raw inactivity and computed health instead of hiding the ambiguity.
- If the board later adds an event table, retention and cardinality limits must be explicit to avoid turning it into a second unbounded log store.
