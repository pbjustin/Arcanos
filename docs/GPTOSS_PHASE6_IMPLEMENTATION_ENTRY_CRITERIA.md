# GPT-OSS Phase 6 Implementation Entry Criteria

Phase 5.12 is the final architecture-readiness review before Phase 6. Passing
this review authorizes constrained implementation work behind the private
serving boundary. It does not authorize production use, a server or listener,
network exposure, deployment, cloud readiness, or a Custom GPT integration.

Implementation readiness and production authorization are separate decisions.
The current required decision is:

```json
{
  "phase6ImplementationReady": true,
  "finalArchitectureReadinessReviewed": true,
  "productionGoAllowed": false,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "cloudReady": false,
  "customGptReady": false
}
```

`phase6ImplementationReady:true` means only that Phase 6 may begin the
implementation scope defined below. It must not be interpreted as evidence
that private serving is implemented, exposed, production-ready, cloud-ready,
or available to a Custom GPT.

## Entry Conditions

Phase 6 implementation may begin only while all of these conditions hold:

- The effective-router baseline remains `24/24`, and local controlled runtime
  readiness remains true.
- Request signing, the auth decision boundary, and local replay protection
  remain covered by their deterministic validators and tests.
- Durable replay, durable rate-limit, and production key-management designs
  exist, while their implementation fields remain false until separate
  implementation evidence is reviewed.
- Durable replay migration apply remains explicitly blocked.
- Operations readiness, incident response, and the production no-go checklist
  remain available as design/governance evidence.
- TypeScript continues to own the protocol surface, with Python and any future
  model execution behind that boundary.
- The CI-safe release gate and the Phase 5.12 final-readiness validator pass
  without OpenAI, training, vLLM, Railway, live database, server, deployment,
  real-secret, environment-secret, or KMS activity.
- The required no-go fields in this document remain false.

Failure of any entry condition blocks new Phase 6 implementation work until
the evidence is restored and reviewed. It does not create an exception path to
production or exposure.

## Phase 6 May Implement

Phase 6 may implement only an internal private-serving request handler and its
offline, protocol-bound support code. The allowed scope is:

- A TypeScript-owned internal handler callable as a module, without binding it
  to HTTP, a socket, a listener, a route, an ingress, or another network
  transport.
- Schema-first request validation and safe effective-router response shaping.
- Fail-closed orchestration of the approved request-signing, auth, replay,
  rate-limit, audit, rollback, and denial contracts.
- Dependency-injected interfaces and deterministic test doubles needed to
  test the internal handler without a live database or external service.
- Offline tests and deterministic JSON reports that prove forbidden paths stay
  unreachable and that raw model output is not an endpoint contract.

The internal handler may return only the reviewed effective-router safety
envelope. It must not expose a raw completion, hidden prompt, chain-of-thought,
system instruction, unredacted audit data, credential, database row, shell
output, or Railway command output.

## Phase 6 May Not Implement Yet

Phase 6 entry does not authorize:

- A public or private-network server, HTTP server, listener, route, endpoint,
  tunnel, ingress, or other exposure-capable transport.
- Cloud deployment, staging deployment, production deployment, or a Railway
  command path.
- A Custom GPT action, bridge, schema, publication, or direct connection.
- An unauthenticated endpoint or an auth/signing/replay/rate-limit bypass.
- A raw model, raw completion, or OpenAI-compatible model endpoint.
- A live database connection, durable-store mutation, or migration apply
  before a separate durable-store implementation approval.
- A training, fine-tuning, dataset-capture, or automatic feedback path.
- An OpenAI reference, fallback, comparison, request, or output-capture path.
- A vLLM serving or invocation path.
- Real signing keys, environment-secret reads, KMS integration, or production
  key resolution before separately approved implementation work.
- Shell execution, arbitrary tools, filesystem mutation, raw SQL exposure, or
  writing-pipeline execution of system operations.

Adding any prohibited path requires a separate reviewed phase and cannot be
inferred from Phase 6 implementation readiness.

## Required Implementation Sequence

Phase 6 work must proceed in this order:

1. Approve any required schema-first changes to the internal request and
   response contracts.
2. Implement and test the internal TypeScript handler with deterministic,
   injected offline dependencies only.
3. Prove fail-closed signing, auth, replay, rate-limit, audit, rollback, and
   response behavior without creating a server or external path.
4. Obtain separate approval before implementing or connecting any durable
   replay or rate-limit store, applying a migration, loading production keys,
   reading environment secrets, or integrating KMS.
5. Re-run the required private-serving and CI-safe release validators and
   preserve all no-go readiness fields.
6. Complete a separate staging architecture and security gate before any
   server, listener, network path, database connection, secret integration, or
   deployment is considered.
7. Complete a separate production go/no-go review after staging evidence
   exists. Production remains blocked unless that later review explicitly
   changes `productionGoAllowed`.

No step may be skipped by falling back to `/gpt/:gptId`, OpenAI, a raw model
endpoint, Railway, a live database, training, vLLM, or a Custom GPT action.

## Required Validation Gates

Each Phase 6 change must keep these gates green or intentionally blocked as
specified:

- Schema validation for every internal request, response, readiness report,
  and denial shape.
- Focused private-serving tests for accepted and denied requests, signature
  failure, auth failure, replay rejection, rate limiting, rollback, audit
  redaction, and safe response shaping.
- Static checks proving no server/listener, OpenAI, training, vLLM, Railway,
  live database, migration-apply, real-secret, environment-secret, KMS,
  deployment, or Custom GPT path was added.
- Durable replay, durable rate-limit, and production key-management design
  validators, with implementation readiness evaluated separately from design
  readiness.
- The GPT-OSS private-serving final-readiness validator.
- The GPT-OSS runtime CI release gate, with cloud and Custom GPT readiness
  remaining false.
- A later, separately approved staging gate before any exposure-capable work.
- A later, separately approved production gate before production use.

## Production And Exposure No-Go

Phase 6 entry does not satisfy a production control. The current production
and exposure state must remain:

```json
{
  "productionGoAllowed": false,
  "privateServingImplemented": false,
  "privateServingExposed": false,
  "durableReplayMigrationApplyAllowed": false,
  "replayProtectionDurableImplemented": false,
  "durableRateLimitImplemented": false,
  "productionKeyManagementImplemented": false,
  "cloudReady": false,
  "customGptReady": false
}
```

Production remains `NO-GO` because there is no approved exposure-capable
server or network boundary, durable replay implementation, durable rate-limit
implementation, production key-management implementation, live-store
approval, staging evidence, or production release decision.

Cloud and Custom GPT remain `NO-GO` independently of internal handler
progress. No Phase 6 implementation result may make either ready implicitly.
