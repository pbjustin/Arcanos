# GPT-OSS Private Serving Runbook

This runbook is for Phase 5 private serving design checks only. It does not
authorize public exposure, Custom GPT actions, Railway mutation, live DB access,
training, vLLM serving, OpenAI calls, or starting a server.

Phase 5.1 adds local-only scaffold helpers. The scaffold is not a serving
implementation: no HTTP server, listener, route handler, tunnel, deployment, or
Custom GPT action exists.

Phase 5.2 implements local HMAC-SHA256 request signing helpers. They require an
explicitly supplied local signing key, do not read environment variables, and do
not provide production key management or endpoint integration.

Phase 5.3 implements local auth decision helpers. They validate signed request
identity, timestamp skew, nonce shape, audience, signature, and replay-check
availability. They do not create a server and are not production endpoint auth.

Phase 5.4 implements local replay protection helper logic with in-memory nonce
tracking for local tests only. It does not create a durable replay store,
persistent nonce ledger, endpoint, or server. No endpoint/server exists.

Phase 5.5 adds durable replay store design/schema/validation only. It does not
create a live DB store, SQL migration, endpoint, server, Railway command path,
OpenAI call, training path, or vLLM serving path.

Phase 5.6 adds a durable replay implementation plan, a design-only migration
draft, a no-DB interface contract, validation gate, and rollback plan. It does
not connect to a live DB, apply a migration, create a server, or expose an
endpoint.

Phase 5.7 adds a durable replay migration guard. The guard validates the draft
only; migration apply remains blocked, no migration execution exists, no DB
connectivity exists, durable replay remains unimplemented, and exposure remains
blocked.

Phase 5.8 completes durable replay implementation readiness review. It adds
storage-decision, key-rotation, rollback, and security review documentation plus
a readiness validator. It does not implement durable replay storage, connect to
a database, apply migrations, create a server, expose an endpoint, or change
cloud/Custom GPT readiness.

Phase 5.9 adds production key-management design and a planned key-rotation
runbook only. It does not load real signing keys, read keys from environment
variables, integrate with KMS, create a production key resolver, expose an
endpoint, or change the local/test-safe request signing helper boundary.

Phase 5.12 completes the final private-serving architecture readiness review.
`phase6ImplementationReady:true` and
`finalArchitectureReadinessReviewed:true` allow bounded Phase 6 internal
implementation planning and work to begin. They do not authorize a public
server, listener, endpoint, live DB connection, deployment, production use, or
cloud/Custom GPT exposure. `productionGoAllowed:false`,
`privateServingImplemented:false`, `privateServingExposed:false`,
`cloudReady:false`, and `customGptReady:false` remain required.

## Preflight

Confirm the checkout and scripts without running a model:

```bash
npm run probe
npm run gptoss:runtime:release-gate:ci
```

Confirm local controlled readiness reports can be generated:

```bash
npm run gptoss:runtime:readiness
npm run gptoss:runtime:cloud-gate
```

Expected current cloud gate outcome:

```json
{
  "cloudReady": false,
  "customGptReady": false,
  "localControlledRuntimeReady": true
}
```

## Release Gates

Run the full local release gate before any private serving milestone:

```bash
npm run gptoss:runtime:release-gate
```

Run the CI-safe gate for static validation:

```bash
npm run gptoss:runtime:release-gate:ci
```

Run the private serving design and scaffold validators:

```bash
npm run gptoss:private-serving:design:validate
npm run gptoss:private-serving:threat-model:validate
npm run gptoss:private-serving:durable-replay:design:validate
npm run gptoss:private-serving:durable-replay:implementation-plan:validate
npm run gptoss:private-serving:durable-replay:migration-guard
npm run gptoss:private-serving:durable-replay:readiness:validate
npm run gptoss:private-serving:key-management:design:validate
npm run gptoss:private-serving:rate-limit:design:validate
npm run gptoss:private-serving:operations:validate
npm run gptoss:private-serving:final-readiness:validate
npm run gptoss:private-serving:auth:validate
npm run gptoss:private-serving:scaffold:validate
```

Generate the local scaffold PR report when preparing a review:

```bash
npm run gptoss:private-serving:scaffold:report
```

Run the request regression gate:

```bash
npm run gptoss:runtime:request:regress
```

The cloud gate must remain blocked until a separate private serving design adds
auth, action schema, rate limits, audit handling, and rollback:

```bash
npm run gptoss:runtime:cloud-gate
```

## Local Readiness

Generate the local readiness report:

```bash
npm run gptoss:runtime:readiness
```

Pass criteria:

- Local controlled runtime is ready.
- Model-only readiness remains false unless separately approved.
- Cloud readiness remains false.
- Custom GPT readiness remains false.
- Required runtime supports remain enabled in the readiness report.
- Phase 5.1 scaffold readiness is true.
- Private serving implementation and exposure remain false.
- Public server creation remains false.
- `replayProtectionImplemented:true` means helper-level/local test
  implementation only.
- `replayProtectionDurableDesigned:true` means design/schema/validation only.
- `durableReplayImplementationReady:true` means readiness review is complete;
  it does not mean durable replay storage exists.
- `replayProtectionDurableImplemented:false` confirms the Phase 5.6 plan,
  draft migration, and contract do not enable a live durable store.
- `replayProtectionDurable:false` blocks private serving exposure.
- `durableReplayMigrationDraftReady:true` confirms the draft passes guarded
  review checks.
- `durableReplayMigrationApplyAllowed:false` and
  `durableReplayMigrationApplied:false` confirm no live migration path is
  enabled.
- Phase 5.9 production key management is design-only; no real keys are loaded,
  no environment key reads or KMS integration exist, and
  `privateServingImplemented:false`, `privateServingExposed:false`,
  `cloudReady:false`, and `customGptReady:false` remain required.
- Phase 5.10 durable rate-limit governance is design-only. The current rate
  limiter remains local/in-memory scaffold logic; no durable backend, DB client,
  migration apply path, server, listener, or endpoint exists.
- Phase 5.11 operations readiness, incident response, and go/no-go checklists
  are docs/schema/validation only. `productionGoAllowed:false`,
  `privateServingImplemented:false`, `privateServingExposed:false`,
  `cloudReady:false`, and `customGptReady:false` remain required.
- Phase 5.12 final architecture review permits bounded Phase 6 internal
  implementation planning and work only. It does not approve production,
  serving exposure, cloud deployment, or a Custom GPT bridge.

Expected current local replay fields:

```json
{
  "privateServingDesignReady": true,
  "privateServingScaffoldReady": true,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "requestSigningScaffoldReady": true,
  "requestSigningImplemented": true,
  "authBoundaryScaffoldReady": true,
  "authBoundaryImplemented": true,
  "productionKeyManagementDesigned": true,
  "productionKeyManagementImplemented": false,
  "realSecretsUsed": false,
  "envSecretsRead": false,
  "kmsIntegrated": false,
  "replayProtectionScaffoldReady": true,
  "replayProtectionImplemented": true,
  "replayProtectionDurableDesigned": true,
  "durableReplayImplementationReady": true,
  "replayProtectionDurableImplemented": false,
  "replayProtectionDurable": false,
  "durableReplayMigrationDraftReady": true,
  "durableReplayMigrationApplyAllowed": false,
  "durableReplayMigrationApplied": false,
  "rateLimitScaffoldReady": true,
  "rateLimitImplemented": false,
  "durableRateLimitDesigned": true,
  "durableRateLimitImplemented": false,
  "rateLimitDurable": false,
  "operationsReadinessDesigned": true,
  "incidentResponseReady": true,
  "productionGoNoGoChecklistReady": true,
  "finalArchitectureReadinessReviewed": true,
  "phase6ImplementationReady": true,
  "productionGoAllowed": false,
  "responseShapingScaffoldReady": true,
  "publicServerCreated": false,
  "cloudReady": false,
  "customGptReady": false
}
```

## Phase 5.1 Scaffold Notes

The scaffold modules live under `scripts/gptoss/private-serving/` and are pure
local helpers:

- request signing verification is implemented locally and fails closed when no
  explicit local signing key is supplied
- auth decision validation is implemented locally and fails closed without an
  explicit key resolver or local test key map, valid signature, accepted nonce,
  and replay checker
- Phase 5.4 replay protection is implemented in memory for helper-level/local
  tests only; no durable replay store or persistent nonce ledger exists
- Phase 5.5 durable replay design is documented and schema-validated only; no
  live DB store or migration is wired
- Phase 5.6 durable replay implementation planning exists; the migration draft
  is under `migrations/drafts/`, the guard validates draft safety only,
  migration apply is blocked, and no migration execution path, DB connectivity,
  or live durable store exists
- Phase 5.8 durable replay implementation readiness review is complete; storage
  selection, key rotation, rollback, and security controls are documented, but
  durable replay storage is not started
- Phase 5.9 production key-management design and key-rotation runbook exist,
  but no real keys are loaded, no environment key reads or KMS integration
  exist, and production key management is not implemented
- rate limiting is in-memory policy only
- response shaping strips raw model text and emits only the safe envelope
- denial helpers return structured refusals without stack traces
- scaffold validation scans for server/listener patterns and forbidden runtime
  paths

Future work required before any exposure:

- reviewed durable replay store implementation
- persistent nonce ledger implementation
- implemented production key management and key rotation
- production auth integration
- private network boundary
- server review

## Local Request Smoke

Run request regression first:

```bash
npm run gptoss:runtime:request:regress
```

Run the one-request local-model smoke only on a machine prepared for local model
execution, and only after dry/static gates pass:

```bash
npm run gptoss:runtime:request:local-model:smoke
```

The smoke must keep OpenAI, training, vLLM, Railway CLI, live DB access, and
server exposure disabled. Reports stay under `local_artifacts/gptoss-runtime/`.

## Inspect Audit Logs

Create or use the latest local audit artifact, then inspect it:

```bash
npm run gptoss:runtime:request:local-model:smoke:audit
npm run gptoss:runtime:audit:latest
```

Audit checks:

- Inputs are represented by hashes and redacted capped previews.
- No bearer tokens, OpenAI keys, Railway tokens, cookies, session IDs, database
  URLs, Redis/Postgres URLs, passwords, or raw environment values appear.
- Audit paths remain under `local_artifacts/gptoss-runtime/audit/`.
- Audit records are not marked as training data.

## Replay Audit

Replay is dry-run by default:

```bash
npm run gptoss:runtime:request:replay -- --audit local_artifacts/gptoss-runtime/audit/<audit-file>.json
```

Replay checks:

- The replay uses a local audit path only.
- The replay does not start a server.
- The replay does not call OpenAI, Railway, vLLM, or a live DB.
- The replay does not load the local model unless a separate local execution
  step explicitly supplies the required execution flag.
- Phase 5.4 replay protection is local memory only.
- Phase 5.5 durable replay is design/schema/validation only; durable replay
  remains false and blocks exposure.
- Phase 5.10 durable rate-limit design is schema/validation only; durable
  counters remain false and block exposure.

Run the Phase 5.10 design validator:

```bash
npm run gptoss:private-serving:rate-limit:design:validate
```

## Verify Cloud And Custom GPT Blocked

Run:

```bash
npm run gptoss:runtime:cloud-gate
```

Required blocked state:

- `cloudReady:false`
- `customGptReady:false`
- direct Custom GPT to local exposure disallowed
- no approved public action schema
- no approved cloud auth boundary
- no approved serving rate limits
- no durable private rate-limit backend
- no approved rollback for exposure

Do not point Custom GPT actions at `localhost`, `127.0.0.1`, WSL, or a
developer-machine GPT-OSS endpoint.

## Rollback Steps

Use these steps for a future private serving boundary after it is explicitly
approved:

1. Capture the current private serving config, route target, auth boundary, and
   last passing gate report path without recording secrets.
2. Disable the private GPT-OSS route or feature flag.
3. Restore the previous approved provider or local-only fallback.
4. Remove or revoke the temporary private serving endpoint credentials.
5. Run:

```bash
npm run gptoss:runtime:cloud-gate
npm run gptoss:runtime:request:regress
npm run gptoss:runtime:readiness
```

6. Confirm cloud and Custom GPT exposure are blocked after rollback.
7. Inspect audit logs for failed or post-rollback requests.

## Do Not Run

Do not run these during this design/runbook validation:

- Heavy model execution beyond the explicit local smoke command.
- OpenAI API calls.
- Training or fine-tuning commands.
- vLLM serve commands.
- Railway CLI commands, including deploy, logs, variables, or service mutation.
- Live database commands or SQL shells.
- Server startup commands such as `npm start`, `npm run dev`, or HTTP listener
  wrappers.
- Custom GPT action exposure to local, WSL, cloud, or developer-machine
  endpoints.
- Any command that writes secrets, raw model outputs, raw DB rows, or Railway
  output into committed files.
