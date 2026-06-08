# GPT-OSS Private Serving Boundary

Phase 5 defines a private serving design for the GPT-OSS effective router. This
document is design-only. It does not add routes, schemas, scripts, model
execution, Railway behavior, database access, Custom GPT actions, or public
serving.

Phase 5.1 adds local-only scaffold helpers; it is not a serving
implementation. No HTTP server, listener, route handler, tunnel, deployment, or
Custom GPT action is created.

Phase 5.3 implements the local auth decision engine for signed private-serving
request envelopes. This remains helper logic only: no endpoint, server,
listener, route, tunnel, deployment, or Custom GPT action exists.

Phase 5.4 implements local replay protection helper logic with in-memory nonce
tracking for local tests. `replayProtectionImplemented:true` means only that
the helper-level/local test path exists. No durable replay store or persistent
nonce ledger is implemented. No endpoint/server exists.

## Purpose

The private serving boundary exists to let an approved Arcanos backend caller
ask the GPT-OSS effective router for classification and replay results while
preserving the Phase 4 posture:

- TypeScript owns the public protocol surface.
- Python and model execution stay behind the protocol boundary.
- GPT-OSS remains an internal decision-support runtime, not a public chat model.
- Effective-router behavior remains separate from raw model behavior.
- OpenAI reference output remains reference-only and never becomes training
  labels.
- Only effective-router contract output may be exposed.

## Private-Only Posture

All future Phase 5 GPT-OSS serving endpoints are private control-plane
endpoints. They must not be exposed to public unauthenticated callers, browser
clients, Custom GPT direct actions, public GPT Access routes, or Railway command
execution paths.

The required serving posture is:

- private-only
- authenticated
- request-signed
- rate-limited
- audited
- replayable
- fail-closed
- no raw shell
- no arbitrary tools
- no live Railway actions by default
- no live DB access by default
- no training path

The private boundary must fail closed when any required private serving control
is absent:

- service-to-service authentication
- route allowlist
- request schema validation
- response schema validation
- rate limit
- audit event write
- readiness gate
- rollback switch

No route may bypass these controls by falling back to `/gpt/:gptId`, raw
completion, shell execution, database query, Railway CLI, or training helpers.

## Required Runtime Stack

A future implementation must keep the stack split by responsibility:

- TypeScript private endpoint layer owns HTTP routing, auth, schema validation,
  rate limits, audit shape, rollback behavior, and response contracts.
- The effective-router runtime owns deterministic support layers, including
  force-final channel handling, router-classifier mode, JSON prefill, hard
  policy overrides, local spec facts, and router postprocessor.
- Audit logging, replay support, and the local/CI release gates remain required
  before any private serving milestone.
- Python or model-serving tools may run only behind the effective-router
  protocol boundary.
- vLLM or another OpenAI-compatible local/private model server may be used only
  as a private runtime dependency, never as a directly exposed raw completion
  endpoint.
- Local artifacts, capped previews, readiness reports, and replay reports must
  remain deterministic JSON artifacts.

Phase 5.1 scaffold helpers now exist under
`scripts/gptoss/private-serving/`:

- request signing verification is implemented locally with HMAC-SHA256 and
  fails closed without an explicitly supplied local signing key
- the auth decision engine validates request identity, timestamp skew, nonce
  shape, audience, signature, and replay-check availability
- replay protection is implemented locally with in-memory helper/test state
  only; no durable replay store or persistent nonce ledger exists
- rate limiting is in-memory scaffold policy only
- response shaping is a local helper that emits only the effective-router safe
  response envelope
- denial helpers emit structured fail-closed responses without stack traces
- scaffold validation confirms these helpers load without server/listener
  patterns

Phase 5.2 implements local HMAC-SHA256 request signing helpers in the signing
module. These helpers use only Node crypto, require an explicitly supplied
local signing key, and fail closed when no key is supplied. They do not read
environment variables and do not provide production key management, rotation,
or endpoint integration.

Phase 5.3 implements local auth decisions in
`scripts/gptoss/private-serving/private-serving-auth.mjs`. The helper requires
an explicit key resolver or local test key map, requires a `keyId`, requires a
subject or local/test subject derivation, and requires a replay checker. Without
those controls it fails closed. This is not production auth and does not make
private serving ready.

Phase 5.4 implements local replay protection in memory for helper-level tests.
A successful replay check is not durable replay protection and cannot be used
as a private serving exposure gate. `replayProtectionDurable:false` remains
blocking.

The effective router must continue to report raw model status separately from
effective-router status. A passing effective-router result does not imply that
the raw model is ready for direct serving.

## Exposure Rule

Private serving may expose only the effective-router result and safety envelope.
It must not expose raw model completions, hidden prompts, chain-of-thought,
system instructions, unredacted runtime logs, credentials, shell output,
database rows, or Railway command output.

Only this shape can be exposed in future private serving:

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

Endpoint-specific schemas may add private audit or replay metadata only outside
this exposed result body. Unknown exposed fields must be rejected until they are
added through a schema-first change.

## Raw Model Preview Rule

Raw model text may be logged only as capped/redacted preview in local audit artifacts, never exposed as the primary API result.
Any preview is diagnostic data for private audit and debugging only. When
present, it must be capped and redacted before it is written.

Minimum requirements:

- cap the preview to a fixed small character limit
- redact bearer tokens, API keys, cookies, database URLs, password-like values,
  credential-bearing URLs, and raw environment values
- omit hidden prompts, system instructions, and chain-of-thought
- omit the preview when it cannot be proven safe
- never treat the preview as a contract output or training label

The effective-router output remains authoritative for the endpoint contract.
Raw model preview text must not be used by public routing, GPT Access responses,
Custom GPT actions, or writing pipeline system operations.

## Non-Goals

Phase 5 private serving does not authorize:

- public chat clone endpoints
- raw completion endpoints
- public unauthenticated GPT-OSS access
- Custom GPT direct action access
- browser-client direct access
- shell, process, or filesystem operations
- Railway CLI execution or mutation
- database query endpoints
- training, fine-tuning, dataset export, or automatic data capture
- OpenAI output capture for training
- replacement of the TypeScript protocol surface with Python-owned routes

## Readiness Expectations

Private serving readiness must stay blocked until a future implementation can
prove all of the following with deterministic JSON reports:

- private auth is configured and enforced
- allowed endpoint schemas are validated
- forbidden endpoint classes fail closed
- rate limits are enforced
- audit events are written with capped and redacted previews
- readiness reports distinguish raw model readiness from effective-router
  readiness
- rollback disables GPT-OSS private serving without disabling unrelated backend
  routes
- release gate reports remain secret-free

Readiness must not depend on live OpenAI calls, live training, Railway CLI
mutation, public internet exposure, or live database mutation.

Current Phase 5.4 readiness remains unexposed:

- `privateServingDesignReady:true`
- `privateServingScaffoldReady:true`
- `privateServingImplemented:false`
- `privateServingExposed:false`
- `requestSigningScaffoldReady:true`
- `requestSigningImplemented:true`
- `authBoundaryScaffoldReady:true`
- `authBoundaryImplemented:true`
- `replayProtectionScaffoldReady:true`
- `replayProtectionImplemented:true`
- `replayProtectionDurable:false`
- `rateLimitScaffoldReady:true`
- `rateLimitImplemented:false`
- `responseShapingScaffoldReady:true`
- `publicServerCreated:false`
- `cloudReady:false`
- `customGptReady:false`

`replayProtectionImplemented:true` means helper-level/local test
implementation only. `replayProtectionDurable:false` blocks private serving
exposure.

Required future work before any exposure can be considered:

- durable replay store
- persistent nonce ledger
- key rotation
- production auth integration
- private network boundary
- server review

## Rollback Expectations

A future implementation must provide a single rollback control that disables all
GPT-OSS private serving endpoints and causes them to return a closed response.
Rollback must preserve audit logging for denied requests when safe to do so and
must not route requests to fallback public chat, raw completion, OpenAI,
Railway, shell, database, or training paths.

Rollback responses should keep the same effective plus safety envelope, with a
control-plane action, `allowedForTraining:false`, clean safety flags, and a
private audit reason that records the rollback state.
