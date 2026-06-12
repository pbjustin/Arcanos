# GPT-OSS Durable Replay Implementation Readiness

This readiness review covers Sub-agent 2 storage decision review and
Sub-agent 5 key rotation review for future GPT-OSS private-serving durable
replay protection.

This document is governance-only. It does not implement durable replay
storage, connect to a database, apply migrations, create a server or listener,
expose an endpoint, call OpenAI, train, use vLLM, run Railway commands, or use
real secrets.

Current readiness remains blocked:

```json
{
  "replayProtectionDurableDesigned": true,
  "replayProtectionDurableImplemented": false,
  "replayProtectionDurable": false,
  "durableReplayMigrationApplyAllowed": false,
  "durableReplayMigrationApplied": false,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "cloudReady": false,
  "customGptReady": false
}
```

## Sub-agent 2 Storage Decision Review

Chosen future storage backend: PostgreSQL durable nonce ledger.

The selected future backend is a PostgreSQL table dedicated to GPT-OSS private
serving replay nonces, aligned with the existing design-only draft table
`gptoss_private_serving_replay_nonces`. The future authoritative uniqueness
key is `key_id + nonce_hash`, enforced atomically by a database unique
constraint. The raw nonce, raw request body, signatures, signing keys, bearer
tokens, cookies, passwords, database URLs, and unredacted headers must not be
stored.

This is a future storage decision only. No reviewed executable migration has
been promoted, no migration apply path is approved, and no live durable replay
store exists.

### Alternatives Considered

| Alternative | Decision | Reason |
| --- | --- | --- |
| In-memory process map | Rejected | Does not survive restart, cannot coordinate multiple workers, and is already limited to helper/local tests. |
| Redis `SET NX` with TTL | Rejected as source of truth | Provides atomic cache semantics but is not the durable replay ledger in the current architecture. It may only be considered later as a non-authoritative accelerator after PostgreSQL remains authoritative. |
| Local file or JSON artifact | Rejected | Cannot safely enforce concurrent uniqueness across processes, replicas, or hosts. Local artifacts remain diagnostic only. |
| Object storage append records | Rejected | Does not provide simple atomic `key_id + nonce_hash` conflict detection before serving behavior. |
| Audit log as replay ledger | Rejected | Audit records are for correlation and investigation, not the atomic replay decision path. Pruning replay records must not delete audit history. |
| Existing governance/eval tables | Rejected | Those tables have a different purpose and training-governance boundary. Replay nonce state needs a separate minimal ledger. |
| Key manager or secret store | Rejected for nonce storage | Key systems may manage signing key material and lifecycle metadata, but they are not the replay nonce ledger. |

### Reasons For Selection

- PostgreSQL supports an atomic unique constraint for `key_id + nonce_hash`.
- The architecture already treats Postgres as the durable system of record for
  persisted backend state.
- A separate table keeps replay decisions behind the protocol boundary and out
  of governance, audit, training, and writing-pipeline records.
- `expires_at` indexing supports deterministic pruning without storing raw
  request material.
- The backend can fail closed on unavailable or ambiguous writes instead of
  falling back to in-memory replay checks.
- The choice avoids introducing a new durable infrastructure dependency.

### Durability Requirements

- Accepted signed request nonces must survive process restart, deployment, and
  worker replacement.
- All private-serving instances for the same environment must share one
  authoritative nonce ledger.
- The insert or conflict decision must be atomic. A separate check-then-insert
  path is not acceptable unless protected by the same unique constraint or an
  equivalent atomic operation.
- Ambiguous write results, write timeouts, schema mismatches, missing store
  configuration, or store unavailability must fail closed before model or
  runtime behavior is invoked.
- Raw nonces must be hashed before storage. Raw request bodies, signatures, and
  secrets must never be stored in replay records.
- Durable replay readiness cannot be set true until validation proves the live
  store exists, is shared by all serving workers, and rejects duplicate
  `key_id + nonce_hash` records.

### Retention Requirements

- Each accepted nonce record must have an `expires_at` derived from the signed
  timestamp, configured replay window, and accepted future skew.
- Replay records must be retained at least until they can no longer be used to
  reject a replay inside any accepted window for the associated key.
- Pruning must be idempotent, bounded, and safe to rerun.
- Pruning replay records must not prune audit records.
- Retention must overlap key rotation windows so a request signed by an old but
  still verification-accepted key cannot reuse a nonce before its replay record
  expires.
- Retention settings must be configuration-reviewed before any future serving
  exposure; this document does not approve concrete production values.

### Replay Window Requirements

- Reject signed timestamps older than the configured replay window.
- Reject signed timestamps beyond the configured maximum future skew.
- Compute expiration from the accepted signed timestamp plus replay window plus
  accepted skew allowance.
- Fail closed when trusted time access, timestamp parsing, or replay window
  configuration is unavailable.
- The replay window must be short enough to limit replay risk and long enough
  to tolerate expected network delay and clock skew. Exact production values
  remain blocked pending implementation review.

### Audit Requirements

- Replay records should include only correlation fields such as request id,
  body hash, key id, subject hash when available, trace id, audit record id,
  first-seen time, expiration time, audience, and source marker.
- Audit records remain the diagnostic source. Replay records remain the nonce
  ledger.
- Duplicate nonce rejections must be auditable without exposing raw nonce,
  request body, signature, or secret material.
- Audit output must be deterministic JSON where practical and redacted before
  it is committed, exported, or reviewed.
- Replay storage must not become a training corpus or a writing pipeline input.

### Implementation Blockers

Durable replay remains unimplemented and blocked until a later approved phase:

- Promotes a reviewed migration from design draft to executable migration.
- Defines and approves the live database target and rollback controls.
- Implements the TypeScript-owned public protocol surface for replay decisions.
- Keeps Python behind the protocol boundary.
- Implements atomic insert-or-conflict behavior against the live store.
- Proves all serving workers share the same authoritative ledger.
- Adds production key management and rotation.
- Adds validation gates that prove `replayProtectionDurableImplemented:true`
  and `replayProtectionDurable:true` without weakening exposure gates.
- Preserves fail-closed behavior for missing store, write timeout, ambiguous
  write result, schema mismatch, and duplicate nonce conflict.

### Architecture Review Gap Summary

Sub-agent 1 identified these pre-implementation reconciliation items. They do
not require durable storage work in this phase, but they must be resolved before
a future implementation begins:

- Reconcile the public durable replay record contract with the physical storage
  shape. The design/schema record still describes raw `nonce`, `receivedAt`,
  and `auditCorrelation`, while the migration/insert-plan path uses
  `nonce_hash`, `first_seen_at`, and narrower correlation fields.
- Decide how the future table primary key is generated. The draft migration
  declares `id UUID PRIMARY KEY`, while the design-only insert-plan contract
  intentionally omits `id`.
- Align expiration semantics. The design says `expiresAt` includes replay
  window plus accepted future skew; the current insert-plan preview computes
  expiration from the replay window only.
- Keep the migration guard and implementation-plan validator aligned on
  required design-only markers, including `NO LIVE DB EXECUTION`.
- Add future adapter tests only after implementation approval for atomic insert
  conflict, timeout or ambiguous write denial, schema mismatch denial,
  durable-only exposed-path behavior, and no in-memory fallback for serving.

## Sub-agent 5 Key Rotation Review

Production key management and rotation are not implemented. Current local
signing helpers and key maps are not production key lifecycle controls.

### keyId Lifecycle

Future key metadata must model the lifecycle of each `keyId` without exposing
secret material:

| State | Meaning | Request behavior |
| --- | --- | --- |
| `pending` | Key is registered but not yet accepted for signing or verification. | Reject signed requests. |
| `active` | Key can sign new requests and verify incoming requests. | Accept only when signature, timestamp, audience, nonce, and replay checks pass. |
| `verify_only` | Key no longer signs new requests but remains valid for historical in-window verification. | Accept only within replay and rotation overlap windows. |
| `retired` | Key is outside all replay and overlap windows. | Reject new requests; keep metadata only as required for audit correlation. |
| `revoked` | Key is compromised, invalid, or administratively disabled. | Reject immediately, including otherwise in-window requests. |

`keyId` values are non-secret identifiers. They must be stable for audit
correlation, unique per signing key generation, and never reused for new key
material.

### Rotation Policy

- Introduce a new `keyId` in `pending` state before use.
- Promote the new key to `active` only after config distribution, validation,
  and audit readiness are complete.
- Move the previous active key to `verify_only` during the overlap period.
- Stop signing with the previous key immediately after the new key is active.
- Keep the previous key verifiable only for the maximum replay window plus
  accepted clock skew and any approved deployment propagation buffer.
- Move the previous key to `retired` after all overlap and replay retention
  requirements are satisfied.
- Move a key directly to `revoked` when compromise or invalid issuance is
  suspected; revoked keys must not remain verification-accepted.

No future rotation step may expose key material in logs, audit records, replay
records, committed docs, fixtures, or deterministic reports.

### Historical Replay Validation

- Historical replay validation must use the `keyId` recorded with the original
  request to select the correct verification key metadata.
- A nonce previously accepted for `key_id + nonce_hash` must remain a replay
  conflict for that pair until its retention window expires, even if the key is
  later moved to `verify_only` or `retired`.
- A new key may use the same raw nonce value only because the replay uniqueness
  scope is `keyId + nonce`; this must still store a separate `key_id +
  nonce_hash` record.
- Validation must prove replay rejection across restart and across serving
  workers before durable replay readiness changes.
- Historical validation must not call OpenAI, load vLLM, train, use Railway
  CLI, connect to unapproved databases, or use real secrets.

### Revoked Key Behavior

- Requests signed with a revoked `keyId` must fail closed before nonce insert,
  replay acceptance, audit replay execution, model routing, or runtime
  behavior.
- Revocation must not delete existing replay records or audit correlation
  needed for investigation.
- Revocation should produce a redacted audit event with `keyId`, request id
  when available, reason code, timestamp, and trace id when available.
- A revoked key must not be moved back to `active`; recovery requires issuing a
  new unique `keyId`.
- If revocation status cannot be loaded or trusted, private serving must reject
  the request rather than falling back to local test keys or in-memory replay.

### Retention Overlap Requirements

- Nonce retention must cover the full replay window for each key state that can
  verify requests.
- Rotation overlap must cover deployment propagation and clock skew without
  permitting the old key to sign new requests.
- Audit retention must outlive replay nonce retention so investigators can
  explain accepted requests, duplicate rejections, and revoked-key denials after
  nonce rows are pruned.
- A key cannot be retired until all accepted nonce rows for that key are either
  expired or retained only for audit correlation outside the serving decision
  path.
- A key cannot be revoked as a cleanup substitute for normal retirement;
  revocation is a fail-closed security action.

## Readiness Conclusion

Sub-agent 2 selects PostgreSQL as the future authoritative durable replay nonce
ledger, with atomic `key_id + nonce_hash` uniqueness and no raw nonce or secret
storage. Sub-agent 5 defines the future `keyId` lifecycle and rotation
requirements.

Durable replay remains unimplemented and blocked. Private serving, cloud
readiness, and Custom GPT readiness must remain false until a later approved
implementation proves durable replay storage, key rotation, audit behavior,
retention, replay-window enforcement, and fail-closed rollback behavior.
