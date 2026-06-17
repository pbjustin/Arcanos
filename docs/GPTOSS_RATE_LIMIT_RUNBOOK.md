# GPT-OSS Rate-Limit Runbook

This runbook is for Phase 5.10 durable rate-limit design checks only. It does
not authorize durable storage, database access, migrations, server startup,
endpoint creation, deployment, OpenAI calls, training, vLLM, Railway commands,
secret reads, KMS integration, or Custom GPT exposure.

## Operator Checks

Run the static design validator:

```bash
npm run gptoss:private-serving:rate-limit:design:validate
```

Expected state:

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

The current rate limiter is local scaffold logic only. It is useful for helper
tests and contract shape validation, not production governance.

## Rate-Limit Policy Review

Before a future implementation, review:

- per-key quota
- per-subject quota
- per-action quota
- burst limit
- sustained window
- retry-after behavior
- emergency block rules
- audit fields
- fail-closed behavior
- rollback behavior

Do not approve a rollout if durable replay, production key management, private
endpoint auth, audit persistence, or rollback remain unresolved.

## Emergency Block Procedure

Future emergency blocks must be able to deny:

- all GPT-OSS private-serving requests
- one non-secret `keyId`
- one authenticated subject
- one action class
- one route class

Emergency blocks must deny before model execution and must not fall back to
OpenAI, shell, Railway, live database, vLLM, training, deployment, public route,
or Custom GPT paths.

## Safe Fallback Behavior

The safe fallback is fail-closed. If durable quota state is unavailable or
policy cannot be validated, private serving remains blocked. A future
operator-only diagnostic fallback must be separately reviewed and must preserve
`allowedForTraining:false`, redacted audit output, and blocked cloud readiness.

## Audit Inspection Process

Inspect future audit records for:

- non-secret `keyId`
- redacted or hashed subject
- quota scope
- action label
- retry-after seconds
- denial reason
- audit correlation id
- no raw request body
- no raw signing key
- no bearer value
- no cookie
- no database URL
- no environment dump
- no raw model output

Phase 5.10 does not create durable audit storage.

## Future Production Rollout Checklist

Before implementation or rollout:

1. Durable replay is implemented and gated.
2. Production key management is implemented and gated.
3. Durable quota backend is selected and reviewed.
4. Migration and rollback plans are approved.
5. Audit persistence is implemented without raw secrets.
6. Private endpoint auth is integrated.
7. Server review is complete.
8. Cloud and Custom GPT exposure reviews are complete.
9. Static and runtime gates prove `cloudReady:false` until exposure is
   explicitly approved.

## Rollback Checklist

Future rollback must:

1. Disable GPT-OSS private-serving traffic.
2. Preserve rate-limit audit records.
3. Preserve durable replay records.
4. Keep production key revocation decisions intact.
5. Confirm `durableRateLimitImplemented:false` when rolling back to the design
   phase.
6. Confirm `rateLimitDurable:false`, `privateServingImplemented:false`,
   `privateServingExposed:false`, `cloudReady:false`, and
   `customGptReady:false`.
7. Re-run the static design validator.

Rollback must not start a server, call OpenAI, run training, use vLLM, run
Railway commands, connect to a live database, read secrets, integrate KMS, or
expose Custom GPT.
