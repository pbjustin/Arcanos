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

Expected Phase 5.3 local auth fields:

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
  "replayProtectionScaffoldReady": true,
  "replayProtectionImplemented": false,
  "rateLimitScaffoldReady": true,
  "rateLimitImplemented": false,
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
- replay protection is in-memory scaffold logic only and is not durable
- rate limiting is in-memory policy only
- response shaping strips raw model text and emits only the safe envelope
- denial helpers return structured refusals without stack traces
- scaffold validation scans for server/listener patterns and forbidden runtime
  paths

Future work required before any server:

- production key management and rotation
- durable private replay store
- durable private rate limiter
- private network boundary
- endpoint auth integration
- audit sink approval
- rollback gate
- penetration test or security review

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
