# GPT-OSS Durable Replay Rollback Plan

This document defines the rollback posture for the future GPT-OSS durable replay
store. This phase is readiness/governance only. It does not implement durable
replay storage, connect to a database, apply migrations, create a server,
expose an endpoint, call OpenAI, train, use vLLM, run Railway commands, or use
real secrets.

This document contains no executable rollback code.

## Scope

The rollback plan applies to the future persistent nonce ledger for signed
private-serving requests. The current repository state remains design/planning
only for durable replay storage.

Rollback must preserve these boundaries:

- TypeScript owns the public protocol surface.
- Python and model runtime behavior stay behind the protocol boundary.
- Private serving remains disabled unless durable replay, auth, audit, and
  exposure gates are separately reviewed and approved.
- System operations must not be routed through writing, replay, audit, or model
  output paths.

## Migration Rollback Strategy

Current phase:

- No durable replay migration is applied.
- No database connection is opened.
- No rollback migration is required because no live schema change occurs.
- Any migration artifact remains a blocked design draft unless promoted by a
  later reviewed phase.

Future reviewed migration:

- Apply any durable replay migration only after explicit review of the target
  environment, schema version, rollback owner, and exposure boundary.
- Keep private serving disabled during migration rollout.
- Prefer additive, reversible schema changes that can be disabled without data
  loss.
- If migration validation fails before exposure, leave private serving disabled
  and revert only through a reviewed database rollback process.
- If failure occurs after a future exposure, first disable serving and routing,
  then assess whether schema rollback is safe.
- Do not delete audit records during rollback.
- Do not backfill or recover from raw request bodies, raw nonces, signatures,
  secrets, OpenAI outputs, or training data.

The replay ledger is not the audit source of record. Ledger rows may be retained
for incident review and pruned only according to the approved TTL/pruning
policy after incident preservation requirements are satisfied.

## Feature Disable Strategy

Rollback must disable the serving feature rather than downgrade protection.

Required disabled state:

```json
{
  "replayProtectionDurableImplemented": false,
  "replayProtectionDurable": false,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "cloudReady": false,
  "customGptReady": false
}
```

Future feature controls must be able to block:

- private-serving request acceptance
- durable replay writes
- model/runtime invocation from private-serving requests
- cloud routing
- Custom GPT routing
- fallback to public chat, OpenAI, vLLM, Railway, shell, live database, or
  training paths

Disablement must be observable through deterministic readiness output. It must
not depend on reading secrets or invoking external services.

## Replay Fallback Behavior

Exposed private serving must not fall back to in-memory replay protection.

Required behavior:

- If the durable replay store is unavailable, reject the request before model or
  runtime invocation.
- If atomic uniqueness is unavailable, reject the request.
- If a `keyId + nonce_hash` conflict occurs, reject the request as replay.
- If the write result is timed out or ambiguous, reject the request.
- If schema version validation fails, reject the request.
- If timestamp, key id, nonce shape, or body hash validation fails, reject the
  request.

The only acceptable current fallback is no serving. Local in-memory replay
helpers remain helper/test-only and must not become an exposed serving fallback.

## Audit Preservation

Rollback must preserve enough evidence to diagnose the incident without storing
unsafe material.

Preserve:

- redacted audit records
- request ids
- trace ids
- key ids
- body hashes
- nonce hashes
- decision categories
- timestamps
- schema and readiness states

Do not preserve:

- raw nonces
- raw request bodies
- raw prompts
- signatures
- signing secrets
- bearer tokens
- cookies
- session ids
- database URLs
- OpenAI keys
- Railway tokens
- unredacted headers

Audit records must not be converted into training data. Replay records remain
non-trainable operational metadata.

## Incident Recovery Checklist

- Confirm private serving is not accepting requests.
- Confirm cloud and Custom GPT readiness remain blocked.
- Freeze the relevant configuration, readiness output, and audit state for
  review.
- Identify the rollback trigger: migration failure, schema mismatch, replay
  store outage, write ambiguity, replay conflict handling bug, audit leak, or
  exposure mistake.
- Preserve redacted audit artifacts and replay ledger metadata needed for
  correlation.
- Verify no raw nonce, raw body, signature, secret, OpenAI output, or training
  data was stored.
- If key compromise is suspected, rotate affected signing material through the
  approved key-management path before any future re-enable.
- If partial schema changes exist in a future phase, assess them through a
  metadata-only review before any database rollback.
- Document affected time window, affected key ids, affected request ids, and
  user-visible impact.
- Require a fresh security review, replay validation, audit review, and owner
  approval before re-enabling any private-serving path.

## Fail-Closed Requirements

Rollback and future runtime behavior must fail closed for:

- missing durable replay store
- durable replay store connectivity failure
- write timeout or ambiguous write result
- uniqueness conflict for `keyId + nonce_hash`
- migration/schema version mismatch
- missing or invalid key id
- missing or invalid nonce hash
- stale or future timestamp
- invalid body hash
- audit redaction failure
- configuration mismatch
- readiness gate failure

Fail-closed means the request is denied before invoking model/runtime behavior.
It must not route to OpenAI, vLLM, public chat, Railway, shell, live database,
training, or Custom GPT paths.

## Re-Enable Criteria

Re-enable is out of scope for this phase. A later phase may only consider
re-enable after:

- durable replay storage is implemented and reviewed
- atomic uniqueness is proven
- audit output is verified redacted
- rollback has been tested for the exact serving boundary
- cloud and Custom GPT exposure are separately approved
- readiness output proves durable replay and serving status deterministically
