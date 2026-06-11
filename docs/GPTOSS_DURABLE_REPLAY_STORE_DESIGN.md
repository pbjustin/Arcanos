# GPT-OSS Durable Replay Store Design

Phase 5.5 defines the durable replay store shape for GPT-OSS private serving.
This phase is design/schema/validation only. It does not implement a live
store, create a server, expose an endpoint, open a database connection, run a
migration, call OpenAI, train, use vLLM, or run Railway commands.

## Purpose

The durable replay store is the future persistent nonce ledger for signed
private-serving requests. Its job is to prevent reuse of a signed request inside
the accepted timestamp window even when the process restarts or multiple
private-serving workers exist.

Phase 5.5 records the target contract only:

- `replayProtectionDurableDesigned:true`
- `replayProtectionDurableImplemented:false`
- `replayProtectionDurable:false`
- `privateServingImplemented:false`
- `privateServingExposed:false`
- `cloudReady:false`
- `customGptReady:false`

Phase 5.6 adds the implementation plan, design-only migration draft, interface
contract, validation gate, and rollback plan. It still does not implement a live
store or change durable replay readiness.

Phase 5.6 artifacts:

- `docs/GPTOSS_DURABLE_REPLAY_STORE_IMPLEMENTATION_PLAN.md`
- `migrations/drafts/gptoss_durable_replay_store.sql`
- `scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs`
- `scripts/gptoss/private-serving/private-serving-durable-replay-implementation-plan-validate.mjs`

## Table Or Record Shape

Future storage must model one immutable replay ledger record per accepted
signed request nonce:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Replay store record schema version. |
| `keyId` | Signing key identifier used to scope nonce uniqueness. |
| `nonce` | Client supplied nonce after shape validation. |
| `uniquenessScope` | Constant `keyId+nonce`. |
| `requestId` | Signed request id for audit correlation. |
| `bodyHash` | SHA-256 hash of the canonical signed body. |
| `timestamp` | Client supplied signed timestamp. |
| `receivedAt` | Server receipt time used for pruning and audit ordering. |
| `expiresAt` | Timestamp after which the replay record can be pruned. |
| `auditCorrelation` | Structured audit join fields. |
| `rawRequestBodyStored` | Constant `false`. |
| `secretsStored` | Constant `false`. |

The record must not store raw request body text, raw prompt text, signatures,
signing secrets, bearer tokens, cookies, environment values, database
credentials, or unredacted headers.

## Nonce Uniqueness Rule

The uniqueness rule is exactly `keyId + nonce`.

Two requests with the same `nonce` but different `keyId` values are separate
ledger entries. Two requests with the same `keyId` and `nonce` are a replay and
must be rejected before invoking any model/runtime behavior.

The future store must enforce this rule atomically. A check-then-insert race is
not sufficient unless it is backed by a unique constraint or equivalent atomic
insert operation.

## Timestamp Window

The replay policy uses the signed request timestamp and the local receipt time:

- reject stale timestamps older than `replayWindowSeconds`
- reject future timestamps beyond `maxFutureSkewSeconds`
- set `expiresAt` to the accepted timestamp plus the replay window plus the
  accepted future skew allowance
- fail closed if timestamp parsing or trusted clock access is unavailable

Phase 5.5 keeps the existing local helper window values as policy examples
only. No production clock, cluster clock, or durable write path is added.

## TTL And Pruning Policy

Future pruning must delete only records whose `expiresAt` is older than the
configured TTL horizon. Pruning can be implemented as either batch deletion or
partition expiration, but it must be idempotent and safe to run repeatedly.

Expired records can be removed after they are no longer needed to reject replay
within the accepted window. Pruning must not delete audit records. The replay
ledger stores only enough data to reject nonce reuse and correlate to audit.

## Audit Correlation Fields

Each durable replay record should include:

- `requestId`
- `bodyHash`
- `keyId`
- `subjectHash`, when a subject is available
- `traceId`
- `auditRecordId`

These fields let an operator correlate replay rejections without storing raw
request bodies or secrets. Audit records remain the diagnostic source; replay
records remain the nonce ledger.

## Failure Modes

Future private serving must fail closed for:

- durable replay store unavailable
- atomic uniqueness check unavailable
- replay insert conflict for `keyId + nonce`
- stale or future timestamp
- invalid nonce shape
- invalid or missing `keyId`
- write timeout or ambiguous write result
- pruning job failure that threatens storage capacity
- schema version mismatch

No failure mode may fall back to in-memory replay protection for an exposed
private serving path. In-memory replay remains helper/test-only.

## Migration Safety

This phase adds no live migration. A future migration must be separately
reviewed, reversible, and safe to apply before any serving exposure. It must not
backfill raw requests, signatures, secrets, or request bodies.

If a SQL artifact is added later for design discussion, it must be explicitly
marked design-only and must not be wired to deployment or startup commands.

Phase 5.6 adds a draft SQL file under `migrations/drafts/`. It is marked
`DESIGN DRAFT ONLY`, `DO NOT APPLY`, and `NO LIVE DB EXECUTION`. It uses
`nonce_hash`, not a raw nonce column, and declares unique `key_id` plus
`nonce_hash` as the future atomic replay key.

## Rollback Behavior

If durable replay validation fails after a future implementation, private
serving must be disabled rather than downgraded to non-durable replay checks.
Rollback should keep existing denied/audit behavior available when safe, but it
must not route requests to public chat, raw completion, OpenAI, vLLM, Railway,
shell, live database, or training paths.

Rollback must preserve these blocked readiness fields until a later reviewed
implementation proves otherwise:

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

## Phase 5.5 Non-Implementation Boundaries

Phase 5.5 explicitly does not include:

- raw request body storage
- secret storage
- live DB access
- SQL migration execution
- server or listener creation
- endpoint exposure
- OpenAI calls
- training or fine-tuning
- vLLM serving
- Railway CLI execution

## Phase 5.6 Implementation Plan Boundary

Phase 5.6 also explicitly does not include live DB access, migration
application, endpoint exposure, server creation, OpenAI calls, training, vLLM,
Railway CLI execution, or real secrets. The contract module builds deterministic
JSON insert plans only and must not execute SQL.
