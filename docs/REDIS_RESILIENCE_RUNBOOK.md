# Redis resilience operator runbook

## Runtime contract

ARCANOS owns one process-wide Redis client through `RedisLifecycleManager`. Node-redis reconnects are disabled; the dependency lifecycle is the only retry owner.

The lifecycle is also the Redis operation circuit breaker:

| Circuit state | Lifecycle condition | Application Redis work |
| --- | --- | --- |
| `CLOSED` | Connected and validated with `PING` | Admitted through `executeRedisOperation` |
| `OPEN` | Runtime loss or retry backoff | Rejected before callback execution |
| `HALF_OPEN` | One serialized connect-and-`PING` recovery probe | Rejected; application probe capacity is zero |

The failure threshold is one. A transport error, socket loss, or two-second operation timeout opens the circuit. Runtime loss waits for the bounded retry delay before the sole half-open probe. A successful probe advances the ready generation and closes the circuit. Late work from an older generation cannot return or invalidate the recovered generation.

Every rejected or failed application operation returns the stable, credential-free code `REDIS_DEPENDENCY_UNAVAILABLE`. The HTTP boundary maps uncaught dependency errors to HTTP 503. Durable jobs remain PostgreSQL-backed; never introduce an in-memory durable-job fallback.

Every deployed web/worker Redis command must enter through `executeRedisOperation` with an allowlisted operation name. The standalone `arcanos-ai-runtime` workspace has its own experimental BullMQ/ioredis topology, but neither Railway launcher entrypoint imports or starts that workspace; it is outside this web/worker lifecycle and preview proof. Activating it as a service requires a separate lifecycle and durability review.

## Health semantics

- `/health` and `/healthz` are process liveness. They must remain HTTP 200 while Redis is unavailable.
- `/readyz` is full application readiness. It returns HTTP 503 while configured Redis is unavailable.
- Public lifecycle metadata includes only state, circuit state, attempt, retry status, recovery count, and ready generation.
- Railway uses `/health`, so the process can remain deployed while degraded. Routes requiring Redis must fail fast and safely.

Do not restart the web service to repair Redis. Restore the Redis service, private-network reference, authentication, DNS, or persistence issue and allow lifecycle recovery to close the circuit.

## Alert-ready metrics

The `/metrics` endpoint requires its configured operator credential. Never print or save that credential.

```promql
dependency_circuit_breaker_state{dependency="redis",state="OPEN"} == 1
```

Warn after 60 seconds. Page when readiness is also unavailable or the open interval exceeds the service objective.

```promql
increase(dependency_operation_gate_rejections_total{dependency="redis"}[5m]) > 0
```

Redis-dependent traffic reached the open or half-open gate.

```promql
increase(dependency_lifecycle_events_total{dependency="redis",event="retry_scheduled"}[5m]) > 20
```

Retry volume is above the expected capped exponential schedule.

```promql
increase(dependency_recoveries_total{dependency="redis"}[15m]) > 3
```

Redis is flapping.

```promql
increase(dependency_timeouts_total{dependency="redis"}[5m]) > 0
```

At least one operation exceeded its two-second deadline.

```promql
absent(dependency_circuit_breaker_state{dependency="redis"})
```

Lifecycle telemetry is missing.

Correlation IDs appear only in structured lifecycle logs, never in metric labels. Logs and snapshots must not contain Redis URLs, hosts, keys, values, raw errors, credentials, or connection strings.

## Incident response

1. Confirm `/health` remains 200 and `/readyz` reports the sanitized Redis dependency failure.
2. Inspect the circuit state, retry schedule, recovery count, ready generation, and the bounded metrics above.
3. Confirm there is one lifecycle owner and no duplicate clients or retry loops.
4. Inspect Redis service health, private networking, volume state, and reference-variable names without retrieving values.
5. Repair Redis. Do not redeploy or restart the web service merely to trigger recovery.
6. Require `OPEN → HALF_OPEN → CLOSED`, a ready-generation increment, `/readyz` 200, and stable web process uptime.
7. Verify gate rejections stop and no old-generation command causes a second recovery.

Safety behavior during an outage is fail-closed:

- Freeze and autonomy reductions apply locally first and reconcile after recovery.
- Unfreeze and autonomy increases require a fresh authoritative read plus an atomic compare-and-mutate before local state changes; a cross-replica race rejects the relaxation.
- A configured but unavailable or unreadable shared kill switch resolves to frozen with autonomy zero.
- Distributed-lock heartbeats are serialized; release waits for a bounded in-flight heartbeat.

## Deterministic local and CI proof

Run:

```powershell
npm run test:redis-resilience
```

The suite uses injected clients, clocks, sleep, and randomness. It does not require a Redis process or network access. It covers refusal, timeout, open-state rejection, single half-open recovery, stale-generation isolation, deadline capping, correlation-safe events, metrics, HTTP 503 mapping, kill-switch fail-closed behavior, and serialized lock heartbeats.

The normal `npm test` CI sweep also discovers these tests.

## Railway preview outage proof

Only run against an explicitly verified isolated preview after its updated healthy baseline passes.

1. Record the exact clean commit and unchanged web/worker deployment IDs.
2. Require `/health`, `/healthz`, and `/readyz` 200 with circuit `CLOSED`.
3. Start the bounded recovery probe before restoring Redis.
4. Stop only the preview Redis deployment for no more than five minutes.
5. Require liveness 200, readiness 503, circuit `OPEN`/`HALF_OPEN`, bounded gate failure, zero 502s, and no web or worker restart.
6. Restore the same preview Redis service and volume.
7. Require automatic circuit closure, readiness 200, recovery count and ready generation increments, unchanged web/worker deployment identity, and monotonic web uptime.
8. Reconfirm production deployment IDs are unchanged.

Never stop production Redis, create a public data-service proxy, print variables, copy data, call a real provider, or delete the retained preview without separate authorization.
