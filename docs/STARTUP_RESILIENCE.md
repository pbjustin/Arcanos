# Web startup and Redis resilience

The web process treats HTTP liveness and dependency readiness as separate
contracts. A temporary Redis outage must not prevent the process from binding
its listener or exposing health information.

## Startup sequence

The production web entrypoint follows this order:

1. Load and validate deterministic configuration and safety policy.
2. Construct the Express application and register its routes.
3. Bind the HTTP listener to `HOST` and `PORT`.
4. Start the shared Redis lifecycle in the background.
5. Prime self-heal telemetry without awaiting Redis.
6. Initialize the remaining runtime dependencies.
7. Start background application loops once, after the startup lifecycle is
   ready.

Only deterministic preflight or listener-binding failures remain fatal before
the listener is available. Redis connection failures are represented as
dependency state and are retried in-process.

## State and endpoint contract

| State | Listener | Redis | `/health` and `/healthz` | `/readyz` |
| --- | --- | --- | --- | --- |
| `STARTING` | Bound | Initializing | `200` | `503` |
| `DEGRADED` | Bound | Unavailable | `200` | `503` |
| `READY` | Bound | Connected and verified | `200` | `200` |

Liveness responses contain only sanitized lifecycle metadata. Readiness reads
the process-local lifecycle snapshot; it does not create a probe client or make
a Redis command. Redis failures use stable codes such as
`REDIS_INITIALIZING`, `REDIS_CONNECTION_REFUSED`, `REDIS_CONNECT_TIMEOUT`,
`REDIS_AUTH_FAILED`, and `REDIS_DEPENDENCY_UNAVAILABLE`. Connection strings and
raw provider errors are never part of the public lifecycle projection.

## Redis lifecycle

`src/platform/runtime/redisLifecycle.ts` owns one shared client for startup,
self-heal telemetry, and runtime diagnostics, plus one serialized connection
loop. Each connect and `PING` attempt is bounded to three seconds. Failed
attempts use exponential backoff starting at 250 ms, capped at 30 seconds, with
up to 250 ms of jitter. Recovery continues until shutdown; callers never need a
process restart or redeploy.

The same manager handles connection loss after readiness. Both socket errors
and clean end events move the process to `DEGRADED`, invalidate access to the
client, and start one reconnect loop. A successful reconnect moves the process
back to `READY`. Repeated start calls and repeated disconnect events cannot
create another client or overlapping retry loop.

Specialized, pre-existing safety-v2 and incident kill-switch clients are not
part of this lifecycle. They are lazily created by their own security features
and do not participate in listener startup. Consolidating those clients would
change fail-closed security behavior and is outside this startup-resilience
change.

Redis is optional in configurations where no Redis endpoint is present. In
that case the Redis lifecycle reaches ready in unconfigured mode and does not
open a client. Production configuration validation remains responsible for
requiring the intended service reference.

## Telemetry and runtime behavior

Self-heal telemetry and shared runtime diagnostics use the lifecycle-owned
ready client. They do not connect independently. Telemetry records created
during an outage remain in memory, are merged with persisted state after Redis
recovers, and are flushed without starting a second telemetry instance.
Telemetry read or write failures are logged with stable error codes and never
fail process startup.

The root GPT job queue and dedicated Railway Worker are PostgreSQL-backed; Redis
is not their durable job source of truth. The web Redis recovery path therefore
does not start workers or queue consumers. This preserves the existing worker
ownership boundary and prevents duplicate execution.

## Shutdown

Shutdown first marks readiness unavailable and stops accepting new requests.
After active HTTP requests drain, it removes lifecycle subscriptions, cancels
telemetry timers, aborts Redis retry timers and bounded attempts, closes the
Redis client once, waits for in-flight runtime initialization, and closes the
database. Late Redis events cannot restore readiness or start background
runtime work after shutdown begins.

## Local verification

The focused regression suites are:

```text
tests/redis-startup-lifecycle.test.ts
tests/server-startup-resilience.test.ts
tests/startup-health-routes.test.ts
tests/self-heal-telemetry-redis.test.ts
tests/unified-health-redis.test.ts
```

They use fake clients and local HTTP requests only. They do not require a
production credential or a live Redis service.
