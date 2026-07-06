# GPT-OSS Private Serving Threat Model

Phase 5 private serving is not approved for public, cloud, or Custom GPT
exposure yet. This threat model defines the minimum risks, mitigations, gates,
and current status for moving beyond the local controlled runtime.

Phase 5.1 adds local-only scaffold helpers for request signing, auth boundary
validation, rate-limit policy, response shaping, denial responses, and scaffold
validation. The scaffold is not a serving implementation and creates no server,
listener, tunnel, deployment, route handler, or Custom GPT action.

Phase 5.2 implements local HMAC-SHA256 request signing helpers with explicitly
supplied local signing keys. Production key management, rotation, endpoint
integration, and production auth remain incomplete.

Phase 5.3 implements the local auth decision engine for signed envelopes.
Phase 5.4 implements local replay protection in memory for helper-level/local
tests only. A durable replay store and persistent nonce ledger are not
implemented, no endpoint/server exists, and exposure remains blocked until
durable replay protection and production auth integration exist.

Phase 5.5 adds durable replay store design/schema/validation only. It documents
the future record shape, `keyId + nonce` uniqueness rule, timestamp window,
TTL/pruning policy, audit correlation fields, migration safety, and rollback
behavior without adding live DB access, a migration, a server, or endpoint
exposure.

Phase 5.6 adds an implementation plan, design-only migration draft, interface
contract, validation gate, and rollback plan. It still does not apply a
migration, connect to a live DB, create a server, or expose private serving.

Phase 5.8 completes durable replay implementation readiness review. It records
the future storage decision, key rotation requirements, rollback plan, security
checklist, and readiness validation. Durable replay storage is not started,
migration apply remains blocked, and private serving/cloud/Custom GPT exposure
remain blocked.

Phase 5.9 adds production key-management design and a planned key-rotation
runbook only. It does not load real signing keys, read keys from environment
variables, integrate with KMS, create production key resolution, or expose
serving. Request signing remains local/test-safe helper logic.

Phase 5.11 adds operations readiness, incident response, and go/no-go
checklists only. These documents do not approve server, cloud, private-network,
public, or Custom GPT exposure; `productionGoAllowed:false`,
`privateServingImplemented:false`, `privateServingExposed:false`,
`cloudReady:false`, and `customGptReady:false` remain required.

Current baseline:

- Local controlled runtime: ready for local testing only.
- Model-only readiness: blocked.
- Cloud readiness: blocked.
- Custom GPT readiness: blocked.
- OpenAI output as GPT-OSS training data: prohibited.

## Threats

| Threat | Risk | Mitigation | Required gate | Current status |
| --- | --- | --- | --- | --- |
| Direct public exposure risk | A private GPT-OSS endpoint could become reachable without the intended auth, schema, rate limit, and rollback boundaries. | Keep serving local/private by default; require an explicit serving design, authenticated gateway, request schema, rate limits, audit logs, and rollback plan before exposure. | `npm run gptoss:runtime:cloud-gate` and `npm run gptoss:runtime:release-gate` | Blocked. Cloud and public exposure are not approved. |
| Prompt injection | User text could try to override protocol rules, leak hidden context, or force unsafe actions. | Treat model output as untrusted; preserve deterministic hard policy overrides, router postprocessing, schema validation, and final-channel enforcement. | `npm run gptoss:runtime:request:regress` and `npm run gptoss:runtime:readiness` | Mitigated for local controlled runtime only; not sufficient for public serving. |
| Tool escalation | A model response could attempt to invoke privileged tools, system operations, Railway commands, database reads, or writing pipeline side effects. | Keep GPT-OSS behind the protocol boundary; expose no raw tool surface; require allowlisted actions and deny system operations through writing or model output paths. | `npm run gptoss:runtime:request:regress` and `npm run gptoss:runtime:release-gate` | Blocked for cloud use; local request path remains controlled. |
| Raw model output leakage | Raw generations could include analysis-style continuations, internal policy text, prompt fragments, or sensitive local context. | Force final-channel behavior, cap output, validate response envelopes, and keep raw local reports under ignored `local_artifacts/`. | `npm run gptoss:runtime:request:local-model:smoke` and `npm run gptoss:runtime:readiness` | Local smoke only; public output handling needs separate review. |
| Audit log secret leakage | Audit records could persist bearer tokens, OpenAI keys, Railway tokens, cookies, database URLs, passwords, or raw environment values. | Store hashes plus redacted, capped previews only; inspect latest audit records before release; never place secrets in committed docs or fixtures. | `npm run gptoss:runtime:audit:latest` and `npm run gptoss:runtime:release-gate` | Local audit path exists; must be inspected before any private serving release. |
| Replay abuse | Replay artifacts could become a way to re-run sensitive requests or load the local model outside the intended gate. | Keep replay dry-run by default; require explicit local execution flag for model loading; use audit file paths only under local artifacts; require durable replay protection before exposure. | `npm run gptoss:runtime:request:replay -- --audit local_artifacts/gptoss-runtime/audit/<audit-file>.json`, `npm run gptoss:private-serving:durable-replay:design:validate`, and `npm run gptoss:private-serving:durable-replay:implementation-plan:validate` | Local replay is dry-run by default. Private-serving replay protection is in-memory helper/local test implementation only. Durable replay is designed and planned but not implemented; `replayProtectionDurable:false` and no endpoint exists. |
| Durable replay implementation readiness drift | A future implementation could begin with unresolved schema, storage, retention, key-rotation, or rollback assumptions. | Keep Phase 5.8 as review-only; document storage, key rotation, rollback, and security requirements; require the readiness validator before any later implementation phase. | `npm run gptoss:private-serving:durable-replay:readiness:validate` | Readiness review is complete, but durable replay remains unimplemented and exposure remains blocked. |
| Request forgery | Unauthenticated callers or forged Custom GPT actions could submit requests to the private runtime. | Require an authenticated gateway and request signature or equivalent auth boundary before cloud exposure; reject direct local and Custom GPT access. | `npm run gptoss:private-serving:auth:validate` and `npm run gptoss:runtime:cloud-gate` | Local signing and auth decision helpers exist. Production auth integration and exposure remain blocked. |
| Production key compromise or rotation failure | Future production signing keys could be exposed, reused too long, rotated without overlap, or revoked without fail-closed behavior. | Keep Phase 5.9 design-only; require non-secret `keyId` metadata, no raw key logging, no secrets in repo, no environment key reads, no KMS integration in this phase, planned overlap windows, revoked-key denial, emergency disable, and fresh implementation review before exposure. | Future key-management implementation gate plus `npm run gptoss:runtime:cloud-gate` | Blocked. No real keys are loaded, production key management is not implemented, and `privateServingImplemented:false`, `privateServingExposed:false`, `cloudReady:false`, and `customGptReady:false` remain required. |
| Missing rate limits / durable rate-limit drift | Private serving could be exhausted or abused if request volume is unlimited or only local/in-memory counters exist. | Keep Phase 5.10 design-only; require per-key, per-subject, per-action, burst, abuse-mitigation, audit, fail-closed, and emergency block policy before any implementation. | `npm run gptoss:private-serving:rate-limit:design:validate` plus future private serving gate and `npm run gptoss:runtime:cloud-gate` | Blocked. Durable rate-limit design exists, but implementation is not approved; the current limiter remains local scaffold only, `durableRateLimitImplemented:false`, `rateLimitDurable:false`, `privateServingImplemented:false`, `privateServingExposed:false`, `cloudReady:false`, and `customGptReady:false` remain required. |
| Operations readiness drift | Incident response, rollback, or production go/no-go evidence could be missing or misread as approval to expose private serving. | Keep Phase 5.11 docs/schema/validation only; require operations readiness, incident response, and go/no-go validators while keeping `productionGoAllowed:false`. | `npm run gptoss:private-serving:operations:validate` plus `npm run gptoss:runtime:cloud-gate` | Blocked. Operations readiness is designed, incident response and go/no-go checklists exist, but production go remains false and exposure remains blocked. |
| Accidental training from requests | User prompts, logs, audit records, replay records, or Custom GPT action requests could be used as training data without consent and review. | Keep request/audit/replay artifacts non-trainable; dataset gates must reject `custom_gpt_action_request`, raw logs, unknown sources, and unreviewed model-generated labels. | `npm run gptoss:runtime:release-gate` | Mitigated by policy and current local gates; future exports require review. |
| OpenAI output contamination | OpenAI model outputs or judgments could enter GPT-OSS labels, reports marked trainable, or private serving comparisons. | Keep OpenAI reference mode disabled for runtime gates; mark eval and request reports `allowedForTraining:false`; reject OpenAI output sources. | `npm run gptoss:runtime:request:regress` and `npm run gptoss:runtime:release-gate:ci` | Prohibited. Current gates must keep OpenAI output non-training. |
| Railway command escalation | GPT-OSS output could be used to run Railway CLI commands, mutate services, read logs with secrets, or deploy. | Railway bridge remains observation-only and redacted; private serving must not expose Railway CLI, deployment, logs, or variable mutation to model output. | `npm run gptoss:runtime:release-gate` | Blocked for serving. No Railway command path is approved. |
| DB data leakage | Runtime or audit paths could expose raw rows, database URLs, job history, prompts, or internal state. | Do not connect to live DB in runtime gates; keep DB governance exports reviewed, redacted, and explicitly allowed before any dataset use. | `npm run gptoss:runtime:release-gate:ci` and future DB export validation | Blocked for private serving. No live DB serving path is approved. |
| Custom GPT direct-to-local exposure | A Custom GPT action could be pointed at `localhost`, `127.0.0.1`, WSL, or a developer machine endpoint. | Disallow direct Custom GPT to local GPT-OSS; require a separate cloud serving design, auth boundary, action schema, rate limits, audit logs, and rollback. | `npm run gptoss:runtime:cloud-gate` | Blocked. Expected state is `customGptReady:false`. |
| Rollback failure | A private serving release could lack a tested way to remove exposure, disable routing, or restore the last known safe provider. | Require rollback steps, owner confirmation, previous config capture, and post-rollback smoke checks before any exposure. | `npm run gptoss:runtime:release-gate` plus documented rollback runbook | Blocked until rollback is validated for the serving path. |

## Minimum Approval Criteria

Private serving cannot advance unless all of the following are true:

- `npm run gptoss:runtime:release-gate` passes locally.
- `npm run gptoss:runtime:release-gate:ci` passes in CI-safe mode.
- `npm run gptoss:runtime:cloud-gate` continues to block cloud and Custom GPT
  readiness until a separate serving design is approved.
- A durable replay store and persistent nonce ledger are implemented, and
  `replayProtectionDurable:true` is proven by a gate.
- Audit and replay artifacts are inspected and remain redacted.
- No OpenAI output, Railway observation, raw DB row, or Custom GPT request is
  marked as training data.
- A rollback path exists for the exact serving boundary being released.

## Phase 5 Local Replay And Key Status

- Request signing verification is implemented locally with HMAC-SHA256 and
  fails closed without an explicitly supplied local signing key.
- Production key management and rotation are not implemented.
- Phase 5.9 documents production key management and key rotation as design-only;
  no real keys are loaded, no environment key reads exist, no KMS integration
  exists, and request signing remains local/test-safe.
- The auth decision engine validates request identity, timestamp skew, nonce
  shape, audience, signature, and replay-check availability.
- Local replay protection is implemented in memory for helper-level/local tests
  only.
- `replayProtectionImplemented:true` means helper-level/local test
  implementation only.
- `replayProtectionDurableDesigned:true` means design/schema/validation only.
- `durableReplayImplementationReady:true` means readiness review is complete,
  not that durable replay storage exists.
- `replayProtectionDurableImplemented:false` and
  `replayProtectionDurable:false` block private serving exposure; durable
  replay store and persistent nonce ledger are not implemented.
- Phase 5.6 implementation planning includes only
  `migrations/drafts/gptoss_durable_replay_store.sql` and
  `scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs`.
  The draft migration must not be applied.
- No endpoint/server exists.
- The auth decision engine must not be treated as production endpoint auth.
- Rate limiting is in-memory scaffold policy only.
- Response shaping is a local helper that emits only the effective-router safe
  response envelope.
- Private serving remains unexposed:
  `privateServingImplemented:false`, `privateServingExposed:false`, and
  `publicServerCreated:false`.
- Cloud and Custom GPT remain blocked:
  `cloudReady:false`, `customGptReady:false`.
- Future work before exposure includes durable replay store implementation,
  persistent nonce ledger implementation, implemented production key management
  and key rotation, production auth integration, private network boundary, and
  server review.
