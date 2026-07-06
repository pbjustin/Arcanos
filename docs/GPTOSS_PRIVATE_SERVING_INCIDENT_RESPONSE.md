# GPT-OSS Private Serving Incident Response

This Phase 5.11 document is design and operations guidance only. It does not
implement private serving, create a server or listener, expose a private
network path, publish a Custom GPT action, connect to a live database, run a
model server, call OpenAI, train a model, deploy anything, or authorize Railway
mutation.

Current production and exposure status:

```json
{
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "publicServerCreated": false,
  "privateNetworkExposureApproved": false,
  "replayProtectionDurable": false,
  "durableRateLimitImplemented": false,
  "productionKeyManagementImplemented": false,
  "cloudReady": false,
  "customGptReady": false
}
```

All production, cloud, public, private-network, and Custom GPT exposure gates
are currently `NO-GO`.

## Severity

| Severity | Definition | Required response |
| --- | --- | --- |
| SEV-0 | Confirmed public, cloud, private-network, or Custom GPT exposure without all required gates approved. | Emergency disable, containment, owner escalation, rollback, audit preservation, post-incident review. |
| SEV-1 | Auth, replay, key, rate-limit, audit, or rollback control appears bypassed or unavailable in any exposure-capable path. | Contain affected path, fail closed, preserve evidence, block release until reviewed. |
| SEV-2 | Local or design-only gate drift that could misrepresent readiness but has no exposure path. | Correct docs or validators before the next review; keep exposure blocked. |
| SEV-3 | Documentation ambiguity, checklist mismatch, or incomplete operational evidence with no runtime impact. | Clarify before approval; no emergency action required. |

## Incident Classes

| Class | Typical trigger | Detection | Initial containment |
| --- | --- | --- | --- |
| Unauthorized exposure | Server, route, tunnel, ingress, private network, cloud endpoint, or Custom GPT action exists before approval. | Cloud gate reports readiness, endpoint inventory, deployment review, ingress review, unexpected traffic. | Disable routing, remove action exposure, block ingress, fail closed, freeze release. |
| Auth boundary failure | Unsigned, stale, wrong-audience, revoked-key, or malformed requests could pass. | Auth decision logs, denied/accepted mismatch, signature validation review, release gate findings. | Reject all private-serving requests until auth behavior is reviewed and corrected. |
| Replay protection failure | Duplicate nonces accepted, durable nonce ledger unavailable, or in-memory replay checks used for exposure. | Replay audit correlation, duplicate nonce findings, durable replay gate status, store health evidence. | Fail closed on replay checks and keep serving disabled. |
| Durable rate-limit failure | Per-key, per-subject, per-action, or burst limits are missing or non-durable. | Rate-limit audit summaries, excessive request patterns, readiness gate status. | Disable exposure path or apply emergency block at ingress while implementation remains blocked. |
| Key compromise or rotation failure | Signing key material is suspected exposed, old keys remain accepted too long, or revocation cannot be enforced. | Key inventory review, audit anomalies, unexpected key id use, rotation evidence gaps. | Disable affected key ids, block verification for revoked keys, keep model invocation disabled. |
| Audit leakage | Audit, replay, or diagnostic records contain raw secrets, raw headers, raw request bodies, database URLs, cookies, passwords, or key material. | Audit sampling, redaction check failure, review finding. | Stop producing affected records, quarantine artifacts, preserve hashes and metadata only. |
| Rollback failure | Exposure cannot be removed or previous safe config cannot be restored. | Rollback drill failure, missing previous config capture, deployment state drift. | Escalate as SEV-0 if exposure exists; otherwise block release. |
| Protocol or tool escalation | Model output or request handling attempts system operations, Railway mutation, live DB reads, writing-pipeline side effects, or privileged tools. | Router enforcement findings, audit trail, review of effective response envelopes. | Deny action, isolate request, keep system operations outside the writing pipeline. |
| Training contamination | Request logs, audit records, Custom GPT action data, OpenAI output, or unreviewed labels are marked trainable. | Dataset provenance review, training-governance gate, artifact metadata. | Mark affected artifacts non-trainable and block export. |

## Detection

Detection evidence should be deterministic and redacted. Acceptable evidence
includes gate status reports, endpoint inventory, deployment inventory, audit
summaries, replay-decision summaries, key lifecycle metadata, and rate-limit
decision summaries. Evidence must not include raw secret values, signing key
material, bearer tokens, cookies, database URLs, passwords, raw request bodies,
or unredacted headers.

Detection is not proof of approval. If a gate reports that cloud, Custom GPT,
server, durable replay, durable rate limit, production key management, rollback,
or audit readiness is incomplete, the decision remains `NO-GO`.

## Containment

Containment priorities:

1. Stop exposure before investigation depth.
2. Fail closed for auth, replay, key, and rate-limit uncertainty.
3. Preserve redacted audit evidence.
4. Prevent system operations from being routed through model output or writing
   paths.
5. Keep OpenAI output, request artifacts, audit records, and Custom GPT action
   data out of training data.

Containment actions for a future exposed path must be reversible, auditable,
and scoped to the affected route, key id, subject, action, or environment. In
the current phase there is no approved serving path, so any discovered exposure
is an incident and not an operational exception.

## Emergency Disable

Emergency disable means the private-serving path cannot invoke model behavior,
cannot accept signed requests, and cannot be reached by public, cloud, private
network, or Custom GPT callers.

Minimum emergency disable requirements for any future implementation:

- Disable the serving route or ingress rule.
- Disable Custom GPT action exposure.
- Reject all private-serving requests at the gateway.
- Deny requests using compromised or unknown key ids.
- Fail closed when durable replay or durable rate-limit state is unavailable.
- Preserve redacted audit correlation for accepted and rejected requests.
- Record who disabled the path, when it was disabled, and what evidence caused
  the disablement.

Emergency disable must not depend on model output, generated text, training
pipelines, live DB ad hoc mutation, or Railway mutation from a model-driven
path.

## Rollback

Rollback is not approved until the exact serving boundary has a reviewed path
back to a known no-exposure state. Current rollback posture is `NO-GO` for
production exposure because no production serving implementation is approved.

Future rollback evidence must include:

- Last known safe no-exposure configuration.
- Route, ingress, and Custom GPT action removal procedure.
- Key acceptance state before and after rollback.
- Durable replay and durable rate-limit fail-closed behavior.
- Redacted audit preservation.
- Post-rollback verification that server, cloud, private network, and Custom
  GPT exposure are disabled.

If rollback cannot be completed while exposure exists, classify the incident as
SEV-0.

## Audit Handling

Audit records are evidence, not authorization to serve traffic. Audit handling
must preserve correlation while excluding raw secrets and raw request material.

Required audit properties:

- Correlate request id, trace id, key id metadata, subject hash when available,
  action, decision, denial reason, replay decision, rate-limit decision, and
  rollback or emergency-disable event ids.
- Store redacted previews only when previews are necessary.
- Keep replay records separate from audit records.
- Do not use audit records as the durable replay ledger.
- Do not mark audit records as training data.
- Retain incident evidence long enough for review without retaining secret
  material.

## Post-Incident Review

Post-incident review must answer:

- Which gate failed, drifted, or was missing?
- Was exposure public, cloud, private network, or Custom GPT reachable?
- Did auth, durable replay, durable rate limit, key management, audit, and
  rollback fail closed?
- Were any secrets, raw request bodies, raw headers, or live DB values written
  to logs or artifacts?
- Were any incident artifacts made trainable or passed into model training?
- What minimum design, validator, or checklist change prevents recurrence?

Do not close the incident until the current go/no-go checklist still reports
`NO-GO` for all incomplete production and exposure gates.

## Do Not Run

This incident response document does not authorize running:

- Railway deploy, mutation, log, variable, or service commands.
- OpenAI calls or provider comparison calls.
- Training, fine-tuning, evaluation-as-training, or dataset export.
- vLLM, model servers, backend servers, listeners, tunnels, or local endpoint
  exposure.
- Live database commands, migrations, ad hoc SQL, replay ledger mutation, or
  job maintenance against a configured database.
- Custom GPT action publication or schema activation.
- Any script or tool path that would create exposure, mutate infrastructure, or
  route system operations through the writing pipeline.
