# GPT-OSS Durable Rate-Limit Design

Phase 5.10 defines durable rate-limit governance for future GPT-OSS private
serving. This phase is design/schema/validation only. It does not implement
durable rate-limit storage, connect to a database, add a migration, create a
server, expose an endpoint, deploy, call OpenAI, train, use vLLM, run Railway
commands, read secrets, read environment-held secrets, integrate KMS, or expose
Custom GPT.

Current readiness remains blocked:

```json
{
  "durableRateLimitDesigned": true,
  "durableRateLimitImplemented": false,
  "rateLimitDurable": false,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "cloudReady": false,
  "customGptReady": false
}
```

## Purpose

The durable rate-limit boundary will prevent private GPT-OSS serving from
becoming an unbounded request path after a later implementation phase. It
defines quota governance, audit shape, denial behavior, and fail-closed
requirements before any durable backend exists.

The current executable rate limiter remains local scaffold logic only. It uses
in-memory state for tests and does not persist counters, coordinate across
instances, or provide production abuse controls.

## Quota Model

Future durable limits must support layered quotas:

- per-key quotas keyed by non-secret `keyId`
- per-subject quotas keyed by authenticated caller subject
- per-action quotas keyed by effective-router action class
- global service safety quotas
- emergency block overrides

All quota records must be non-secret. They may store key ids, subject hashes,
action labels, counters, window timestamps, denial reasons, and audit
correlation identifiers. They must not store raw request bodies, raw signing
keys, bearer values, cookies, database URLs, environment values, or raw model
output.

## Per-Key Limits

Per-key limits protect a single signing identity from overuse. A future
implementation must bind limit decisions to `keyId`, audience, and the
authenticated subject. Unknown, revoked, or disabled keys must fail before
quota consumption.

## Per-Subject Limits

Per-subject limits protect authenticated callers even when they rotate keys or
share service boundaries. Subjects should be represented in durable rate-limit
records as stable redacted labels or hashes, not as raw identity tokens.

## Per-Action Limits

Per-action limits let sensitive effective-router actions receive stricter
quotas. Action labels must come from validated effective-router contract output
or an allowlisted request class. Raw model text must not drive quota identity.

## Burst Policy

Future policy must include:

- short-window burst limits
- longer-window sustained limits
- explicit retry-after calculation
- fail-closed behavior when policy is missing or invalid
- deterministic denial reasons

The current scaffold has in-memory burst counters only. It is not durable and
does not make private serving production-ready.

## Abuse Mitigation

Abuse controls must support emergency blocks by key, subject, source, action,
or route. Emergency blocks must deny before model execution, replay acceptance,
or durable counter increment when safe. Blocks must preserve audit correlation
without recording secrets.

## Rate-Limit Windows

The durable design requires fixed windows or sliding windows with deterministic
clock handling. Windows must include:

- request timestamp
- received timestamp
- expires-at timestamp
- retry-after seconds
- durable counter scope

Clock skew and retry-after behavior must be documented before implementation.

## Replay Interaction

Replay checks and rate limits must remain separate controls. A replayed nonce
must not bypass rate limits, and a rate-limit denial must not create a replay
acceptance record. Durable replay remains unimplemented, so durable rate-limit
implementation also remains blocked.

## Auth Interaction

Authentication must happen before durable rate-limit consumption. Missing,
unknown, revoked, or unauthenticated identities must fail closed without
consuming normal caller quota. Audit may record a safe denial category and
non-secret key or subject metadata when available.

## Audit Requirements

Durable rate-limit audit records may include:

- request id
- `keyId`
- subject hash or redacted subject label
- action label
- quota scope
- window start and end
- remaining count
- retry-after seconds
- denial reason
- audit correlation id

Audit records must not include raw secrets, raw request bodies, raw signatures,
raw environment values, database URLs, OpenAI output, Railway output, live DB
rows, or unredacted local runtime output.

## Denial Behavior

Rate-limit denials must return a structured private-serving refusal envelope.
Denials must not call model execution, OpenAI, Railway, shell, database, vLLM,
training, deployment, or Custom GPT paths. Denials must include retry guidance
only when it is safe and deterministic.

## Failure Behavior

Missing policy, unavailable durable backend, malformed durable state, unsafe
clock state, or audit failure must fail closed. A future implementation may
choose a local emergency-only fallback for operator lockout prevention, but it
must not silently allow private serving traffic.

## Emergency Disable

Emergency disable must support:

- disable all GPT-OSS private-serving requests
- disable one `keyId`
- disable one subject
- disable one action class
- preserve audit correlation
- keep cloud and Custom GPT readiness false until reviewed

This phase documents the behavior only and adds no executable disable switch.

## Future Durable Backend Options

Future implementation review may consider a relational table, a Redis-like
counter backend, or another private control-plane store. The selected backend
must be private, audited, fail-closed, and covered by schema-first tests before
use. Phase 5.10 does not choose or connect any live backend.

## Implementation Remains Blocked

Durable rate limits cannot be implemented until later approved work resolves:

- durable replay implementation
- production key-management implementation
- private endpoint auth integration
- durable quota backend selection
- migration and rollback plan
- audit persistence implementation
- server review
- cloud and Custom GPT exposure review

Until those blockers are resolved, the required state remains
`durableRateLimitImplemented:false`, `rateLimitDurable:false`,
`privateServingImplemented:false`, `privateServingExposed:false`,
`cloudReady:false`, and `customGptReady:false`.
