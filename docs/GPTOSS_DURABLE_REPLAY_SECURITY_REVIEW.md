# GPT-OSS Durable Replay Security Review

This document records the security review checklist for the future GPT-OSS
durable replay store. This phase is readiness/governance only. It does not
implement durable replay storage, connect to a database, apply migrations,
create a server, expose an endpoint, call OpenAI, train, use vLLM, run Railway
commands, or use real secrets.

## Review Scope

Reviewed surface:

- durable replay storage design requirements
- future migration safety requirements
- replay/audit data handling rules
- exposure blockers for private serving, cloud, and Custom GPT access

Out of scope for this phase:

- live database access
- migration execution
- endpoint implementation
- server/listener creation
- model serving
- OpenAI calls
- training or fine-tuning
- vLLM serving
- Railway operations
- real secret handling

## Required Security Checklist

| Control | Required state | Current phase status |
| --- | --- | --- |
| No raw nonce storage | Store only a derived nonce hash scoped with key identity; never persist the client-supplied raw nonce. | Required and blocked from implementation in this phase. |
| No raw body storage | Store only body hash and redacted correlation metadata; never persist raw request bodies, raw prompts, or unredacted payloads. | Required and blocked from implementation in this phase. |
| No secret storage | Do not store signing secrets, bearer tokens, OpenAI keys, Railway tokens, cookies, session ids, database URLs, passwords, or raw environment values. | Required and blocked from implementation in this phase. |
| No signature storage | Do not persist request signatures or signature headers; signature material is validation input only. | Required and blocked from implementation in this phase. |
| No OpenAI contamination | Do not call OpenAI and do not allow OpenAI outputs, judgments, labels, or comparisons into durable replay artifacts or trainable records. | Required; no OpenAI call path is approved. |
| No training data ingestion | Treat replay and audit artifacts as non-trainable operational metadata; do not export them as JSONL or approved examples. | Required; training ingestion is prohibited. |
| No DB access in current phase | Do not open database connections, read live rows, write live rows, apply migrations, or perform DB dry-run execution against a live target. | Required; this phase is docs/governance only. |
| No endpoint exposure | Do not create a route, listener, tunnel, public URL, server, action handler, or serving bridge. | Required; private serving exposure remains blocked. |
| No Custom GPT access | Do not expose local or cloud GPT-OSS durable replay paths to Custom GPT actions. | Required; `customGptReady` remains false. |

## Additional Review Checks

- Durable replay must enforce atomic uniqueness for `keyId + nonce_hash`.
- Replay validation must happen before model/runtime invocation.
- Durable replay store unavailability must deny requests instead of falling
  back to in-memory replay.
- Write timeout or ambiguous write result must deny requests.
- Schema version mismatch must deny requests.
- Migration artifacts must remain design-only until a later reviewed phase.
- Audit records must stay redacted and must not contain raw bodies, raw nonces,
  signatures, secrets, or unredacted headers.
- Replay ledger rows must not become audit records or training examples.
- Readiness output must remain deterministic and must not require secrets.
- Cloud and public serving readiness must remain blocked until a separate
  exposure review approves auth, replay, audit, rate limits, and rollback.

## Current Readiness Finding

The current phase is acceptable only as governance documentation. It is not
approved for durable replay implementation, migration execution, database
access, private-serving exposure, cloud readiness, Custom GPT readiness, model
serving, OpenAI calls, or training data ingestion.

Expected readiness remains:

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

## Security Sign-Off Requirements For A Later Phase

A later implementation phase must receive a fresh review before any serving
exposure. That review must verify:

- the applied schema stores hashes and redacted metadata only
- the unique replay key is enforced atomically
- failure modes deny before runtime invocation
- audit output remains redacted
- no OpenAI output or request artifact is trainable
- no Custom GPT, public, or cloud route is reachable without approved auth,
  rate limits, durable replay, audit, and rollback controls
