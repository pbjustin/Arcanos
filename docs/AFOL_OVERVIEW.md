# AFOL (Adaptive Failover Orchestration Layer)

> **Last Updated:** 2025-11-04 | **Owners:** Platform Reliability Guild

AFOL is Arcanos' routing safety net. It continuously inspects the health of
critical services, evaluates fallback policies, and selects the safest execution
route for high-risk orchestration tasks. The module is intentionally light on
external dependencies so it can run during degraded conditions and export its
findings to diagnostic tooling.

---

## 🔍 Responsibilities

- **Snapshot environment health** via in-memory metrics maintained in
  [`src/afol/health.ts`](../src/afol/health.ts).
- **Evaluate routing policies** that translate health signals into go/no-go
  decisions in [`src/afol/policies.ts`](../src/afol/policies.ts).
- **Select and execute routes** through the orchestrator in
  [`src/afol/engine.ts`](../src/afol/engine.ts), choosing between primary,
  backup, or rejection paths.
- **Persist auditable logs** of every decision, stored by
  [`src/afol/logger.ts`](../src/afol/logger.ts) for later review.

---

## 🧭 Decision Flow

1. **Capture status** – `decide()` snapshots the current service health using
   `getStatus()`.
2. **Policy evaluation** – `evaluate()` inspects the snapshot, calculating
   whether the primary or backup path is available and writing a rationale
   string for observability.
3. **Route selection** – The engine calls `selectRoute()` to choose a route:
   primary if everything is healthy, backup if only secondary services remain,
   otherwise reject.
4. **Route execution stub** – `executeRoute()` returns a structured payload today
   and is ready for integration with concrete worker invocations.
5. **Decision logging** – Every decision, including latency, timestamp, and
   policy snapshot, is appended to the AFOL log file.

The resulting `DecisionRecord` structure (see
[`src/afol/types.ts`](../src/afol/types.ts)) makes it easy to surface AFOL output
through HTTP APIs or internal dashboards.

---

## 🩺 Health Management

- **Default state** – `health.ts` seeds Redis, Postgres, and API probes as
  healthy with representative latency values. Customize these defaults via
  `defaultHealthSnapshot`.
- **Simulation hooks** – `simulateFailure()` and `simulateRecovery()` allow tests
  and chaos tooling to mutate individual services in-memory. Use
  `setHealthSnapshot()` to overwrite the entire view with external telemetry.
- **Reset workflow** – `resetHealth()` is exposed to restore the baseline.
  Testing suites should call this in `beforeEach` to ensure deterministic runs.

Integrating real probes is as simple as replacing the in-memory setter calls
with metrics ingestion that keeps `healthState` in sync with production signals.

---

## 📝 Logging & Observability

- **Destination** – By default AFOL writes to `logs/afol-decisions.log`. Use
  `configureLogger({ filePath })` to redirect output (tests often target temp
  directories).
- **Log format** – Entries are newline-delimited JSON containing the original
  request context, the final decision, and optional error metadata.
- **Inspection** – `getRecent()` parses the log tail for dashboards, while
  `clearLogs()` and `resetLogger()` support cleanup between tests or deployments.
- **Error channels** – `logError()` provides a structured way to record
  exceptions without a decision payload.

---

## 🧩 Extending AFOL

1. **Add new services** by extending `HealthSnapshot` and using
   `setServiceHealth()` to publish updates.
2. **Introduce richer policies** by evolving `evaluate()` to inspect additional
   metrics (latency budgets, saturation scores, etc.) and returning a more
   nuanced rationale.
3. **Implement real routes** by replacing the execution stub with calls into the
   appropriate worker, queue, or API layer and returning a
   `RouteExecutionResult` describing the downstream response.
4. **Wire into APIs** by exposing `decide()` through an HTTP endpoint or job
   orchestrator, passing the operational intent via the `DecideInput` object.

---

## ✅ Testing

- Unit coverage lives in [`tests/afol.test.ts`](../tests/afol.test.ts). The suite
  exercises the happy path, fallback selection, rejection flow, and logging
  helpers.
- Run `npm test -- afol` to execute only the AFOL suite during iterative
  development.
- Consider adding integration tests once AFOL is connected to real worker
  pipelines to ensure the failover choices remain correct under load.

---

## 📌 Quick Reference

| Concern | Key Function | Location |
| --- | --- | --- |
| Capture a decision | `decide()` | [`src/afol/engine.ts`](../src/afol/engine.ts) |
| Mutate health state | `simulateFailure()` / `setHealthSnapshot()` | [`src/afol/health.ts`](../src/afol/health.ts) |
| Inspect policy | `evaluate()` | [`src/afol/policies.ts`](../src/afol/policies.ts) |
| Tail recent logs | `getRecent()` | [`src/afol/logger.ts`](../src/afol/logger.ts) |

AFOL gives the platform a predictable, testable control plane for failover so
operators can make conservative choices when infrastructure degrades.
