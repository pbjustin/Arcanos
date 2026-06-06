# GPT-OSS Runtime Architecture

Phase 4 packages the current effective-router eval profile as a local,
controlled runtime contract. It is scaffolding only: it does not expose GPT-OSS
to cloud callers, Custom GPT actions, Railway, Trinity, GPT Access, or
production routing.

## Current Readiness

- Model-only score: `11/24`.
- Effective-router score: `24/24`.
- Model-only behavior is not ready.
- Local controlled runtime testing is the next safe target.
- Cloud and Custom GPT integration are not ready.

The effective score depends on deterministic local runtime supports:

- force-final channel handling
- router-classifier mode
- JSON prefill
- hard policy overrides
- local spec facts
- router postprocessor

These supports make the effective runtime pass the local eval profile. They do
not mean the model learned the behavior, and they must not be collapsed into the
raw model score.

## Runtime Contract

The local contract is defined by:

- `scripts/gptoss/effective-router-runtime.mjs`
- `schemas/gptoss-effective-router-runtime.schema.json`

Default runtime input:

```json
{
  "requestId": "runtime-dry-run",
  "userInput": "Write a TypeScript helper for dataset validation.",
  "mode": "router_classifier",
  "adapterDir": "local_artifacts/gptoss-phase3-8-lowlr",
  "runtimeSupports": {
    "forceFinalChannel": true,
    "routerClassifierMode": true,
    "prefillJsonStart": true,
    "hardPolicyOverrides": true,
    "localSpecFacts": true,
    "routerPostprocessor": true
  }
}
```

Runtime reports are local artifacts only and must stay under:

```text
local_artifacts/gptoss-runtime/
```

Dry-run and smoke modes do not load a model, train, call OpenAI, use vLLM, run
Railway CLI, or use a live database.

## Local Request CLI

Phase 4.1 adds a local request CLI:

```bash
node scripts/gptoss/effective-router-request.mjs --input "Write a TypeScript helper for dataset validation."
node scripts/gptoss/effective-router-request.mjs smoke
node scripts/gptoss/effective-router-request.mjs regress
```

The CLI validates requests against the runtime schema, applies only the local
deterministic effective-router support layers, and writes structured reports
under `local_artifacts/gptoss-runtime/`. It does not expose an HTTP server.
`--execute` alone is rejected. `--execute-local-model` is the explicit gated
flag for one-request local adapter execution through the existing
`eval-adapter-local` wrapper. Dry-run remains the default, and
`--execute-local-model --dry-run` does not load a model.

## Local Audit And Replay

Phase 4.3 adds local-only audit logging and replay support:

- `scripts/gptoss/effective-router-audit-log.mjs`
- `scripts/gptoss/effective-router-replay.mjs`

Audit records stay under `local_artifacts/gptoss-runtime/audit/`. They store an
input hash plus redacted, capped previews; they do not store raw secrets,
tokens, bearer values, database URLs, cookies, or raw environment values.

Replay reports stay under `local_artifacts/gptoss-runtime/replay/`. Replay is
dry-run by default and does not load the local model unless
`--execute-local-model` is explicitly supplied. Replay does not create a server
or change the cloud/Custom GPT boundary.

```bash
npm run gptoss:runtime:request:local-model:smoke:audit
npm run gptoss:runtime:audit:latest
npm run gptoss:runtime:request:replay -- --audit local_artifacts/gptoss-runtime/audit/<audit-file>.json
```

## Cloud Gate

Cloud readiness is blocked until a future design adds and validates all of the
following:

- serving path
- auth boundary
- action schema
- rate limits
- audit logs
- rollback behavior
- OpenAI reference comparison, still reference-only
- no OpenAI output training

No approved cloud auth boundary exists yet. No public action schema exists yet.
No serving path has been validated.

Direct Custom GPT to local GPT-OSS is disallowed. Custom GPTs must not call a
local `127.0.0.1`, `localhost`, WSL, or developer-machine GPT-OSS endpoint.

The local gate is:

```bash
npm run gptoss:runtime:cloud-gate
```

It is expected to report `cloudReady:false` and `customGptReady:false` until a
separate cloud exposure design is approved and implemented.

## Release Gate

Phase 4.5 adds a local release gate:

```bash
npm run gptoss:runtime:release-gate
```

The gate runs the baseline regression, effective-router regression, request
regression, readiness report, release manifest, and cloud gate. The cloud gate
returning blocked is success only when its report keeps `cloudReady:false`,
`customGptReady:false`, and direct Custom GPT local exposure disallowed.

The release gate fails closed on missing model/effective score fields, an
effective score below `24/24`, dirty safety flags, missing runtime supports,
tracked local artifact/model/cache files, or accidental cloud/Custom GPT
readiness. It writes only to
`local_artifacts/gptoss-runtime/release-gate-report.json`.

Phase 4.6 adds a CI-safe static gate:

```bash
npm run gptoss:runtime:release-gate:ci
```

This gate checks package scripts, the runtime schema, release-manifest schema
expectations, baseline metadata, runtime smoke fixtures, local spec facts, docs,
required runtime supports, and cloud/Custom GPT false readiness. It intentionally
skips local-only prerequisites such as `local_artifacts/`, adapter/model files,
CUDA, WSL, vLLM, Railway, OpenAI, live DB access, and server exposure.

The expected current state remains:

- model-only score: `11/24`
- effective-router score: `24/24`
- local controlled runtime ready: `true`
- model-only ready: `false`
- cloud ready: `false`
- Custom GPT ready: `false`

## Phase 5 Private Serving Scaffold

Phase 5 defines the private serving boundary. Phase 5.1 adds local-only
scaffold helpers under `scripts/gptoss/private-serving/`; it is not a serving
implementation. No HTTP server, listener, route handler, tunnel, deployment, or
Custom GPT action is created.

The scaffold covers:

- request signing canonicalization and hash helpers
- local HMAC-SHA256 request signing and verification helpers
- fail-closed signature verification scaffold
- local auth decision validation for signed envelopes
- in-memory replay protection scaffold for nonce reuse checks
- in-memory rate-limit policy evaluation for tests only
- response shaping that emits only the safe effective-router envelope
- structured denial responses
- scaffold validation and local scaffold reports

Current scaffold readiness fields are:

- `privateServingDesignReady:true`
- `privateServingScaffoldReady:true`
- `privateServingImplemented:false`
- `privateServingExposed:false`
- `requestSigningScaffoldReady:true`
- `requestSigningImplemented:true`
- `authBoundaryScaffoldReady:true`
- `authBoundaryImplemented:true`
- `replayProtectionScaffoldReady:true`
- `replayProtectionImplemented:false`
- `rateLimitScaffoldReady:true`
- `rateLimitImplemented:false`
- `responseShapingScaffoldReady:true`
- `publicServerCreated:false`
- `cloudReady:false`
- `customGptReady:false`

The signing and auth implementations are local helper logic only. They require
explicit local key material or a local/test key resolver, do not read
environment variables, and do not create production key management or endpoint
auth integration. Replay protection is scaffold/in-memory only.

Future work before any server or route includes production key management and
rotation, a durable private replay store, a durable private rate limiter, a
private network boundary, endpoint auth integration, audit sink approval,
rollback gate validation, and
penetration test or security review.

## Future Work Before Exposure

Before any cloud or Custom GPT exposure, add a separate reviewed design that
defines the provider boundary, auth, public action contract, request/response
schema, rate limits, audit logs, failure modes, rollback behavior, and
reference-only comparison rules. OpenAI outputs remain disallowed as training
labels.
