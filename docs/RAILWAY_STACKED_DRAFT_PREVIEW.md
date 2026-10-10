# Isolated Railway preview for the Gaming draft stack

This companion to [Railway deployment](RAILWAY_DEPLOYMENT.md) describes a
separate, owner-activated lane for `main → #1533 → #1534 → #1535`. The lane is
inactive by default. Its initial configuration has `enabled: false` and no
target. This document records the architecture and threat model before the
new implementation; it is not a deployment, test receipt, or permission to
activate infrastructure. All three Gaming PRs remain drafts.

## Existing controls and their rationale

The existing [preview lifecycle](../scripts/railway-pr-preview-lifecycle.mjs)
admits an opted-in, same-repository, open, non-draft PR whose base branch is
`main`. Its [trusted workflow](../.github/workflows/railway-pr-preview-run.yml)
checks out `github.workflow_sha` for credential-bearing management and status
jobs. A separate credential-free verifier reads the PR checkout as Git
evidence. The legacy policy remains unchanged.

The maintained runbook explicitly explains two controls: the opt-in label
prevents previews for unrelated work, and trusted default-branch execution
prevents PR code from weakening its own credential-bearing controller. The
code and runbook explicitly state the non-draft/main admission rule. A
historical rationale that drafts are less stable or stacked branches are
inherently unsafe has not been established; that explanation would be an
inference. The actual new risk is executing a predecessor's or candidate's
workflow with platform credentials. Removing the two admission conditions
alone would not address that risk.

The existing sealed launcher and import/semantic pins protect reviewed PRs
from accidental effects. They do not isolate secrets from malicious build,
dependency, startup, or PR code. The broad native verifier also includes a
fixed Notion canary using a synthetic invalid bearer. A Gaming-only probe
must declare its outbound scope; it must not execute that canary implicitly
and claim to be entirely offline.

## Separate architecture and immutable admission

The [manual workflow](../.github/workflows/railway-stacked-draft-preview.yml)
and [stacked-lane policy](../config/railway-stacked-draft-preview.json) admit
only repository owner `pbjustin`, through an explicit dispatch executed from
protected `main`. No PR event, label, candidate workflow, predecessor branch,
or arbitrary branch may activate it. The trusted workflow/controller revision
is independent of the Gaming stack. Dispatch authorization expires within at
most two hours and binds
the requested head; it is not reusable permission for a changed candidate.

The allowlist is deliberately narrow:

| PR | Required head branch | Required base branch |
| --- | --- | --- |
| [#1533](https://github.com/pbjustin/Arcanos/pull/1533) | `codex/gaming-generic-foundation-1532` | `main` |
| [#1534](https://github.com/pbjustin/Arcanos/pull/1534) | `codex/gaming-claim-corroboration-1532` | `codex/gaming-generic-foundation-1532` |
| [#1535](https://github.com/pbjustin/Arcanos/pull/1535) | `codex/gaming-generic-benchmark-1532` | `codex/gaming-claim-corroboration-1532` |

Before any effect, the trusted controller rereads all three PRs. Each must be
open, draft, same-repository, and match the allowlisted branch relation. Bind
every head and base SHA, source tree SHA, trusted workflow SHA, source archive
SHA-256, and eventual OCI image digest. Verify predecessor ancestry and that
no dependency commits are missing. A branch name or response header alone
does not attest artifact bytes. Reread admission before publication,
deployment, and final evidence; reject changed heads, bases, draft states,
topology, ambiguous inventories, or incomplete pagination.

The [built-in contract](../scripts/stacked-draft-preview-contract.mjs) and
[controller](../scripts/railway-stacked-draft-preview.mjs) enforce the fixed
admission and deployment boundaries. The execution planes have separate jobs
and authority:

1. **Trusted admission** resolves the exact stack and records an immutable
   source receipt. It does not execute candidate scripts or configurations.
2. **Secretless build** consumes the bound source archive in a contained
   builder, with an empty credential allowlist, no host secrets, Docker socket,
   production private-network membership, volumes, or platform token. Candidate npm lifecycle
   scripts and build tools are untrusted execution. The separate
   [reviewed-tool policy](../config/railway-stacked-draft-preview-tools.json)
   pins both checkers, their import tsconfig, and the candidate lockfile by
   SHA-256. In a fresh attestation stage, verified checker copies execute with
   Madge/TypeScript from a separate trusted-main dependency install, over
   `/app` source and emitted files as data. Candidate-installed parser packages
   cannot replace that tooling. `reviewedCandidateSha` records the pin review's
   provenance; final candidate identity comes from the authorization receipt.
   Checker or lock drift requires a separately reviewed policy update. The trusted
   [Docker scaffolding](../scripts/stacked-draft-preview.Dockerfile) uses a
   non-root candidate build and a pristine attestation stage; the
   [artifact helper](../scripts/stacked-draft-preview-build.mjs) hashes compiled
   output and records the pruned dependency inventory. Builder settings request
   two CPUs and 2 GiB through a dedicated BuildKit container. Local builder
   read-back on 2026-10-10 observed `Memory: 2147483648`, `CpuQuota: 200000`
   and `CpuPeriod: 100000`. This proves that builder's configured limits;
   final build execution and hosted runtime limits need separate receipts.
   The trusted install disables lifecycle scripts, includes all six workspace
   manifests, and copies the checked-in `vendor/minimatch-9.0.7` JavaScript
   while excluding ambient `node_modules` and Git metadata. Attestation uses
   the pristine stage's absolute Node/npm paths, suppresses npm configuration,
   then checks the installed production inventory and absence of installed
   lockfile paths marked development-only. The tooling stage does not enter
   the final image. Actual checker/build/pruning execution remains pending
   until an exact artifact receipt is available.
   Preserve required build and coverage gates.
3. **Trusted image publication and deployment** consume the recorded artifact
   without running its code. Registry authentication and the Railway token
   belong to separate trusted jobs, never to the build sandbox or application.
   Publish only to the private OCI repository and deploy by immutable digest.
   The registry credential itself must have the least publication scope.
4. **Credential-free probing** uses reviewed trusted probes against independently
   confirmed exact-head web/worker targets. Candidate verification may only
   supplement trusted evidence from a separate credential-free process. The
   [stacked probe](../scripts/stacked-draft-preview-probe.mjs) selects 51 Gaming,
   source/auth, passive-worker denial, health, and initial/final readiness cases
   from the unchanged broad verifier. It omits the Notion canary, keeps the
   five-second request and 60-second aggregate limits, and performs no retry.
5. **Always-run cleanup** removes only resources owned by this run and verifies
   their absence, including after failure, cancellation, expiry, or head drift.
   Preserve the independently admitted ownership record for cleanup; a changed
   PR does not authorize adopting or deleting unrelated resources. The
   [runtime wrapper](../scripts/stacked-draft-preview-runtime.mjs) independently
   expires the digest-bound lease, strips secrets, `NODE_OPTIONS` and loader
   configuration before the integrity launcher, and permits at most two hours
   remaining. That lease stops workload execution; it does not prove resource
   deletion. A clone left before the durable ownership patch can be recovered
   only through the same trusted run's bound create receipt while it remains
   idle. An unproved clone is preserved for owner inspection, not automatically
   adopted or deleted by a name-only sweep.

The deployment project and workspace are dedicated to this lane. The controller
requires a new isolated workspace containing exactly the reviewed preview
project and rejects the known existing workspace. Do not reuse the existing
Arcanos main project, its preview base, or the separate Live Validation lane
associated with #1527. The configured denylist protects both existing project
IDs. The token remains workspace-scoped; the complete one-project inventory
limits its effective target scope without misrepresenting it as a project
token. No production credentials, databases, Redis, plugin configuration, shared
variables, inherited triggers, or data volumes may enter the new project.
Resource and egress controls require platform evidence before candidate code
runs, including during the build and integrity preflight. Source-level
allowlists and a sanitized application child environment are insufficient
evidence for that earlier boundary.
`privateNetworkDisabled` and workspace separation concern private-network
membership; they are not a firewall blocking public Internet or public
production URLs. Record the actual permitted egress and any provider-supported
restriction, and verify the sealed workload's outbound requests independently.
The sealed lane has no database or storage. Durable SQL verification remains
the separate disposable PostgreSQL CI gate.

## Threat model and fail-closed behavior

| Threat | Required control and evidence |
| --- | --- |
| Candidate or predecessor changes privileged workflow | Protected-main dispatch, owner actor, independently pinned trusted controller, and no candidate execution in credential-bearing jobs |
| Fork, unrelated PR, missing predecessor, or stale authorization | Fixed three-PR allowlist; same-repository, draft/base/head/ancestry checks; immutable receipt; expiration; revalidation before effects |
| Build steals credentials or reaches production | Secretless sandbox, separated upload/deploy jobs, dedicated project, names-only variable inventory, and platform resource/network isolation evidence |
| Artifact substitution or mutable image tag | Independent source archive/tree binding, private registry, exact image digest and provenance receipt, exact deployment identity |
| Candidate bypasses semantic/import checks | Trusted reviewed source and emitted-import checkers over the exact candidate bytes; preserve security assertions and proof withholding |
| Cross-run resource adoption or destructive cleanup | Run-specific namespace and ownership record, complete inventory, exact project/environment/service IDs, and protected-resource denylist |
| Failure leaves resources or successful status behind | Unconditional bounded cleanup; independent absence read-back; status tied to exact head and full probe result; cleanup failure remains visible |
| Dependency or input causes build/request exhaustion | Pinned dependencies, sandbox limits, bounded workflow/request/response budgets, no unbounded retries, retained failure/timing receipts |
| Synthetic result is presented as live release proof | Separate hosted component, live acquisition, Trinity generation, and production-release gates |

## Dependency advisories and artifact scope

The 2026-10-10 pinned Node `24.18.1` / npm `11.16.0` audit reports **47 affected
package names across 48 installed paths: 4 moderate, 42 high, 1 critical**.
These are affected package entries, including transitive propagation, rather
than 47 independent advisory roots. Every affected path is `dev: true` in the
lockfile. `npm audit --omit=dev --json` reports zero affected package entries.
The root manifest and lockfile are byte-identical between the original
#1535 head `18d1c2a89e92c77acf45c29e9700fcec0701bf07`, repaired candidate
`0aad0628897621440b59962603eecef3322861a7`, and main snapshot
`200463b3aac65eb494f71d842c1e2b0378530bfb`. These advisories predate this lane.

The static call-path/import audit inspected `0aad0628897621440b59962603eecef3322861a7`.
Its findings do not replace fresh import and artifact verification of the
infrastructure lane or final deployed Gaming head.

| Scope | Observed call path | Qualification |
| --- | --- | --- |
| Sealed runtime | Preview graph uses Express, entities, Zod, Ajv, and Cheerio; integrity core uses dotenv/Zod | No audited development package was found on those reviewed runtime import graphs |
| Trusted controller and probe | Lifecycle/status/verifier use Node built-ins and local pure/JSON modules; these controller paths do not run `npm ci` | These paths do not execute the affected npm packages; the separate trusted attestation-tool install does |
| CI tests and lint | Jest/ts-jest, TypeScript ESLint, glob/pattern tools, and workflow tests using js-yaml process candidate files/configuration | Active development-tool execution; malicious-input reachability is assessed separately from a package being installed |
| Build tools | Madge → dependency-tree → precinct eagerly loads PostCSS/source-map-js/nanoid; tsc-alias imports Chokidar/Globby | Modules are loaded; vulnerable CSS, source-map, generator-size, or glob inputs are conditional sinks, not demonstrated exploitation |
| Development initializer | ts-jest CLI `config:init` imports Handlebars and compiles a bundled static template | No tracked invocation was found; the normal Jest transformer does not import this CLI |
| Deployed artifact | Root Dockerfile installs dev tools for build, then prunes; generic `railway.json` selects Railpack without a repository prune step | Actual builder, final image inventory, pruning, and runtime retention require artifact/platform receipts |

The critical package is **Handlebars 4.7.9**, installed through
`ts-jest@29.4.6` with range `^4.7.8`. The reported critical advisories are
[AST type confusion](https://github.com/advisories/GHSA-8r5x-fm3f-whwj) and
[own-property bypass](https://github.com/advisories/GHSA-p8wg-vrv2-v86f).
The located consumer is `node_modules/ts-jest/dist/cli/config/init.js`: it
imports Handlebars at line 14 and compiles the static `JEST_CONFIG_TEMPLATE`
at line 101. Its normal transformer entry exports no CLI initializer, and
tracked scripts/workflows/tests do not invoke `config:init`. This establishes
limited observed reachability, not immunity: arbitrary PR code could import
the installed library directly, and the build already executes arbitrary PR
code. Platform containment is required independently of this advisory.

Broad upgrades are not necessary merely to make this isolated lane available
when the initializer sink remains unused and build containment is proved.
Recommend a separately reviewable compatible patch to **Handlebars 4.7.10**,
which exists, satisfies the current ts-jest range, and is outside the audited
affected ranges. Keep the lockfile diff limited, or use a ts-jest-scoped
override if necessary; rerun full/dev and production audits plus required CI.
Do not run an indiscriminate `npm audit fix`: suggested remediation for part
of the braces/tsc-alias group includes a major version change.

Artifact pruning remains a required proof. The old lifecycle expects observed
Dockerfile metadata while generic tracked configuration requests Railpack;
neither statement proves what a deployed image contains. The separate
`infra/live-validation/runtime.railway.Dockerfile` installs development
dependencies and copies the
whole build directory into its final image without pruning. Do not inherit
that image as the stacked sealed artifact or treat a production-only audit
as proof that development tools have been removed. Record the final image
package inventory and digest, production audit, entrypoint/import graph, and
absence of registry/platform/provider credentials before deployment.
Development-only installed paths are checked separately from reviewed source
material retained in the image, such as the vendored minimatch files; a prune
receipt does not claim that every development-related source file is absent.

## Five-second performance evidence

The historical failing case is
`tests/gaming-hybrid-preview-failure.test.ts:87`, “keeps the trusted response
body compatible and reports every production-core proof.” It uses Jest's
unchanged five-second default. Both the original hosted CI attempt and its
single retry exceeded that limit. **The historical CI cause remains
UNRESOLVED**: local profiling identified costly repeated DOM parsing, and a
conservative no-script JSON-evidence preflight reduced local work, but that
improvement alone does not isolate every condition of the historical runners
or establish hosted performance. Preserve that distinction in the handoff.

The guide route serially executes the full sealed production-core proof
fixtures. Measurements must retain all fixtures, negative controls, proof
headers, response assertions, source/semantic/import pins, and coverage.
Do not increase timeouts, skip cases, cache proof success across mutations,
or substitute synthetic timing claims for an executed hosted receipt.

For the final exact commit, record:

- Node/npm pins, tree/archive/image hashes, CPU quota, available memory, runner
  concurrency, startup state, and the instrumentation revision.
- Cold and warm guide request durations, CPU time, peak RSS, event-loop delay,
  status and complete proof report; keep cold and warm distributions separate.
- Minimum, median, p95, maximum, sample count, and every failed/aborted request.
  Run bounded repetitions sequentially; distinguish intentionally constrained
  stress evidence from ordinary CI and hosted results.
- The unchanged 22-case preview test result with coverage retained, plus the
  complete required CI result. A focused assertion pass whose process fails
  repository-wide coverage floors is not a successful full CI run.
- Credential-free hosted sealed guide probes under their unchanged five-second
  request limit. Record runtime errors, failed requests, identity/edition,
  scope/evidence, corroboration, diagnostics, and terminal/recovery behavior.

CPU profiling is a separate diagnostic run. Instrumentation must observe real
calls without replacing evidence extraction or weakening assertions. No live
AI call is necessary for these sealed measurements. The new instrumented
probe has no executed result until its receipt is available.

## Separately authorized live-source and Trinity plan

Hosted sealed success does not prove live acquisition or Trinity generation.
Any live phase requires a fresh owner authorization tied to the exact
candidate, approved resource, current model/pricing snapshot, source plan,
and run expiration. The existing Live Validation service or an expired Gaming
workflow must not be replayed or reused under this lane's authorization.

The live plan must include actual publisher documents for multiple unrelated
registered titles and an unknown title. Record the independently inspected
primary identity, publisher/domain, edition/DLC, platform, source scope,
extraction outcome, provenance, evidence selected/rejected, corroboration,
nine-stage diagnostics, and retention outcome. Treat unfamiliar publishers,
unknown titles, missing edition/platform evidence, conflicting primary
identities, wrong-game documents, malformed evidence and injection as honest
failure cases. No title, genre, build, or publisher exception is permitted.

Select at most two fresh generation workflows and preserve their original
evidence, revisions, idempotency, recovery limits and terminal states.
Observe actual Trinity model identities, generation and audit stages,
provider usage, grounding/citations, and final answer admission. Additional
source-only validation can broaden title coverage without claiming additional
completed generative workflows. If two workflows cannot exercise a required
generation case, leave that case blocked and request a later bounded scope;
do not reset a budget or silently replace the benchmark.

The maximum live envelope is **$2, 32 provider/metadata requests, two workflows,
4,096 output tokens per provider request, ten minutes, concurrency one, and
zero retries**. These are ceilings, not an entitlement to spend. The existing
provider budget does not establish a combined source-HTTP request ledger;
source acquisition also needs its own explicit transport/candidate/deadline
bounds and recorded request count. Owner-approved model prices and reserved
input/output costs must fit the envelope before any call. Large context or
multi-stage Trinity costs may require fewer requests, shorter context/output,
or fewer cases; reduce the workload instead of raising caps. Stop on expiry,
budget exhaustion, provider failure, cancellation, or a required negative case
reaching a provider. Keep source/prompt/provider text out of retained receipts
unless separately authorized; record safe hashes and diagnostics.

The frozen benchmark retains its existing labels, 140-sample corpus and
evaluator: baseline 40/45 valid accepted and 85/95 invalid rejected, candidate
45/45 and 95/95, candidate diagnostics 140/140. Correlated synthetic samples
do not establish production population performance. Live observations do not
silently replace that comparison or justify invalid evidence acceptance.

## Activation prerequisites and current blocker

As observed on 2026-10-10, available platform inventory contains only the two
existing projects and no dedicated stacked-preview project. No hosted
deployment for this new lane is authorized or claimed. Activation is
**BLOCKED** until the owner completes and records all of the following:

1. Review and land the trusted infrastructure lane on protected `main` through
   ordinary review. This handoff does not authorize a merge or branch-policy
   change; Gaming PRs remain drafts.
2. Provision a new isolated workspace containing only a new dedicated project
   and empty preview environment, outside the existing workspace and both
   denied projects, with no inherited production variables, resources,
   credentials, private networking access, deployment triggers, or volumes.
3. Create the separate protected GitHub Environment restricted to trusted
   `main`, with owner approval and a token scoped only to that new isolated
   workspace. The current Railway lifecycle requires this workspace capability;
   an environment-scoped project token has not been shown to manage sibling
   clones. Do not widen or reuse the existing workspace token or account-wide
   grants. Confirm the new scope supports only the admitted project and bounded
   clone/deploy/delete operations, with complete inventory before each effect.
4. Configure a private OCI repository and narrowly scoped upload/read
   credentials in their separate trusted jobs. Confirm source/image binding,
   private visibility, registry credential handling, and artifact dev pruning.
   A newly created GHCR package's default visibility does not prove an existing
   package is private. The publisher requires an existing package and checks
   private visibility before Docker authentication or push. Optional
   `registryPullCredentialSha256` binds the reviewed
   credential bytes only; the owner must independently prove pull-only scope,
   expiry, and absence of production grants. Do not publish or change package
   visibility merely to establish those prerequisites.
5. Provide platform evidence for build/runtime CPU and memory limits, egress
   and production-resource isolation, empty variables, resource ownership,
   deployment metadata, and bounded cleanup/absence verification.
6. Refresh all three exact heads, dependency ancestry, draft state and required
   CI; record an owner dispatch authorization for those immutable bytes and a
   bounded time window. Enable only the dedicated target after prerequisites
   pass. A local dry-run is not permission or hosted verification.

## Evidence and review handoff

Review the infrastructure lane separately from the Gaming changes. Review the
Gaming PRs in order **#1533, #1534, #1535**. Every executed receipt must bind
the source/head/base/tree/archive/image, trusted controller revision, relevant
workflow/job URLs, exact passed/failed/skipped counts, timing/resource data,
deployment identity, and cleanup outcome. Pending workflows and partial
results remain pending or failed.

Report `PR_1533_REVIEW_READY`, `PR_1534_REVIEW_READY`,
`PR_1535_REVIEW_READY`, `STACK_INTEGRATION_VERIFIED`,
`HOSTED_PREVIEW_VERIFIED`, `LIVE_SOURCE_ACQUISITION_VERIFIED`,
`TRINITY_GENERATION_VERIFIED`, and `PRODUCTION_RELEASE_READY` separately,
using only `VERIFIED`, `BLOCKED`, or `NOT VERIFIED`, with current evidence.
Remaining publisher extraction, unknown-title, platform applicability,
provenance, corroboration, retention and release gaps remain visible.
Sealed component proof, green CI, and a benchmark pass alone cannot establish
production readiness. No merge, production promotion, private plugin change,
credential/permission change, or paid live execution is authorized by this
document.
