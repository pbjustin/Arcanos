# GPT-OSS Production Key Management Design

Phase 5.9 defines the production key-management design for future GPT-OSS
private serving. This is design-only. It does not load real keys, read signing
keys from environment variables, integrate with KMS or another secret manager,
create endpoints, start listeners, expose private serving, deploy anything, or
change runtime behavior.

Current request signing remains local/test-safe helper logic only. The existing
helpers require explicitly supplied local test key material and fail closed when
no key is supplied. They are not production key lifecycle controls.

Current blocked status:

```json
{
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "cloudReady": false,
  "customGptReady": false
}
```

## Scope

This design covers the future production lifecycle for signing keys used by
GPT-OSS private-serving request envelopes.

In scope for design:

- `keyId` naming and metadata lifecycle
- signing key ownership boundaries
- rotation cadence and overlap behavior
- revocation and emergency disable behavior
- audit requirements
- future implementation blockers

Out of scope for Phase 5.9:

- real signing key loading
- environment-variable key reads
- KMS or secret-manager integration
- server endpoints, listeners, routes, tunnels, or deployments
- Railway, OpenAI, database, vLLM, training, or Custom GPT exposure
- production readiness changes

## Key Lifecycle

Each future signing key must have metadata that can be audited without exposing
secret material.

| State | Meaning | Request behavior |
| --- | --- | --- |
| `pending` | Metadata exists, but the key is not accepted for signing or verification. | Reject signed requests. |
| `active` | The key signs new requests and verifies matching incoming requests. | Accept only after schema, signature, timestamp, audience, nonce, durable replay, rate-limit, and audit checks pass. |
| `verify_only` | The key no longer signs new requests but can verify in-window requests during rotation overlap. | Accept only within approved overlap, replay, and clock-skew windows. |
| `retired` | The key is outside all overlap and replay windows. | Reject new requests; keep metadata for audit correlation only. |
| `revoked` | The key is compromised, invalid, or administratively disabled. | Reject immediately before nonce insert, replay acceptance, runtime invocation, or model behavior. |

`keyId` values must never be reused for new key material. A key that reaches
`revoked` must not move back to `active`; recovery requires a new unique
`keyId`.

## keyId Format

`keyId` is a non-secret identifier. It must be safe to log in redacted audit
records, stable for correlation, unique per key generation, and independent of
the raw signing key.

Future `keyId` values should follow this shape:

```text
gptoss:{environment}:{purpose}:{yyyymmdd}:{sequence}
```

Format rules:

- Use lower-case ASCII segments.
- Use a deployment environment segment, not a host name or credential value.
- Use a purpose segment such as private request signing or replay validation.
- Use the creation date as metadata only; do not derive key material from it.
- Use a monotonic sequence for the same date and purpose.
- Do not include raw key bytes, hashes of raw key bytes, account secrets,
  database identifiers, bearer values, or customer data.

## Signing Key Ownership

Future production signing key ownership must be split by responsibility:

- The TypeScript private endpoint layer owns the public protocol surface,
  verification contract, request schema, response schema, and readiness fields.
- Approved service identities may receive signing capability only through a
  reviewed provisioning path in a later implementation phase.
- A future approved key-management owner controls key generation, storage,
  distribution, rotation, revocation, and emergency disable decisions.
- Python, model-serving tools, training scripts, writing pipeline code, and
  replay artifacts must never receive raw signing key material.
- Local test key maps remain local-only fixtures and must not be promoted into
  production configuration.

No raw signing key may be committed to the repository, written to deterministic
reports, included in audit logs, printed in errors, stored in replay records, or
copied into runbooks.

## Rotation Cadence

The planned production cadence is scheduled rotation at least once per quarter,
plus immediate rotation for suspected exposure, owner changes, service identity
changes, provisioning mistakes, or unexplained signature validation anomalies.

Concrete production values remain blocked until implementation review defines
the approved secret store, propagation timing, replay window, clock-skew
allowance, audit retention, and rollback owner.

## Planned Rotation Model

Future rotation must use overlapping validity windows:

1. Create new key metadata in `pending`.
2. Provision the new key through the future approved secret channel.
3. Validate distribution without logging key material.
4. Promote the new key to `active`.
5. Move the previous active key to `verify_only`.
6. Stop signing with the previous key immediately.
7. Keep the previous key verifiable only through the replay window, accepted
   clock skew, and approved deployment propagation buffer.
8. Move the previous key to `retired` after all overlap and nonce-retention
   requirements are satisfied.

The old key replay window must continue to reject duplicate `keyId + nonce`
pairs while the key is `verify_only`. Retiring the key must not delete audit
records needed to explain accepted requests, duplicate rejections, or key
state transitions.

## Revocation Behavior

Revocation is a fail-closed security action.

When a `keyId` is revoked:

- Reject all matching requests immediately, including requests that would
  otherwise be inside a replay or rotation overlap window.
- Deny before nonce insert, replay acceptance, runtime invocation, model
  loading, or endpoint behavior.
- Preserve redacted audit metadata for investigation.
- Do not delete replay records or audit correlation as part of revocation.
- Do not roll the key back to `active`.
- Require a new unique `keyId` before any future recovery.

If revocation status cannot be loaded or trusted, future private serving must
reject the request instead of falling back to local test keys, in-memory replay,
OpenAI, vLLM, Railway, database access, training paths, or Custom GPT routes.

## Emergency Disable Flow

A future implementation must provide an emergency disable control that can make
GPT-OSS private-serving request signing fail closed without disabling unrelated
backend routes.

Emergency disable must:

- Stop accepting all production GPT-OSS private-serving signatures or the
  affected `keyId` set.
- Stop signing new requests with affected keys.
- Deny before durable replay writes and runtime invocation.
- Preserve redacted audit records for denied requests when safe.
- Keep `privateServingImplemented`, `privateServingExposed`, `cloudReady`, and
  `customGptReady` false unless a later approved implementation changes those
  fields through a reviewed gate.
- Avoid fallback to public chat, raw completion, OpenAI, Railway, shell,
  database, training, or Custom GPT paths.

## Audit Requirements

Future audit records may include:

- request id
- trace id
- non-secret `keyId`
- key lifecycle state
- caller identity hash
- body hash
- nonce hash
- decision category
- rotation or revocation reason code
- timestamp bucket
- readiness and rollback state

Future audit records must not include:

- raw signing keys
- raw nonces
- raw request bodies
- request signatures
- bearer tokens
- cookies
- passwords
- database URLs
- OpenAI keys
- Railway tokens
- raw environment values
- unredacted headers

Audit output must be deterministic JSON where practical, redacted before
review, and non-trainable. Audit and replay records must never become GPT-OSS
training labels or writing-pipeline inputs.

## Repository And Logging Rules

- No secrets in repo files, fixtures, docs, migrations, tests, or local
  artifacts intended for review.
- No raw key logging.
- No raw key previews.
- No key material in exception messages.
- No key material in readiness reports.
- No secret-shaped sample values in documentation.
- No environment key reads in Phase 5.9.
- No KMS or secret-manager integration in Phase 5.9.

## Future Implementation Blockers

Production key management remains blocked until a later approved phase:

- Selects and reviews the production secret storage and provisioning mechanism.
- Implements key metadata storage without exposing raw key material.
- Implements key resolution in the TypeScript private endpoint layer.
- Implements rotation, revocation, and emergency disable gates.
- Implements durable replay storage and persistent nonce ledger behavior.
- Proves old-key overlap and replay rejection across all serving workers.
- Proves revoked-key denial before runtime invocation.
- Proves audit redaction and no raw key logging.
- Adds deterministic readiness output for production key management.
- Keeps Python and model execution behind the protocol boundary.
- Keeps private serving, cloud, and Custom GPT exposure blocked until all
  serving gates pass.

Until those blockers are resolved, production serving remains blocked and the
readiness booleans `privateServingImplemented`, `privateServingExposed`,
`cloudReady`, and `customGptReady` remain `false`.
