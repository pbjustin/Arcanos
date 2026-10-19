# Gaming-scoped preview verification

This companion to [Railway deployment](RAILWAY_DEPLOYMENT.md) describes the
`gaming-synthetic-v1` verification scope. Its current implementation supports
offline execution against injected synthetic application transports. Hosted
verification is disabled: `GAMING_SCOPED_PREVIEW = NOT_RUN`. Passing assertions
do not attest Railway resources or satisfy hosted acceptance. Injected
transports are explicitly reported as unverified; offline evidence comes from
the test's independent outbound-request assertions.

PR #1558 is under a feature-scope freeze. Remaining work is limited to demonstrated
release blockers, their regression tests, necessary test-harness stabilization
and essential evidence corrections. Complete code freeze still requires green
final-candidate CI and independent review; merge remains unauthorized.

## Reused verification and fixed scope

The [combined verifier](../scripts/gaming-scoped-preview-e2e.mjs) reuses the
[native preview verifier](../scripts/native-pr-preview-e2e.mjs) and
[Gaming MCP verifier](../scripts/gaming-mcp-preview-e2e.mjs). It does not create
another deployment controller or adopt the historical three-PR stack.

| Included assertions | Coverage |
| --- | --- |
| Native scope: 63 cases | Initial/final exact-commit readiness, passive worker, health and method/path denials; public Gaming canary and guide/build/meta contracts; source authorization, parser limits, provenance, lifecycle and unsafe-source cases; shared MCP body-cap and status auth-before-parser contracts and worker denials. |
| Gaming MCP: 21 cases | Initialization/catalog, fixed query and hybrid results, closed inputs and candidate bounds, denied ingestion/refresh/storage with and without confirmation, credential-carrier rejection, malformed/oversized input, worker and metadata denials. |
| Nested Gaming production-core proofs | Synthetic extraction and source acquisition, community guide/build acceptance, game/edition identity, source-instruction rejection, CLEAR and Trinity honesty components, and other versioned Gaming proof markers required by the native verifier. |

The native plan has an explicit required-case inventory. Missing, duplicate,
changed or newly unaccounted-for Gaming descriptors fail before requests.
The combined verifier also checks the exact MCP inventory and exact executed
sequence. A required Gaming or shared-security failure fails the run; excluding
unrelated cases cannot conceal it. Reports retain `plannedCaseIds`,
`executedCaseIds` and `skippedCaseIds` rather than reporting skipped assertions
as executed.

The scope excludes the Backstage Notion connectivity selector, other Backstage
contracts, Research, Tutor, heartbeat and self-heal cases. It requires no real
Notion, application-provider or storage credentials, paid inference, production
database/Redis, durable ingestion or production deployment. The native `full`
plan and its Notion connectivity selector remain available and retain their
existing coverage. Gaming results cannot replace a full-platform result or
write success to the platform's `Railway PR Preview E2E` context.

## Policy, identity and bounds

[Scope policy](../config/railway-gaming-preview.json) fixes the scope,
`Railway Gaming Scoped Preview E2E` context and `hostedEnabled: false`.
The [policy reader](../scripts/gaming-scoped-preview-policy.mjs) uses a fixed
module-relative path, a closed schema and module-issued immutable objects.
Caller-supplied paths, equivalent JSON objects, unknown fields, scope changes
and self-activation are rejected. There is no candidate-selectable CLI scope
or hosted-activation flag.

This is preparation for trusted execution, not authority granted to candidate
files. A future hosted controller must load its own reviewed policy from the
protected-main checkout, never from the PR evidence checkout or PR-supplied
environment, dispatch payload or scope label. The current combined verifier
consults the policy's disabled hosted flag and rejects execution through
ambient `globalThis.fetch`. A caller-supplied callback can itself make network
requests, so callback identity never proves a mock or an offline run. Its
transport, effects and physical hosted execution remain unverified. The wrapper
has no Railway management authority.

The shared argument guard checks canonical repository origin, exact local HEAD,
clean tracked/untracked state, distinct isolated HTTPS preview origins and
paired execution opt-ins. Gaming evidence additionally records the Git source
tree. These checks establish local/served identity; they do not independently
prove remote base, controller ownership, source archive or deployed image.

The combined maximum is 84 sequential requests, five seconds per request,
60 seconds total, 64 KiB per response body and 512 KiB aggregate response
bodies. The MCP phase retains its stricter 128 KiB aggregate bound. The second
phase receives only the first phase's remaining time; insufficient remaining
budget fails instead of resetting it. Requests retain no-redirect and
credential-omission settings, origin restrictions and abort signals. Caller
limits can tighten these bounds. No timeout or acquisition limit is increased.
The wrapper races transport settlement against the combined request/aggregate
abort signal and errors pending response reads when it aborts. It does not
await cancellation of caller-owned work. A callback or source that ignores
cancellation can continue its effects after verification fails; those effects
remain unverified.

## Offline evidence and its limits

[Verifier tests](../scripts/gaming-scoped-preview-e2e.test.mjs) and
[policy tests](../scripts/gaming-scoped-preview-policy.test.mjs) cover fixed
inventory, scope substitution, disabled activation, failures and bounds.
[Native verifier tests](../scripts/native-pr-preview-e2e.test.mjs) check the
included and omitted descriptors and rejection of missing required proofs.
The scoped production-core proof includes bare filenames passed to intrinsic
file-input options (`--upload-file`, `--input-file` and `-T`), alongside `@` and
path operands, bundled short options and quoted option spelling. Focused
regressions also cover escaped options and generic form-field labels. An ambiguous
bare `--source` selector alone does not establish host-file access; ordinary game
selectors and complete quoted chat prose retain their positive controls.

The assembled-application regression in
[native preview application tests](../tests/native-pr-preview-application.test.ts)
routes all 84 requests through an injected local transport. It makes the
Notion connectivity seam fail if called and intercepts application `http.request`,
`https.request` and `fetch`, asserting zero calls to those seams and the Notion
seam. The test adapter alone uses a captured HTTP function for fixed loopback
listeners. Raw sockets, DNS and other HTTP entry points are not instrumented;
this test is not a general process-level network-egress proof.
One assembled verifier run uses a Jest completion checkpoint after each verified
request. The default five-second Jest limit, five-second request limit and
60-second aggregate verifier limit remain unchanged. A failed or timed-out case
aborts and drains pending transports and application responses before later tests
can reuse shared mocks. The entire matrix remains in Jest's coverage process.
A separate broad-mode regression invokes the retained Notion selector with a
mocked connectivity seam. No real Notion request is needed for either proof.
Record actual test outcomes in an exact-SHA validation receipt; this maintained
guide is not a test receipt.

Injected execution reports `offlineVerification: NOT_PROVEN`,
`transport: caller-supplied-unverified`, `hostedExecuted: null` and
`GAMING_SCOPED_PREVIEW: NOT_RUN`. The assembled test separately proves zero
application calls through those four instrumented seams; the wrapper cannot
grant that evidence to arbitrary callers.
The fixture
components use server-owned synthetic data and passive workers. They do not
prove normal-route bearer authentication, the complete acquisition/provider
graph, live publisher retrieval, real Trinity inference, active queue work,
SQL atomicity, caching/storage integration or production readiness. Focused
mocked production-path tests and disposable PostgreSQL CI remain separate
evidence. Existing source/compiled import and semantic protections still apply.

## Hosted dependency and admission requirements

The current trusted native workflow always executes its default full verifier,
including the Notion canary. Its Railway controller attests Git commit and
deployment manifests, but uses Git-source Railway builds rather than an
independently bound source archive and immutable OCI image. The stronger
[stacked-draft lane](RAILWAY_STACKED_DRAFT_PREVIEW.md) has secretless artifact
controls but admits only its historical fixed stack and remains disabled.
Neither path can be silently substituted for ordinary-PR Gaming acceptance.

The smallest safe infrastructure dependency is a separately reviewed extension
of the existing artifact components for an ordinary same-repository PR targeting
`main`. It must remove historical stack identity only through reviewed admission
policy, retain existing opt-in/non-draft requirements and require owner
authorization. It must run from protected main before it can attest #1558.
This is a separable `RELEASE_DEPENDENCY` for hosted Gaming acceptance and belongs
in a follow-up outside #1558's frozen source-validation scope. Recording that
dependency neither executes nor satisfies hosted acceptance. The candidate's
technical freeze can be assessed with this limitation documented; it does not
authorize a release or merge.
Required activation evidence includes:

- Fresh exact PR head/base and source-tree binding, expiring owner authorization,
  trusted controller revision and unchanged admission before each effect.
- Secretless contained builds, independently pinned source/compiled checks,
  source-archive digest and immutable OCI image provenance; separate publication,
  deployment and credential-free verification authority.
- A dedicated approved isolated target, no application/provider/data credentials,
  databases, Redis, volumes or inherited triggers, and verified runtime/resource
  and network boundaries before candidate code runs.
- Controller-owned exact environment/services/deployments, worker-first sole-active
  success, passive-worker readiness, the fixed Gaming scope and unchanged request
  bounds; no Notion or paid provider request.
- Bounded failure diagnostics and always-run cleanup using the independently
  bound ownership receipt, exact-resource deletion and control-plane absence
  verification; former-host checks only supplement that absence evidence.

Until those controls are reviewed, present on protected main, provisioned and
owner-authorized, hosted Gaming acceptance remains `NOT_RUN`. Do not dispatch
the broad workflow under a no-Notion restriction, enable the historical stack,
or declare a local synthetic run hosted proof. Full required CI and renewed
independent review remain separate PR-readiness gates.
