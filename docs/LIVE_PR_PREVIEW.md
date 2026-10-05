# Repository-wide isolated live PR preview testing

This companion to [Railway deployment](RAILWAY_DEPLOYMENT.md) describes an
implemented, opt-in backend test lane. It is disabled by default and has not
been provisioned or exercised with paid providers. The existing sealed native
preview, lifecycle workflows, import pins, empty shared-variable contract,
credential-empty child, and passive worker remain separate.

## What each result establishes

| Evidence | Boundary exercised | Separate verification still required |
| --- | --- | --- |
| Sealed synthetic preview | Credential-free served components and fixed fixtures | Real acquisition, models, backend auth, database behavior |
| Live backend preview | Exact approved commit, transient real source acquisition, Trinity generation, mandatory answer audit and final grounded answer | Installed ChatGPT plugin, OAuth, consent, refresh, durable storage |
| Installed plugin OAuth acceptance | Actual installed client and its OAuth lifecycle | Never inferred from either preview result |

Approval, private authentication, the broker, resource limits, module scoping,
scenario runner and evidence projection are shared across the repository.
The private application takes a fixed registry of reviewed adapters, with no
Gaming imports or arbitrary dispatch. Each request selects a registered module
in the signed `moduleIds` allowlist; the trusted broker independently checks that
scope before every provider operation. A test identity does not authorize other
modules.

Gaming is the first concrete adapter and imports the existing
`runGameplayPipeline`; it does not implement another game engine.
Its server-only runtime dependency supplies a scoped client,
excludes stored SQL retrieval, disables memory and optional side effects, and
observes cloned retrieval/evidence/audit results. Source validation, applicability,
grounding, protected completion checks, CLEAR policy and final-answer fingerprint
binding stay in the existing pipeline. Local tests use a disposable HTTPS source
and model completions supplied by test doubles. They do not establish paid model
or deployed acceptance.

## Required isolation before any live run

The sealed environment cannot safely acquire live credentials: its controller
requires no shared variables and its import graph excludes providers and normal
retrieval. Provision a separate `live-pr-<PR number>` service in a separate
allowlisted project and environment. The live lane is deliberately absent from
the normal and sealed launchers and from both existing preview workflows.

The **trusted supervisor** runs independently reviewed code in its own clean
checkout. It holds only a dedicated, narrowly scoped preview provider project
key. It must have no production database/provider credentials, production data,
Railway lifecycle token, privileged GitHub token, or OAuth grant. It never
checks out, installs, builds or executes PR code. Its private broker binds only
to `127.0.0.1`; a separately configured private TLS tunnel is required.

The **PR runtime** must run in a different container/VM/service, with separate
filesystem, process namespace and credential environment. Do not share the
supervisor UID, operator directories, state volume, `.env`, production volumes,
or host process namespace. Owner-only files outside a checkout are not a sandbox
against code on the same host with the same UID. Only short-lived broker and
test bearers cross this boundary. The preview may read approved public sources
and call its private broker; platform egress rules must deny production/internal
services and direct model endpoints. No production data is mounted. Source
content remains untrusted evidence.

The PR service starts from an empty writable working directory, because imports
can load `.env` and generation can write local redacted audit/lineage files. No
normal application startup, active worker, database initializer, migration,
durable ingestion, refresh, queue or memory service is started. Build the exact
clean PR SHA without credentials, and independently attest its actual deployment
and built artifacts through the trusted platform controller. Runtime environment
strings and HTTP identity echoes alone do not prove platform ownership.

The tracked Railway/Docker configuration starts the normal application, not this
live lane. A live deployment needs a separate runtime bootstrap, a trusted
supervisor checkout including `.git`, a supervisor-only persistent claims volume,
private TLS gateways for the loopback listeners, and protected session-file
handoff to the exact immutable deployment. Railway private networking alone does
not establish TLS or outbound restrictions. Verify the actual egress controls
before signing `egressRestricted: true`; endpoint names, static outbound IPs and
IPv6 settings are not such evidence. Connected Railway OAuth tooling can report
an existing provider variable's name while withholding its value; reuse then
requires a secure credential binding to the supervisor.

## Approval and configuration contracts

The operator creates an Ed25519-signed approval **after reviewing the exact PR
SHA and platform isolation evidence**. Signing authority, public-key trust
configuration, approved SHA, isolation allowlists and production denylists are
operator-owned inputs outside PR execution. Every new revision and replacement
deployment needs a fresh approval. Forks are denied regardless of signatures.
Keep each approved deployment immutable. Never inherit session files, bearers or
private routing into a replacement revision; invalidate the old session before
changing its runtime. Admission against environment strings cannot detect a
platform silently replacing code behind an already authorized endpoint.

`scripts/live-pr-preview-policy.mjs` validates these closed JSON contracts:

- Approval: `version: arcanos-live-pr-preview/v1`, unique `approvalId`, repository
  `pbjustin/Arcanos`, `prNumber`, exact 40-character `commitSha`, `issuedAtMs`,
  `expiresAtMs`, `attestationSha256`, `deployment`, `limits`, `models`, and explicit
  `moduleIds` (1–16 distinct lowercase module slugs).
- Deployment: `projectId`, `environmentId`, `environmentName: live-pr-<PR>`,
  `serviceId`, and `deploymentId`.
- Limits: explicit positive `maxRequests`, `maxInputTokensPerRequest`,
  `maxOutputTokensPerRequest`, `maxTotalTokens`, `durationMs`, and
  `maxSpendMicroUsd`. No spending limit or numeric configuration in this document
  grants authorization. Maximum concurrency is one and broker retries are zero.
- Models: exact allowlisted IDs and conservative positive input/output
  micro-USD-per-token rates. Each adapter preserves its existing model policy;
  Gaming requires one fine-tuned authority and its existing
  intake/audit/reasoning helpers. No fallback
  provider or alternate endpoint is available from the broker.
  The trusted supervisor reuses the repository's pure response-identity policy:
  fine-tunes must match exactly, while approved helper families may return their
  provider snapshot names. Conservative signed prices must cover those snapshots.
- Attestation: exact repository/head repository, PR/SHA/deployment IDs,
  `controllerRevision`, approved private HTTPS `backendOrigin` and `brokerOrigin`,
  and explicit `production: false`, `isolated`, `dataIsolated`,
  `credentialIsolated`, `egressRestricted` booleans. Its canonical SHA-256 is
  covered by the approval signature. These booleans require independent platform
  evidence; the code does not provision or independently discover isolation.
- Trust file: `trustedRunnerSha`, `approvalPublicKey`, and `trustedIsolation`
  project/environment allowlists and production denylists. Built-in known
  production identities are always denied, including when allowlisted.

The signature covers canonical JSON. Missing/invalid inputs, unknown fields,
identity drift, default-off mode, missing credentials or limits fail closed.
`signLivePreviewApproval` is an offline helper, not an approval grant by itself.

The supervisor consumes a run ID through an atomic, durable exclusive claim
**before** credential resolution. All supervisors must use the same durable
claims authority/volume. Do not create per-run disposable claim directories or
independent authorities on different hosts; those would multiply the approved
limits. Losing the claim volume requires fresh operator approvals, not replay.

Only the trusted supervisor reads `ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY`, after
approval and replay admission. Do not put it in PR CI, Railway PR variables,
session handoffs, runtime `.env`, artifacts or logs. Use a dedicated restricted
provider project key with its own account-side budget/expiry; provisioning it is
a separate approval stage.

## Operator procedure after separate authorization

No command below authorizes deployment, credential provisioning, settings changes
or paid calls. First publish/review the prepared code through the separately
authorized process, establish the isolated services/private TLS routes, obtain
platform ownership evidence, and choose explicit limits and provider pricing.

From the clean trusted checkout, validate without network or credential use:

```text
node scripts/live-pr-preview-run.mjs --approval-file /operator/approval.json --attestation-file /operator/attestation.json --trust-file /operator/trust.json --commit-sha <exact-PR-SHA>
```

Operator input files must be absolute, owner-only regular files in protected
directories outside the checkout. After explicit spending/credential approval,
the supervisor additionally requires `--execute --allow-paid-provider`,
`--claims-dir /operator/durable-claims`, and
`--session-out /operator/session.json`. The session file is exclusive mode 0600;
it contains only ephemeral broker/test credentials and approved identity/limits.
Keep it out of logs and artifacts. Credentials are never printed.
The pinned Node 24 supervisor loads only its reviewed, dependency-free model
identity source after validating trusted Git state and signed admission. It
does not load generated PR artifacts or the backend application graph.

Configure the PR runtime with the exact approved Railway project, environment,
service, deployment and `RAILWAY_GIT_COMMIT_SHA`, `NODE_ENV=production`, `TZ=UTC`
and `PORT`. Its entry point uses a closed environment allowlist. It rejects a
production identity or wrong SHA before importing provider-capable backend code:

```text
env -i NODE_ENV=production TZ=UTC PORT=<private-port> RAILWAY_PROJECT_ID=<approved-project> RAILWAY_ENVIRONMENT_ID=<approved-environment> RAILWAY_ENVIRONMENT_NAME=live-pr-<PR> RAILWAY_SERVICE_ID=<approved-service> RAILWAY_DEPLOYMENT_ID=<approved-deployment> RAILWAY_GIT_COMMIT_SHA=<exact-PR-SHA> /absolute/pinned/node /exact-pr-checkout/scripts/start-live-pr-preview.mjs --session-file /private/session.json --broker-origin <approved-private-HTTPS-origin>
```

Run this command from the empty isolated runtime directory, through a private
listener/gateway. The backend test route is `POST /__preview/live/<moduleId>`,
authenticated before JSON parsing by the per-run `arcanos-preview-...` opaque
bearer. It is absent from production; normal Gaming OAuth does not recognize
that identity, even when a preview flag is accidentally present. It confers no
storage, administrative, job, refresh or OAuth permissions.

The separate `scripts/live-pr-preview-e2e.mjs` verifier consumes operator-owned
scenario data, so game, checkpoint, question and public source URLs are reusable
across games and modules. Its scenario manifest identifies the module, cases,
adapter input and public source URLs; the generic runner never requires Gaming
input fields. Its default invocation is a dry run. Execution requires explicit
network opt-in and the approved signed inputs/session. Use its tested CLI argument
contract and the fixed case manifest in `scripts/live-pr-preview-verifier.mjs`.
Real public-source candidate scenarios and an offline validation example are in
[`examples/live-pr-preview/`](../examples/live-pr-preview/README.md). With
`--scenario-file`, a dry run validates the selected case or every case in that
manifest using the execution parser, without reading approval/session inputs or
making requests. `scenarioCaseIds` reports the cases validated; it does not
establish source availability, backend outcomes or live acceptance. Copy reviewed
scenario data to an owner-only operator file outside the checkout before use.
For an authorized single case, its complete invocation is:

```text
node scripts/live-pr-preview-e2e.mjs --module-id <approved-module> --commit-sha <exact-PR-SHA> --pr-number <PR> --backend-base-url <approved-private-backend-origin> --case-id useful_grounded_guide --scenario-file /operator/scenarios.json --session-file /operator/session.json --approval-file /operator/approval.json --attestation-file /operator/attestation.json --trust-file /operator/trust.json --execute --allow-network
```

Verify one case per approved session where necessary; uncertain timeout/provider
failure closes the broker, and a fresh signed approval is required to continue.
Saved sanitized case evidence can be combined offline for full-suite contract
verification. That checks the required eight-case shape; it does not establish
trusted live execution. Only the executing trusted verifier can attest a live
case after checking signed admission and independent broker snapshots. Offline
JSON alone must never produce a live-backend success claim.
An authenticated full-suite aggregation authority is a remaining implementation
gap; the current trusted runner verifies individual cases, and the offline
aggregate reports contract success with live-backend status unverified.

## Adding a repository module

Implement a `LivePrPreviewModuleAdapter` and register its fixed factory in the
private launcher. Its `validateInput` calls the module's existing validator;
its `execute` reuses that module's real backend pipeline with an injected
broker-scoped client and explicit transient/isolated execution. Observe source,
validation, generation and audit outcomes where they actually happen, and bind
the accepting audit to the final delivered text. Do not call an arbitrary URL,
module catalog dispatcher, public route, storage job or production auth surface.
Add module-specific positive/negative tests and approve the new module in
`moduleIds` only after reviewing that wiring.

The shared current acceptance profile is `grounded-audited-answer-v1`, independent
of game or module. It requires acquired passages, grounding, citations and the
module's mandatory final answer audit. Gaming is the first concrete backend
adapter; other adapters are not implicitly installed or approved. Local tests
also exercise a non-Gaming adapter and module scope. Source-free, write,
background-worker or database profiles need separately reviewed requirements
and implementation; another module ID cannot weaken this profile's gates.

## Acceptance, failures and evidence

All eight cases are required for full live-backend acceptance:

| Case | Required boundary |
| --- | --- |
| Useful grounded guide | Real supplied-source acquisition, useful generation, completed accepting audit bound to final text, valid citations, grounded supplied evidence, no fallback |
| Incompatible source | Backend source compatibility rejection before provider calls |
| Insufficient evidence | Backend evidence rejection before provider calls |
| Acquisition failure | Real acquisition failure before provider calls |
| Model timeout | Observed generation transport timeout; audit not run; no accepted answer |
| Audit timeout | Generation completed, observed mandatory audit timeout; no accepted answer |
| Exhausted budget | Trusted budget rejection before another provider invocation |
| Unauthorized test identity | Authentication rejected before backend/provider execution |

Choose controlled public negative sources and bounded transport/time budgets;
the case label never causes the pipeline to manufacture the expected outcome.
Timeouts must be observed, not inferred from any arbitrary unavailable/fallback
response. A case that does not reach its intended boundary fails verification.
HTTP 200, source-fetch success alone, generation alone, partial audit, unbound
assessment, dry-run, incomplete completion and fallback all fail acceptance.

Evidence identifies exact approved PR SHA, deployment, mode, fixed stage outcomes,
sanitized citation origins/document digests, audit status/decision/final binding,
per-case provider observations, cumulative broker requests, reserved/observed
tokens and spending, requested/actual model identities, limits and remaining gaps.
It omits prompts, source passages,
final answer prose, URL paths/query/fragment, raw errors and all credentials.
Trusted broker snapshots must reconcile provider observations. The operator's
source manifest retains original public URLs privately for review. Sanitized
observations from approved PR code do not prove honest behavior of malicious
code; platform containment and trusted broker caps are independent safeguards.
Only this fixed sanitized evidence projection is suitable for review artifacts.
Treat all runtime diagnostic files and PR process stdout/stderr as private,
untrusted data; do not publish or forward them as evidence. The runtime is
credential-free apart from ephemeral bearers, which must never be logged.

The broker reserves serialized UTF-8 request bytes plus a fixed framing allowance
as a conservative input-token bound and the full output cap. It charges all
approved attempts and never refunds uncertain calls. Only textual Responses
requests and approved model metadata are permitted; provider storage and streaming
are disabled. Calls stop at request, token, spending, duration or concurrency
limits. Missing/invalid provider usage closes the run. Internal pipeline stages
remain governed by existing bounded policy and each native attempt must pass the
same broker admission; there is no unmetered retry lane.
`maxRequests` bounds authenticated backend executions and separately all native
broker requests, including model metadata. Public source acquisition retains
the existing adapter's source-count, redirect, byte and timeout limits within
the signed request/run deadline; Gaming exposes at most eight public sources.
It is not counted as a model request or billed token usage.

Provider tokenizer/framing changes, inaccurate operator pricing, account-side
billing adjustments and a provider continuing work after cancellation cannot be
enforced to the cent by this application. Reservations, strict response caps and
no refunds bound admission conservatively; separately set a dedicated provider
project budget and reconcile billing. Account-side budget precision is a remaining
gap, not an implied approved cap. No durable SQL behavior or real ChatGPT OAuth,
consent, refresh or installed-plugin acceptance is claimed by this lane.

## Rollback and local verification

Stop the separately approved supervisor and private runtime, revoke/expire their
scoped credentials and remove only the independently verified live environment
through an approved operator action. Keep the sealed lifecycle unchanged. No
existing protections or Gitleaks scan range is changed by this implementation.

Run the focused `.test.mjs` policy/broker/runner/verifier/start/E2E tests, the
`tests/gaming-live-runtime.test.ts` and private-app authentication tests, root
type-check/lint/build, source/compiled sealed-import checks, preview workflow and
containment regressions, and documentation checks with the pinned toolchain.
These are local non-paid checks; database suites and deployed/live acceptance are
separate explicitly authorized stages.
