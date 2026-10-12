# Self-healing acceptance matrix

PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Initial inspected head:
`ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

The architecture map was completed before execution. All fourteen safely
executable scenarios were evaluated locally. No isolated Railway fixture or
genuine Railway runtime was exercised: the PR-owned exact-head preview is
absent, so live execution stopped before credentials, endpoints or faults were
used. Local PASS below applies only to the stated boundary. Every overall
scenario remains BLOCKED for the requested live acceptance.

| Scenario | Local result and execution mode | Evidence and practical limit | Isolated preview fixture | Genuine live preview / overall acceptance |
| --- | --- | --- | --- | --- |
| Healthy baseline | PASS — local real-consumer integration | `self-healing-trinity.integration.test.ts`: healthy coordinator selects no unnecessary action; actual SDK/Trinity takes its normal path against synthetic loopback replies. | NOT_RUN | BLOCKED |
| Transient provider timeout | PASS — local real-consumer integration | Held loopback intake response triggers the real SDK deadline; one direct-answer recovery succeeds; only one failure observation, no persistent threshold activation. Next request returns to the normal pipeline. Client cancellation is distinguished from timeout-fixture backstop cleanup. No real provider call. | NOT_RUN | BLOCKED |
| Repeated provider failures | PASS — local real-consumer integration | Five controlled 503 POSTs remain on the authorized model: intake plus four bounded recovery attempts. OPEN circuit rejects further POSTs; two successful synthetic probes close it. This proves bounded failure/admission behavior, not provider availability. | NOT_RUN | BLOCKED |
| Trinity failure | PASS — local real-consumer integration | Coordinator selects and applies same-process degraded mode; actual `runTrinity` consumer switches simple traffic to direct answer. Complex traffic remains outside this mitigation. The integration asserts provider request transcript and consumer decision, beyond selection logs. Cross-service delivery is absent. | NOT_RUN | BLOCKED |
| Redis interruption | PASS — local mocked lifecycle/operation integration | `redis-startup-lifecycle`, `redis-operation-boundary`, `safety-v2-redis-lifecycle`, `self-heal-telemetry-redis`: bounded reconnect/deadlines, unavailable admission and persistence fallback. No Redis process was interrupted locally or on Railway. | NOT_RUN | BLOCKED |
| Worker job failure | PASS — local mocked queue/runner integration | `worker-task-queue`, `worker-autonomy-service`, `worker-duplication-suppression`, `job-runner-runtime`, queue lifecycle/requeue suites: bounded retries, one local execution owner and fenced terminal/retry behavior. This does not prove real SQL contention or exactly-once external effects. | NOT_RUN | BLOCKED |
| Incident threshold | PASS — local unit and real-consumer integration | V2 records failures one/two without action and activates at three; transient real transport failure remains below that threshold. Canonical diagnosis tests separately enforce request/burst thresholds and configured incident attempt budgets. No durable unique incident registry exists. | NOT_RUN | BLOCKED |
| Mitigation TTL | PASS — local V2 and real-consumer integration, Trinity scope | Fake-clock boundary expires the ten-minute Trinity command and restores the normal consumer. Pending verification is invalidated for expired/replaced commands without attributing recovery. Prompt-route mitigation has no TTL and requires explicit clear/rollback/restart; this broader requirement remains a limitation. | NOT_RUN | BLOCKED |
| Recovery verification | PASS — local controller integration | Empty/stale request windows defer verification; measured post-action improvement is required for a live Trinity command. Expired/rolled-back/replaced commands cannot claim later recovery. V2 retains successful actions until TTL. There is no durable incident-close API to validate. | NOT_RUN | BLOCKED |
| Failed mitigation | PASS — local controller/actuator integration | Four pre-fix throwing-actuator regressions demonstrated unbounded retries. Dispatched exceptions now consume cooldown/budget once, including degraded cooldown override. Unchanged/worse Trinity samples trigger rollback and ineffective cooldown; denied actuation consumes no dispatched attempt. Escalation effects are mocked. | NOT_RUN | BLOCKED |
| Concurrent incidents | PASS — local unit/controller and real-consumer integration | One in-flight tick, one pending verification, duplicate suppression, predictive execution ownership, rollback-before-advisor ownership, and stage/action replacement fencing prevent competing same-process actions. No distributed coordinator lock or cross-service command bus is implemented. | NOT_RUN | BLOCKED |
| Service-role restriction | PASS — local startup/unit and real-consumer integration | Web role suppresses automatic scheduler, interval entry and V2 failure activation; explicitly authorized manual web command remains consumable. Worker repair stays disabled for web even with approval. Standalone durable job runner does not start canonical scheduler; prompt fast trip is a separate owner. | NOT_RUN | BLOCKED |
| Unauthorized action | PASS — local HTTP/policy/actuator integration | Approval, scoped admission, pre-parser authentication, rate-limit and helper credential suites reject unauthorized mutation. New exact Railway target regressions reject absent/conflicting/ambiguous scope before any mocked deployment; actual deployment calls never occur. | NOT_RUN | BLOCKED |
| Restart during incident | PASS — two genuine local Node processes | `self-healing-restart.test.js` first activates a command, then fresh PID has empty stage/command state and normal consumer. Literal synthetic env, empty temp cwd, reviewed module allowlist and denied fetch contain effects. This proves invalidation, not durable incident continuation or external-effect replay safety. | NOT_RUN | BLOCKED |

The original failures, corrections and aggregate results are in the
[regression report](self-healing-regression-report.md). Deployment identity,
isolation stop conditions and absence of live incident/consumer evidence are in
the [preview evidence](self-healing-preview-evidence.md). The
[merge-readiness report](self-healing-merge-readiness.md) keeps live gates
independent from local results.

No production database writes, Redis mutations, shared job execution, webhooks
or billable model calls were authorized or executed by these acceptance tests.
Existing CI disposable PostgreSQL/Redis results are supplementary CI evidence;
they are not substitutes for the missing isolated preview.
