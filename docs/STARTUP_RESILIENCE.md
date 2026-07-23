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

## Dependency and Redis lifecycles

`src/platform/runtime/dependencyLifecycle.ts` provides the reusable single-
dependency mechanics: one resource, one serialized recovery loop, bounded
attempts, capped backoff with jitter, state subscriptions, and idempotent
shutdown. It is intentionally not a registry or a generic dependency manager;
each dependency keeps configuration, validation, error classification, and
cleanup in a small adapter.

`src/platform/runtime/redisLifecycle.ts` is the first production adapter. It
owns one shared client for self-heal telemetry, runtime diagnostics, the
incident kill switch, and safety-v2 operations. Each connect and `PING` attempt
is bounded to three seconds. Failed attempts use exponential backoff starting
at 250 ms, capped at 30 seconds, with up to 250 ms of jitter. Recovery continues
until shutdown; callers never need a process restart or redeploy.

The same manager handles connection loss after readiness. Both socket errors
and clean end events move the process to `DEGRADED`, invalidate access to the
client, and start one reconnect loop. A successful reconnect moves the process
back to `READY`. Repeated start calls and repeated disconnect events cannot
create another client or overlapping retry loop.

The lifecycle is also the sole Redis circuit breaker: `READY` is `CLOSED`, the
retry wait is `OPEN`, and the one serialized connect-and-`PING` attempt is
`HALF_OPEN`. Application probe capacity is zero while half-open. Each successful
validation increments a ready generation; late commands from an older
generation cannot return or invalidate the recovered client.

Redis-backed operations can access the lifecycle-owned client only inside an
`executeRedisOperation` callback with an allowlisted operation identity. When
Redis is unavailable they fail before the callback with
`REDIS_DEPENDENCY_UNAVAILABLE` and a credential-free message. Commands are
bounded to two seconds; a timeout or connection failure invalidates the client
and starts the same single recovery loop. Configured kill-switch reads fail
closed to frozen/autonomy zero. Restrictive mutations apply locally first and
reconcile after recovery; relaxing mutations persist before changing local
state. In-process mutations are serialized and versioned, while relaxing
cross-replica mutations use a fresh shared read and atomic compare-and-mutate so
a concurrent restrictive update rejects the relaxation.

Both `redis://` and TLS `rediss://` URLs are accepted. Without a valid discrete
fallback, a non-empty malformed `REDIS_URL` remains explicitly configured but
degraded with `REDIS_CONFIGURATION_INVALID`; it is never silently treated as
an optional, unconfigured dependency.

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
While active HTTP requests drain, it removes lifecycle subscriptions, cancels
telemetry timers, aborts Redis retry timers and bounded attempts, and closes the
Redis client once. Idle clients close gracefully; a client with an active
bounded command is destroyed so shutdown cannot wait on that command. It then
waits for in-flight runtime initialization and closes the database. Late Redis
events cannot restore readiness or start background runtime work after shutdown
begins.

## Local verification

The focused regression suites are:

```text
npm run test:redis-resilience

tests/redis-startup-lifecycle.test.ts
tests/dependency-lifecycle.test.ts
tests/server-startup-resilience.test.ts
tests/startup-health-routes.test.ts
tests/self-heal-telemetry-redis.test.ts
tests/incident-response-kill-switch.test.ts
tests/safety-v2-redis-lifecycle.test.ts
tests/worker-duplication-suppression.test.ts
tests/unified-health-redis.test.ts
```

They use fake clients and local HTTP requests only. They do not require a
production credential or a live Redis service.

The reusable isolated Railway baseline/outage/recovery procedure is in
`docs/RAILWAY_REDIS_LIFECYCLE_PREVIEW.md`; dated audit evidence records whether
a particular execution occurred.
