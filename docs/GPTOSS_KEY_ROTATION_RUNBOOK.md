# GPT-OSS Key Rotation Runbook

This runbook describes the planned production key rotation process for future
GPT-OSS private serving. It is design-only. It does not load real keys, read
keys from environment variables, integrate with KMS or another secret manager,
run migrations, create endpoints, start servers, deploy services, or expose
cloud or Custom GPT access.

Current request signing remains local/test-safe helper logic only. No
production signing keys are loaded in this phase.

Current blocked status:

```json
{
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "cloudReady": false,
  "customGptReady": false
}
```

## Preconditions

Do not execute this runbook against production systems in Phase 5.9. A later
implementation must first approve:

- production key storage and provisioning
- TypeScript key resolution
- durable replay storage
- persistent nonce ledger behavior
- rotation and revocation readiness gates
- audit redaction validation
- emergency disable ownership
- rollback ownership

The current repository contains design documentation only for these controls.

## Planned Rotation Process

Future scheduled rotation should use this sequence:

1. Open a rotation change record with the target environment, affected service
   identities, planned time window, rollback owner, and audit owner.
2. Confirm private serving is not public and Custom GPT exposure is not
   enabled.
3. Create new key metadata in `pending` state with a unique non-secret `keyId`.
4. Provision the new key through the future approved secret channel without
   logging or committing key material.
5. Validate that approved signers and verifiers can locate the new metadata
   without exposing the raw key.
6. Promote the new `keyId` to `active`.
7. Move the previous active `keyId` to `verify_only`.
8. Stop signing new requests with the previous key immediately.
9. Monitor signature failures, replay denials, rate-limit denials, and audit
   redaction results.
10. Retire the previous key only after the full overlap, replay, skew, and
   propagation windows have expired.

If any validation step cannot prove the expected state without exposing key
material, keep production private serving disabled or fail closed.

## Overlapping Validity Windows

Rotation must overlap verification, not signing.

- The new key signs and verifies after promotion to `active`.
- The previous key moves to `verify_only` and must not sign new requests.
- The previous key remains verification-accepted only for the approved overlap
  period.
- The overlap period must cover the replay window, accepted future clock skew,
  and deployment propagation buffer.
- The previous key must move to `retired` after overlap and nonce-retention
  requirements are satisfied.
- A revoked key bypasses overlap and is rejected immediately.

The overlap window must be short and explicit. It is not an authorization to
keep old keys active for convenience.

## Old-Key Replay Window Handling

The durable replay ledger must continue to enforce uniqueness for old keys
during the overlap window.

Required behavior:

- Accepted requests are recorded by `keyId + nonce` after nonce hashing in the
  future durable ledger.
- Duplicate `keyId + nonce` pairs are rejected even when the key is
  `verify_only`.
- Old-key nonce records are retained until their replay window, accepted skew,
  and approved propagation buffer have expired.
- Retiring a key does not delete audit records.
- Pruning replay records must not prune audit records.
- The system must fail closed if durable replay state is missing, stale,
  ambiguous, or unavailable.

A new key may receive the same raw nonce value only because replay uniqueness is
scoped by `keyId + nonce`. It still needs a separate durable replay decision.

## Revoked Key Handling

Use revocation for suspected compromise, invalid issuance, unauthorized
distribution, or emergency administrative disable.

Required revoked-key behavior:

- Reject matching requests immediately.
- Deny before nonce insert, replay acceptance, rate-limit consumption,
  effective-router execution, model behavior, or endpoint response generation.
- Write a redacted audit event when safe.
- Preserve existing replay and audit metadata for investigation.
- Do not move the key back to `active`.
- Do not use revocation as a normal cleanup substitute for retirement.
- Issue a new unique `keyId` for any recovery.

If revocation state is unavailable or cannot be trusted, future private serving
must reject instead of falling back to local test keys or in-memory replay.

## Rollback Process

Rollback is allowed only when the previous key is not suspected to be
compromised and is still inside the approved overlap window.

Planned rollback steps:

1. Stop signing with the newly promoted key.
2. Restore the previous key from `verify_only` to `active` only if it is not
   revoked, not compromised, and still inside the approved overlap window.
3. Move the failed new key to `retired` or `revoked` based on incident review.
4. Confirm no request path falls back to public chat, raw completion, OpenAI,
   vLLM, Railway, shell, live database access, training, or Custom GPT routes.
5. Preserve redacted audit records and replay metadata for the rotation window.
6. Keep or return readiness output to blocked status if any required control is
   uncertain.

If compromise is suspected, do not roll back to the previous key. Use the
emergency disable checklist.

## Emergency Key Disable Checklist

Use this checklist for suspected key compromise or unsafe key distribution:

- Identify the affected non-secret `keyId` values.
- Mark affected keys `revoked` or activate the future global signing disable
  control.
- Stop signing new GPT-OSS private-serving requests.
- Deny verification for affected keys before durable replay writes or runtime
  invocation.
- Confirm private serving exposure remains blocked.
- Confirm `privateServingImplemented:false`.
- Confirm `privateServingExposed:false`.
- Confirm `cloudReady:false`.
- Confirm `customGptReady:false`.
- Preserve redacted audit records, replay metadata, and readiness output.
- Check that no raw signing keys, signatures, raw nonces, request bodies, or
  raw environment values were logged.
- Check that no secrets were committed to the repository.
- Rotate to a new unique `keyId` only after a fresh review approves recovery.
- Do not re-enable production private serving until key management, durable
  replay, audit, rollback, and exposure gates pass.

## Prohibited Actions

Do not perform any of the following in Phase 5.9:

- Load real signing keys.
- Read signing keys from environment variables.
- Add KMS or secret-manager integration.
- Commit key material or secret-shaped examples.
- Add server endpoints, listeners, route handlers, tunnels, or deployments.
- Connect to live databases.
- Run Railway commands.
- Call OpenAI.
- Start vLLM serving.
- Train or fine-tune models.
- Expose Custom GPT actions.
- Change `privateServingImplemented`, `privateServingExposed`, `cloudReady`, or
  `customGptReady` away from `false`.
