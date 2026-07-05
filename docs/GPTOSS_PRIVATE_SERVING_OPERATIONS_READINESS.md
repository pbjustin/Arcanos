# GPT-OSS Private Serving Operations Readiness

This Phase 5.11 document records operational readiness requirements for future
GPT-OSS private serving. It is docs-only and does not implement a server,
private-network path, Custom GPT action, durable replay store, durable rate
limit, production key manager, deployment path, training path, OpenAI call, live
database connection, or vLLM serving path.

Current decision: all production, cloud, public, private-network, and Custom
GPT exposure gates are `NO-GO`.

## Current Baseline

```json
{
  "serverExposureReady": false,
  "privateNetworkExposureReady": false,
  "durableReplayReady": false,
  "durableRateLimitReady": false,
  "productionKeyManagementReady": false,
  "auditReadyForExposure": false,
  "rollbackReadyForExposure": false,
  "incidentResponseReadyForExposure": false,
  "securityReadyForExposure": false,
  "cloudReady": false,
  "customGptReady": false
}
```

Local design and helper readiness must not be treated as production readiness.
Any future status change needs reviewed implementation evidence and a separate
release decision.

## Operations Preflight

| Area | Required evidence before exposure | Current status |
| --- | --- | --- |
| Ownership | Named owner for serving boundary, rollback, incident response, key management, audit, and rate limits. | Incomplete. |
| Boundary | Reviewed protocol boundary showing TypeScript-owned public surface and Python behind the boundary. | Design-only. |
| Server | Explicit server, route, listener, ingress, and denial behavior review. | Not implemented; `NO-GO`. |
| Private network | Network path, allowlist, gateway auth, and no-public-ingress proof. | Not approved; `NO-GO`. |
| Custom GPT | Action schema, auth boundary, rate limit, rollback, and audit review. | Not approved; `NO-GO`. |
| Secrets | Proof that no real secrets or secret-shaped literals are committed to docs, tests, fixtures, or logs. | Required before any later gate. |
| Do-not-run controls | Confirmation that release review does not run Railway, OpenAI, training, vLLM, live DB, server, or deployment commands unless explicitly approved in a later phase. | Required. |

Preflight failure blocks release. There is no current exception path for
production or exposure.

## Release Gate

The release gate for future private serving must prove every required control
is implemented and fail-closed before any exposure decision changes.

| Gate | Required proof | Current decision |
| --- | --- | --- |
| Server release gate | Server path exists only after design approval, rejects by default, and cannot bypass protocol controls. | `NO-GO`. |
| Cloud gate | Cloud exposure remains blocked until all serving controls are complete. | `NO-GO`. |
| Custom GPT gate | Custom GPT action cannot reach private serving until action schema, auth, audit, rate, replay, rollback, and incident controls pass. | `NO-GO`. |
| Durable replay gate | Shared durable nonce ledger exists, is atomic, and rejects duplicate accepted nonces across restarts and workers. | `NO-GO`. |
| Durable rate-limit gate | Durable counters and policy enforce per-key, per-subject, per-action, burst, and emergency block limits. | `NO-GO`. |
| Key-management gate | Production key resolver, rotation, revocation, overlap, audit, and emergency disable behavior are implemented without logging key material. | `NO-GO`. |
| Audit gate | Redacted audit records support investigation without storing secrets or raw request bodies. | `NO-GO`. |
| Rollback gate | Exact route, ingress, key, action, and config rollback path is reviewed and verified. | `NO-GO`. |

## Audit Readiness

Audit readiness for exposure requires:

- Redacted decision records for accepted, denied, replay-rejected, rate-limited,
  emergency-disabled, and rollback requests.
- Correlation between request id, trace id, key id metadata, subject hash when
  available, replay decision, rate-limit decision, and denial reason.
- No raw signing keys, bearer tokens, cookies, database URLs, passwords,
  unredacted headers, or raw request bodies.
- Clear separation between audit records, replay nonce records, rate-limit
  records, and training artifacts.
- A documented sampling process for release review and incident response.

Current audit status is not sufficient for exposure. Audit artifacts remain
review evidence only and must not become training data.

## Replay Readiness

Local replay checks are not production replay protection. Exposure requires a
durable replay decision path that:

- Uses a shared durable nonce ledger for all serving workers in the same
  environment.
- Enforces atomic uniqueness for the accepted key id and nonce hash.
- Rejects stale timestamps, future-skew violations, duplicate nonces, missing
  store configuration, schema mismatch, ambiguous writes, and store
  unavailability.
- Stores hashes and correlation metadata only.
- Keeps replay records separate from audit history.
- Supports bounded, idempotent pruning without weakening replay rejection.

Current durable replay status is `NO-GO`: design and readiness review exist,
but no approved live durable store, migration apply, or serving integration
exists.

## Key Readiness

Production key readiness requires:

- A reviewed production key resolver.
- Non-secret key id metadata.
- Key rotation with overlap and deterministic revocation.
- Emergency disable for compromised or unknown key ids.
- Fail-closed behavior when key material or key metadata cannot be resolved.
- Audit records that identify key metadata without exposing key material.

Current key-management status is `NO-GO`: design exists, but no production key
resolver, real key loading path, KMS integration, rotation execution, or
serving integration is approved.

## Rate Readiness

Durable rate readiness requires:

- Durable counters or equivalent durable enforcement for every exposure-capable
  serving worker.
- Per-key, per-subject, per-action, burst, abuse, and emergency block policy.
- Fail-closed behavior when rate state is unavailable or ambiguous.
- Redacted audit evidence for allowed, limited, and blocked requests.
- Clear rollback behavior that does not leave exposure unbounded.

Current durable rate-limit status is `NO-GO`: durable rate-limit design may be
reviewed separately, but no approved production implementation or exposure gate
exists.

## Durable Replay Operations

Durable replay operations are blocked until a later phase approves live storage
and migration behavior. Future operations must include:

- Storage creation and migration review before apply.
- Pruning review and retention bounds.
- Duplicate rejection tests across restart and multi-worker scenarios.
- Failure-mode tests for timeouts, unavailable storage, and schema mismatch.
- Audit correlation for first-seen and duplicate decisions.
- Rollback behavior that preserves fail-closed replay decisions.

No live DB command, migration apply, replay ledger mutation, or storage
operation is authorized by this document.

## Deployment Blockers

Deployment or exposure must remain blocked while any of these are true:

- No approved server, route, listener, ingress, or private-network serving
  boundary exists.
- Cloud readiness is false.
- Custom GPT readiness is false.
- Durable replay protection is not implemented and integrated.
- Durable rate limiting is not implemented and integrated.
- Production key management is not implemented and integrated.
- Audit redaction and incident evidence are not approved for exposure.
- Rollback has not been verified for the exact serving boundary.
- Emergency disable has not been verified.
- Security review still allows tool escalation, writing-pipeline system
  operations, raw DB access, Railway mutation, OpenAI calls, vLLM serving, or
  training paths through private serving.

The current deployment decision is `NO-GO`.

## Do Not Run

This readiness document does not authorize running Railway, OpenAI, training,
vLLM, live database, server, tunnel, deployment, migration, or Custom GPT
publication commands. It also does not authorize adding secrets, adding
secret-shaped literals, or mutating schema, scripts, tests, packages, generated
files, or existing docs.
