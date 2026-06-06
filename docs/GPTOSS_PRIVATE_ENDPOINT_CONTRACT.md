# GPT-OSS Private Endpoint Contract

Phase 5 allows only the private endpoints listed in this document. This is a
design-only contract for future implementation; it does not create routes,
schemas, tests, model execution, Railway behavior, database access, or server
startup.

Phase 5.1 adds local-only scaffold helpers for signing, auth, rate-limit
policy, response shaping, denial responses, and scaffold validation. These
helpers do not create an endpoint, route handler, listener, tunnel, deployment,
or Custom GPT action.

## Shared Rules

All allowed endpoints must be private-only, schema-validated, authenticated,
rate-limited, audited, rollback-aware, and secret-free.

The Phase 5.1 scaffolds are not endpoint implementations:

- request signing verification is implemented locally with HMAC-SHA256 and
  fails closed when no explicit local signing key is supplied
- auth validation rejects unauthenticated requests and is not production auth
- rate limiting uses in-memory scaffold state only
- response shaping emits only the safe effective-router envelope
- private serving remains unexposed with `privateServingImplemented:false`,
  `privateServingExposed:false`, and `publicServerCreated:false`
- cloud and Custom GPT remain blocked with `cloudReady:false` and
  `customGptReady:false`

Phase 5.2 implements local HMAC-SHA256 signing helpers for signed request
envelopes. This is helper logic only: no endpoint or server exists, no
production key management exists, and auth boundary integration remains
incomplete for serving.

Every endpoint response that returns a router result must use the effective plus
safety envelope:

```json
{
  "requestId": "...",
  "effective": {
    "plane": "...",
    "action": "...",
    "risk": "...",
    "requiresConfirmation": false,
    "allowedForTraining": false,
    "sources": ["model", "policy", "spec_facts", "postprocessor"]
  },
  "safety": {
    "openAiCalled": false,
    "trainingExecuted": false,
    "vllmUsed": false,
    "railwayCliUsed": false,
    "liveDbUsed": false,
    "noOpenAiOutputUsed": true
  }
}
```

Raw model text may be logged only as capped/redacted preview in local audit
artifacts, never exposed as the primary API result. Hidden prompts, system
instructions, chain-of-thought, credentials, raw environment values, database
rows, shell output, and Railway command output must never be returned.

## Allowed Future Endpoints

The only allowed future private endpoints are:

- `POST /private/gptoss/effective-router/classify`
- `POST /private/gptoss/effective-router/replay`
- `GET /private/gptoss/effective-router/readiness`
- `GET /private/gptoss/effective-router/release-gate`

## Forbidden Endpoints

The following endpoint classes are forbidden and must fail closed:

- /v1/chat/completions public clone
- raw completion endpoint
- arbitrary shell endpoint
- Railway command endpoint
- DB query endpoint
- training endpoint
- Custom GPT direct action endpoint
- public unauthenticated endpoint
- browser-client direct GPT-OSS access
- fallback through `/gpt/:gptId`

## POST /private/gptoss/effective-router/classify

Classifies one private request through the effective router.

Request schema:

```json
{
  "requestId": "string",
  "signatureAlgorithm": "hmac-sha256",
  "keyId": "non-secret identifier",
  "userInput": "string",
  "mode": "router_classifier",
  "context": {
    "source": "private_backend",
    "traceId": "string | null",
    "metadata": {}
  },
  "options": {
    "includeRawModelPreview": false,
    "dryRun": true
  }
}
```

Response schema:

```json
{
  "requestId": "string",
  "effective": {
    "plane": "writing-plane | control-plane",
    "action": "string",
    "risk": "string",
    "requiresConfirmation": false,
    "allowedForTraining": false,
    "sources": ["model", "policy", "spec_facts", "postprocessor"]
  },
  "safety": {
    "openAiCalled": false,
    "trainingExecuted": false,
    "vllmUsed": false,
    "railwayCliUsed": false,
    "liveDbUsed": false,
    "noOpenAiOutputUsed": true
  }
}
```

Auth: service-to-service private authentication only. Reject missing, invalid,
public, browser, or Custom GPT credentials.

Rate limit: per service identity and per source, with a low default burst. Rate
limit failures return a refusal envelope and do not execute the runtime.

Audit: write request id, caller identity hash, input hash, decision, route,
safety flags, redaction list, latency bucket, and rollback state. Do not write
raw input unless separately capped and redacted.

Failure modes: invalid schema, auth failure, rate limit, runtime unavailable,
readiness blocked, rollback active, redaction failure, or unsupported mode. All
fail closed with `safety.allowed:false`.

Rollback behavior: return a control-plane effective result with
`allowedForTraining:false` and clean safety flags without calling model
execution.

Safety flags: include applicable values such as `schema_invalid`,
`auth_failed`, `rate_limited`, `runtime_unavailable`, `readiness_blocked`,
`rollback_active`, `redaction_failed`, and `raw_preview_omitted`.

## POST /private/gptoss/effective-router/replay

Replays a prior private audit record through the effective router for
deterministic comparison. Replay must not become training data.

Request schema:

```json
{
  "requestId": "string",
  "auditRecordId": "string",
  "expectedInputHash": "string",
  "mode": "router_classifier",
  "options": {
    "dryRun": true,
    "includeRawModelPreview": false
  }
}
```

Response schema:

```json
{
  "requestId": "string",
  "effective": {
    "plane": "control-plane",
    "action": "string",
    "risk": "string",
    "requiresConfirmation": false,
    "allowedForTraining": false,
    "sources": ["model", "policy", "spec_facts", "postprocessor"]
  },
  "safety": {
    "openAiCalled": false,
    "trainingExecuted": false,
    "vllmUsed": false,
    "railwayCliUsed": false,
    "liveDbUsed": false,
    "noOpenAiOutputUsed": true
  }
}
```

Auth: private operator or service identity with replay permission. Custom GPT
and public callers are forbidden.

Rate limit: stricter than classify because replay can amplify audit access.
Limit by caller identity and audit record id.

Audit: write replay request id, caller identity hash, audit record id, expected
input hash, match booleans, decision, safety flags, and rollback state. Do not
write recovered raw inputs.

Failure modes: invalid schema, auth failure, missing audit record, hash
mismatch, rate limit, runtime unavailable, readiness blocked, rollback active,
or redaction failure. All fail closed.

Rollback behavior: do not load or replay the audit record. Return a refusal
envelope with a rollback flag.

Safety flags: include applicable values such as `schema_invalid`,
`auth_failed`, `rate_limited`, `audit_record_missing`, `input_hash_mismatch`,
`runtime_unavailable`, `readiness_blocked`, `rollback_active`, and
`raw_preview_omitted`.

## GET /private/gptoss/effective-router/readiness

Reports private serving readiness without executing a user request.

Request schema:

```json
{
  "requestId": "string"
}
```

Response schema:

```json
{
  "requestId": "string",
  "ready": false,
  "privateServingReady": false,
  "effectiveRouterReady": false,
  "rawModelReady": false,
  "customGptReady": false,
  "publicReady": false,
  "checks": [
    {
      "name": "string",
      "passed": false,
      "details": "string"
    }
  ],
  "safety": {
    "openAiCalled": false,
    "trainingExecuted": false,
    "vllmUsed": false,
    "railwayCliUsed": false,
    "liveDbUsed": false,
    "noOpenAiOutputUsed": true
  }
}
```

Auth: private service or operator authentication only.

Rate limit: low-cost status limit per caller identity. Fail closed on abuse.

Audit: write request id, caller identity hash, readiness booleans, failed check
names, safety flags, and rollback state.

Failure modes: invalid auth, rate limit, missing readiness report, stale
readiness report, malformed report, rollback active, or internal check failure.

Rollback behavior: report `ready:false`, `privateServingReady:false`, and
`safety.flags` containing rollback state.

Safety flags: include applicable values such as `auth_failed`, `rate_limited`,
`readiness_report_missing`, `readiness_report_stale`,
`readiness_report_invalid`, and `rollback_active`.

## GET /private/gptoss/effective-router/release-gate

Reports whether the private serving release gate is satisfied. This endpoint is
for private deployment control only and must not run a release pipeline by
itself.

Request schema:

```json
{
  "requestId": "string"
}
```

Response schema:

```json
{
  "requestId": "string",
  "releaseAllowed": false,
  "privateServingReady": false,
  "effectiveRouterReady": false,
  "rawModelReady": false,
  "customGptReady": false,
  "publicReady": false,
  "requiredChecks": [
    {
      "name": "string",
      "passed": false,
      "blocking": true
    }
  ],
  "safety": {
    "openAiCalled": false,
    "trainingExecuted": false,
    "vllmUsed": false,
    "railwayCliUsed": false,
    "liveDbUsed": false,
    "noOpenAiOutputUsed": true
  }
}
```

Auth: private release service or operator authentication only.

Rate limit: strict per caller identity. This endpoint should be called by
release tooling, not request paths.

Audit: write request id, caller identity hash, release decision, check names,
blocking failures, safety flags, and rollback state.

Failure modes: invalid auth, rate limit, missing release report, stale release
report, malformed release report, readiness blocked, rollback active, or dirty
safety flags.

Rollback behavior: report `releaseAllowed:false` and include rollback state in
`safety.flags`.

Safety flags: include applicable values such as `auth_failed`, `rate_limited`,
`release_report_missing`, `release_report_stale`, `release_report_invalid`,
`readiness_blocked`, `dirty_safety_flags`, and `rollback_active`.
