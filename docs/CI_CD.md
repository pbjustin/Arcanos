# CI/CD and Environment Separation

## Overview
This repository uses GitHub Actions workflows in `.github/workflows/` for build/test validation, docs checks, release automation, and Railway deployment helpers.

## Prerequisites
- Exact Node.js 24.18.1 with its bundled npm 11.16.0 for local workflow parity. Every maintained `actions/setup-node` selector resolves to that exact version.
- GitHub repository write access.
- Required secrets configured in repository/environment settings.
- Railway project access for deployment workflows.

## Setup
Core workflows to review first:

- [CI/CD pipeline](../.github/workflows/ci-cd.yml)
- [PR CI](../.github/workflows/pr-ci.yml)
- [Documentation audit](../.github/workflows/doc-audit.yml)
- [Documentation update analysis](../.github/workflows/auto-update-documentation.yml)
- [Documentation link audit](../.github/workflows/documentation-links.yml)
- [Release](../.github/workflows/arcanos-release.yml)
- [Arcanos deployment](../.github/workflows/arcanos-deploy.yml)
- [Railway automatic deployment](../.github/workflows/railway-auto-deploy.yml)
- [Railway worker-diagnostics preview cleanup](../.github/workflows/railway-worker-diagnostics-preview-cleanup.yml)

## Configuration
Common secrets referenced in workflows:
- `GITHUB_TOKEN` (provided by GitHub Actions)
- `OPENAI_API_KEY`
- `RAILWAY_PRODUCTION_PROJECT_TOKEN` (a Railway project token dedicated to the
  exact production project/environment used by the automatic deployment
  workflow; do not substitute an account/workspace API token)
- `RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN` (dedicated token scoped only
  to the pinned Railway workspace and used only by the trusted
  disposable-environment cleanup workflow; do not substitute an account-wide
  or production environment project token)

Environment separation guidance:
- Use Railway `production` and `development` variable sets from `railway.json` as baseline.
- Keep production and development secrets separate in both Railway and GitHub.
- Restrict deployment-triggering workflows to protected branches.

Documentation automation boundaries:

- The `docs:check` job in `.github/workflows/doc-audit.yml` is the stable
  documentation-integrity status context required on `main`.
- `.github/workflows/auto-update-documentation.yml` is report-only. It has
  `contents: read`, validates bounded output for its single maintained target,
  and uploads a patch for human review. It never commits, pushes, or opens a
  pull request. Its production-mode localhost server receives a fresh masked
  32-byte random `ARCANOS_JOB_READ_CAPABILITY_SECRET` only after install and
  build; the parent shell unsets the value immediately after spawning the
  server so the analysis client cannot inherit it. The workflow does not read
  a repository or production job-read signing secret.
- `.github/workflows/documentation-links.yml` runs a read-only external-link
  audit every Monday at 13:17 UTC and on manual dispatch. It writes only a job
  summary and a redacted workflow artifact.

Release automation boundaries:

- `.github/workflows/arcanos-release.yml` accepts only an exact SemVer tag whose
  commit is reachable from the repository's default branch. The workflow
  resolves and records both the tag object and commit, then rechecks both in a
  fresh checkout and against the live remote immediately before publication.
- The exact candidate commit must already have a successful run of
  `.github/workflows/ci-cd.yml` named `CI/CD Pipeline`. The release workflow
  queries that evidence with read-only Actions access before running candidate
  validation. That workflow's `All Checks Complete` job runs even after a
  failed, cancelled, or skipped dependency and accepts only the exact direct
  dependency set with every result equal to `success`; release validation does
  not reinterpret a skipped PostgreSQL suite as successful evidence.
- Full and patch releases run the same Node and Python production dependency
  policies before `npm ci --ignore-scripts`, followed by type-check, lint, build,
  Railway compatibility, and Jest gates. A missing, malformed, incomplete, or
  policy-rejected `npm audit` report is blocking, and installation or validation
  must leave tracked files unchanged.
- Broad dependency lifecycle scripts remain disabled. The workflow explicitly
  runs only `node node_modules/@prisma/client/scripts/postinstall.js` after
  installation because the audited package requires it to generate the
  TypeScript stubs consumed by type-check and build.
- The trusted default-branch copy of `scripts/check-npm-audit.js` is the
  authoritative production-vulnerability policy. It rejects incomplete or
  internally inconsistent audit-v2 reports and treats every reported
  vulnerability as actionable; there is no npm advisory, package, dependency
  path, or platform-profile exception registry. Workflows record npm's raw audit
  exit code while relying on this fail-closed zero-vulnerability policy.
- Required CI and release validation pin `pip-audit` to `2.10.1` and contain no
  Python vulnerability ignores.
- Patch mode can only append deterministic validation notes to an existing
  GitHub release. It never uploads, replaces, or deletes release assets. Full
  releases rely on GitHub's automatically generated source archives.
- The validation job has read-only repository and Actions access. Only the
  final notes-publication job has `contents: write`, and all reusable actions
  are pinned to immutable commits. Release notes do not invoke an AI provider or
  receive a provider secret.

## Run locally
Pre-CI local validation:
```bash
npm run type-check
npm run lint
npm test
npm run build
npm run docs:check
npm run docs:links -- --local-only
npm run validate:railway
```

The broad local `npm test` and `npm run test:integration` commands intentionally
leave disposable-database suites optional when no dedicated test URL is
configured. A green run without the required PostgreSQL mode is not PostgreSQL
engine, locking, migration, or atomicity evidence.

The standalone runtime's real Redis admission suite is intentionally separate:

```bash
AI_RUNTIME_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
AI_RUNTIME_TEST_REDIS_CONFIRM_DISPOSABLE=disposable-loopback-only \
npm run test:runtime-redis-integration
```

Run it only against a disposable loopback Redis instance. The test rejects
remote hosts and databases other than 15, deletes only its randomized admission
namespaces, and never flushes the database. The authoritative CI pipeline runs
the standard standalone runtime regression suite and this two-connection Redis
and real BullMQ execution-fence suite in the required
`runtime-redis-admission` service job.

The root public-provider admission Lua gate reuses that job's Redis 7 service
on isolated database 14:

```bash
PUBLIC_PROVIDER_TEST_REDIS_URL=redis://127.0.0.1:6379/14 \
PUBLIC_PROVIDER_TEST_REDIS_CONFIRM_DISPOSABLE=disposable-loopback-only \
npm run test:public-provider-redis-integration
```

The named command fails when either explicit test variable is missing. Its
target guard rejects credentials, remote hosts, query/fragment components, and
databases other than 14. The suite exercises the production Lua through two
connections for atomic global concurrency, caller denial ordering, expiry,
restart/namespace continuity, and corrupt-counter failure; cleanup deletes only
the exact randomized keys tracked by the test and never flushes Redis.

The required `PostgreSQL Fencing & Local Agent Concurrency` job provisions an
isolated PostgreSQL 18 service with database
`arcanos_audit_pg18_20260727`. It runs both
`npm run test:local-agent-postgres` and `npm run test:postgres-fencing` through
nine dedicated test-only URL variables: local-agent hardening, job-claim
fencing, DAG-snapshot fencing, worker-budget identity, stale-recovery batching,
Backstage roster atomicity, Backstage storyline atomicity, Backstage canon
storyline atomicity, and non-GPT terminal retention. The fencing command
includes the storyline and canon forward/runtime/rollback DDL, advisory-lock
and canon-head concurrency, mixed-version table-writer fencing, retention
order, and legacy-containment suite, plus retention-writer and lock-skipping
cleanup proof.

CI sets the single sentinel `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` for both
package commands. Every one of the nine suites resolves its own dedicated URL
before it can select `describe.skip`; a missing or blank URL, or a nonempty
sentinel value other than `1`, fails before database work. The URLs never fall
back to ambient `DATABASE_URL`, and each suite is guarded to the exact
credentialed loopback database. Local runs may omit the sentinel to retain an
intentional no-database skip, but such a run is not required-suite evidence.

The stable `All Checks Complete` context uses `if: always()` and
`scripts/verify-required-ci-results.mjs` to inspect the exact direct `needs`
set. Any failed, cancelled, skipped, missing, or unexpected dependency makes
the aggregate fail. Its success means the tracked required CI jobs reported
success; production promotion and live readiness remain separate rollout
decisions.

## Deploy (Railway)
Deployment workflows are repository-specific; verify current trigger and required
secrets in each workflow file before enabling auto-deploy.

Railway-native PR deployments run the protected-digest wrapper before the
tracked `--pr-preview-app-safe-v1` launcher contract. The web role imports only a
credential-empty, deny-by-default synthetic generic-jobs application plus
sealed Research, Backstage storyline, MCP body-cap, status authorization, and
Gaming contract fixture surfaces; the worker role stays passive and denies the
contract paths. The
Research surface imports the central `src/shared/researchRequest.ts`
validator and storage-component helper plus the real Research abort-drain
wrapper and its narrow request-abort runtime. It does not import the normal Research
route, confirmation middleware, hub, provider, fetcher, database, memory, or
persistence code. Ten server-owned fixtures cover exact and over-limit
topic, URL count, URL item, and aggregate boundaries in JavaScript
`String.length` units, one normalized URL descriptor snapshot, and the
deterministic ASCII storage component capped at 97 UTF-8 bytes. An eleventh
`workflow-cancellation-drain` fixture executes one wrapper-owned timeout and
three server-simulated parent-abort cases across synthetic DNS, fetch, model,
and persistence seams. It proves the active seam drains before outward
settlement, later seams do not start, the same signal and deadline reach every
admitted seam, and no post-settlement mutation remains. Each abort is observed
with one active operation and the response is withheld until that operation
reaches zero; the live probe rejects a response that arrives before the bounded
300 ms aggregate drain-proof window. The parent-abort cases
are deterministic disconnect-equivalent component evidence, not literal TCP
disconnects. Research requests contain only `{ "fixture": "<sealed-name>" }`;
they never carry raw Research URLs or credentials. The descriptor probe is
constructed by the server-owned fixture;
it does not claim that caller JSON can carry accessors or property descriptors.
Accepted request-validation fixtures are reported only as eligible for confirmation;
the surface never attempts confirmation or crosses an effects boundary.

The contained Gaming layer intentionally avoids the exact production route
handlers, whose import graph reaches configured authentication, repositories,
jobs, providers/fetching, and persistence capabilities excluded by the preview
gate. The public canary instead executes a semantic-digest-pinned pure production
dispatcher, bundled-fixture validator/grounding runner, and response guard; its
success checks therefore reflect work actually performed while network and
provider stages remain `skipped`. Contract-faithful synthetic fixtures cover
guide/build/meta
queries plus production-recognized Gaming-source unauthorized, closed
validation, typed unsafe,
storage/job outage, created/replay/conflict, and queued/running/completed status
semantics. Recognized source targets without the fixed noncredential
`x-native-preview-fixture` selector return the production-shaped 401 before body
parsing, including malformed and 16,385-byte requests. After the selector, the
source boundary mirrors the production 16 KiB cap and closed 413/415 parser
responses, accepts exactly one safe status-ID decode, and rejects encoded
separators, backslashes, controls, double encodings, and malformed escapes. The
20 post-auth semantic cases are explicitly reported as `simulatedAuth`; they do
not exercise or imply bearer authentication. All newly enabled Gaming responses
identify themselves
with `X-Arcanos-Preview-Fixture: sealed-synthetic`, and the canonical source URL
uses `.invalid`. No fixture invokes a provider, fetch, database, queue, worker,
repository, or persistence mutation. The strict canary body remains identical to
the public schema and production guard, which admit no preview-only field;
`X-Arcanos-Preview-Fixture: sealed-synthetic` is the mandatory machine-readable
preview provenance.

The exact `POST /backstage/storyline-contract` surface accepts only the
server-owned `lifecycle-exact`, `phase-one-universe-binding`, `payload-over`,
`saved-storyline-projection`, and `summary-pagination` selectors. `lifecycle-exact`
calls the real storyline validator, response selector, and repository
transaction helper through a fresh per-request in-memory query adapter. Its two
mutations prove the exact 16,384-byte beat boundary, 100-beat retention,
fresh-read response, chronological newest-25 selection, and accepted-beat
inclusion. The Phase One selector routes independent mutations through two
universe-aware adapters and uses the pure confirmation-envelope builder shared
with the production gate to prove that changing only `universeId` changes the
fingerprint input; it does not issue or verify a confirmation token.
`payload-over` proves a 16,385-byte beat is rejected before the repository
helper is reached. `saved-storyline-projection` executes the production-shared
pure projector over 2,500 leading ECMAScript whitespace code points followed by
1,501 meaningful code points and returns a truncated 1,500-code-point excerpt.
It explicitly reports `databaseBoundaryReached: false` and
`sqlProjectionExecuted: false`. This is a contained component E2E, not a
database E2E: it does not connect to PostgreSQL or prove SQL-engine locking or
atomicity.
The PostgreSQL 18 CI suite remains authoritative for those properties. The
storyline fixtures carry no credentials, contact no provider, and do not reach
memory, a confirmation challenge/token store, persistence effects, or any other
protected effect.

The exact `POST /backstage/generation-contract` surface accepts only the
server-owned `route-budget-provider-delay`, `hrc-timeout-retry-cache`,
`review-completion-contract`, `compact-retry-contract`,
`notion-authority-rag-contract`,
`partition-failure-telemetry-contract`, `continuity-query-contract`, and
`continuity-subtree-contract` selectors.
The route-budget case uses the
production Backstage route-ID policy,
the real route timeout resolver, the shared Trinity run-options builder, and the
reviewed request-abort runtime around a 13,250 ms synthetic provider seam. The
runner independently requires at least 13,000 ms of wall-clock response time,
proving the hosted request crossed both former 6-second and 12-second boundaries
while retaining the 40-second provider and 60-second route budgets. The sealed
20-second case timeout is reported as `effectivePerCaseMaxRequestTimeoutMs`
separately from the caller-configured default. The HRC case executes the pure
cache orchestration seam
shared by production HRC: a real bounded synthetic timeout returns a marked
noncacheable fallback, the next call evaluates successfully, and the third is
served from the one successful cache write. The review-completion case executes
the production-shared full-review classifier, Trinity direct-answer list
normalizer, 1,600-token/style policy, and Booker review output contract against
fixed named-event and narrow-event scopes, mixed and state-field directives,
balanced and unmatched quotes, astral-letter apostrophes, quoted contractions,
Markdown markers, inline/collapsed honesty caveats, and spaced/single initials.
It proves that the canonical six-bullet response style overrides an earlier
three-bullet user request and asserts a deterministic bound on
quoted-contraction delimiter-disambiguation work. The review selector also
executes the new compact-retry assertion without changing its response so a
trusted base-pinned verifier still covers the PR-head seam. The detailed
compact-retry selector derives exact and at-most contracts plus recovery
instructions from sealed prompts, then runs the production-shared one-retry
coordinator and strict final validator across valid, malformed, under-count,
over-count, word-overflow, second-length, and non-length outcomes without a
third call. It is credential-free component evidence and does not call the
canonical route, a model provider, HRC, RAG, a database, or persistence. The
common generation dispatcher also executes the semantic-digest-pinned pure
CLEAR policy composer shared with production before every one of the seven
selectors. It assembles server-owned authority and CLEAR policy through the
production Trinity direct-answer message helper, forces one synthetic
length-exhaustion retry, and requires the same single marker/version and five
dimensions on both attempts while keeping caller and untrusted override
sentinels outside the system policy. A successful response carries the fixed
`x-arcanos-preview-backstage-clear-policy-version` proof header, which the
PR-head verifier requires; response bodies remain unchanged for the trusted
base-pinned verifier. This proves contained policy construction, ordering, and
retry reuse, not canonical-route composition, live-model compliance, or output
quality. The
Notion-authority case
makes one fixed-origin, fixed-path, no-redirect request from the deployed web
process to `api.notion.com` with a hard-coded invalid non-secret bearer and an
absolute four-second DNS/TLS/header deadline. It
accepts only Notion's JSON `401` response, cancels without reading, parsing, or
returning the body, retries zero times, and caches the reachability result for
the process lifetime. The same fixture then executes production-shared Notion
request construction, metadata/Markdown parsing, sanitization, chunking, RAG
prompt/citation framing, direct-answer message isolation, and mutation-action
recognition over sealed content. It does not use a live credential, read a live
page, connect to PostgreSQL, run the authority worker, call a model provider, or
reach a protected effect.

The exact `POST /mcp/body-cap-contract` surface accepts only the server-owned
`effective-limits` selector. It imports the config-free core used by the
production MCP pre-parser and feeds it six deterministic, chunked,
no-`Content-Length` JSON streams: exact and one byte over the hard 1 MiB
maximum, a downward 512 KiB MCP setting, and a stricter 256 KiB global JSON
setting. Each exact body reaches the synthetic downstream sentinel once; each
over-limit body returns the fixed 413 `MCP_REQUEST_TOO_LARGE` response with
`no-store`/`no-cache` headers and never reaches that sentinel. The caller sends
only the small sealed selector. This is contained component evidence, not a
literal oversized public upload, the normal `/mcp` route composition,
authentication, compression, or slow-upload proof; focused assembled-app tests
remain authoritative for those behaviors.

The exact `POST /status/auth-before-parser-contract` surface accepts only the
server-owned `auth-before-parser` selector. It executes the same production
system-state HTTP boundary and 64 KiB JSON parser used by legacy `POST /status`
against six three-chunk, no-`Content-Length` bodies. Unavailable configuration,
missing and invalid bearer values, and a valid `arcanos:read`-only principal all
return their fixed 503/401/403 responses before reading any body byte. A
server-owned synthetic operator with `mcp:invoke` passes exactly 65,536 bytes to
one no-effect downstream sentinel; 65,537 bytes return the fixed 413 without
reaching it. The outer preview request remains credential-free, the frozen
synthetic environment never mutates `process.env` or leaves the fixture, and a
paired worker request is denied. This is deployed component evidence for the
production boundary/parser sequence. It does not invoke the normal application
route, confirmation, the state manager, filesystem persistence, or a live
Railway credential; focused assembled-app tests remain authoritative for those
composition and effect properties.

`npm run check:native-pr-preview-imports` is part of both
type-check and build, and `npm run test:native-pr-preview-e2e` validates the
credential-free runner without network access. The import gate fails closed on
ambient namespace and capability aliases, dynamic/rest access, listener
aliasing, unreviewed external bindings, and launcher declaration or spawn-spec
drift. The contained child does not register runtime loader hooks; mutable
`process` state and effectful members are limited to exact reviewed uses.
Whole-object aliases, defaults, helper parameters, carriers, returns, spreads,
constructors, tagged templates, storage, and exports fail closed. Reviewed
whole-object calls are bound to unique top-level declarations, containing
functions, exact occurrence counts, and full-call AST digests. Direct mutable
environment/argument receiver calls are limited to reviewed non-mutating
methods; `valueOf` results remain tainted, including argument-bearing and
tagged calls, and writes to scalar `process` members fail closed. Sensitive
helpers cannot be aliased, carried, reassigned, or exported; the child
validator also permits the global `Object` identifier only as the exact
reviewed `Object.keys` receiver. The child entry has no runtime local static
import or re-export and performs its one exact application import only after
environment validation. The analysis is intentionally conservative across
repeated identifier spellings, so an unrelated shadow can require renaming
rather than weakening the gate. The launcher resolver, immutable
launcher-relative repository root, credential-empty child-environment builder,
contained child resolver/listener, passive and worker listener owners, worker
output source/mirror, and sole normal-runtime environment-spread helper are
pinned by exact structure or comment/format-normalized body digests; an
intentional semantic edit must update the focused mutation tests and reviewed
contract in the same PR. The complete launcher and contained-child entry files
are also pinned by comment/format-normalized semantic digests: every semantic
edit anywhere in either privileged entry requires the reviewed digest and
focused contract tests to be updated in the same PR, while comment-only and
format-only edits do not. The central Research helper, pure public Gaming
dispatcher/canary/fixture seam, pure saved-storyline excerpt projector,
config-free production MCP pre-parser core, and the exact status HTTP
authentication/body-parser seam
are likewise semantic-digest pinned. The
Research helper admits only its exact `createHash` import and pure
`Reflect.ownKeys(descriptors)` read admitted to the contained graph. The
Research abort-drain wrapper, the exact dispatch GPT identifier middleware and
its pure lane/identifier dependencies, Backstage action/timeout policy, Backstage
continuity-query core, GPT route timeout resolver, HRC cache policy, and exact
request-abort runtime source are also semantic-digest pinned; only the reviewed
timeout and AsyncLocalStorage
capabilities are admitted. A tracked checker-only TypeScript resolver points the
contained graph at that reviewed source without depending on ignored build
output. An exact package-manifest assertion pins the public subpath, and a
content-pinned post-alias build gate verifies both emitted preview imports and
their bindings resolve to `packages/arcanos-runtime/dist/requestAbort.js`, whose
comment-normalized semantic digest must match the reviewed compiled runtime. Both
required PR workflows run that contract suite. A live run requires both
`--execute --allow-network`, exact independently confirmed web/worker preview
origins, the PR number, a clean tracked/untracked worktree, the canonical
Arcanos `origin`, and the local HEAD commit. Its result is served-identity
evidence, not Railway control-plane provenance. The current fixed 129-request
plan is the
original 69-request matrix plus seven public Gaming requests, 28 Gaming-source
requests (eight true unauthenticated checks, including auth-first `OPTIONS` and
encoded-status cases, and 20 labeled `simulatedAuth` fixtures), two worker-role
Gaming denials, six sealed predictive/reactive self-heal approval cases, and one
worker-role approval-contract denial, eight sealed Backstage generation
timeout/cache/review-completion/compact-retry/Notion-authority/failure-telemetry/continuity cases, one
worker-role Backstage generation denial, one sealed
saved-storyline excerpt projection case, one canon-summary pagination case, two
sealed dispatch GPT identifier boundary cases, one worker-role dispatch
selector denial, one sealed status auth-before-parser case (the twenty-first
`simulatedAuth` request), and one worker-role status selector denial.
The failure-telemetry selector executes the exact semantic-digest-pinned pure
projection used by the production partition worker over a valid root-ID-alias
configuration and a maximum 512-failure server-owned input. The verifier pins
the opaque identities, safe fallback, deterministic order, 55,314-byte bound,
and absence of raw identifiers. It does not execute the worker loop, structured
logger sink, Railway log transport, PostgreSQL, Notion, or a model provider.
The additive subtree selector runs the production-shared continuity prompt and
public-response core over sealed relevant and two-page continuation projections.
It proves subtree-only scope/page fields stay coupled, coverage totals and source
paths remain bounded, incomplete subtree coverage fails closed, and the opaque
continuation request passes only the shape/mode preflight. It explicitly does not
execute recursive SQL, select or diversify live chunks, sign or verify cursor v3,
or reach PostgreSQL, Notion credentials, or a model provider.
The excerpt case executes the production-shared pure projector
over the full ECMAScript leading-whitespace set and explicitly reports that no
database or SQL projection ran; PostgreSQL 18 CI remains the SQL-engine proof. It
checks correlation, security, `no-store`, source and dispatch `no-cache`, bounded-body, and
synthetic-provenance headers; it is not real bearer-auth, provider, storage,
queue, or worker-execution evidence.

This repository containment is for trusted same-repository PRs and accidental
effects only. A PR controls its own launcher code, so untrusted or forked code
must not receive inherited production secrets or copied production data.
Provider-level secret isolation or a trusted-source deployment policy is a
prerequisite for those previews.

The repository-owned
[`Railway PR Preview Lifecycle`](../.github/workflows/railway-pr-preview-lifecycle.yml)
workflow replaces reliance on Railway's GitHub PR lifecycle for explicitly
opted-in previews. Only same-repository, `main`-targeted PRs carrying the exact
`railway-preview` label are eligible; drafts wait for `ready_for_review`, and
label removal, conversion to draft, retargeting away from `main`, or close
requests teardown. This opt-in is
also the scope boundary that keeps unrelated Gaming and GPT-OSS work out of the
controller. A fixed `repository_dispatch` recovery event always executes the
default-branch controller, and a six-hour scheduled sweep discovers only open
opt-in PRs plus environments carrying the controller-reserved name prefix. Every
wakeup converges current GitHub state, so replaced or stale event runs do not
replay obsolete lifecycle intent.

For an on-demand recovery, send the fixed event type with a JSON-number payload,
for example `gh api --method POST repos/pbjustin/Arcanos/dispatches -f
event_type=railway_pr_preview_reconcile -F client_payload[pr_number]=1435`.
Quoted or non-canonical PR numbers fail input validation and cannot create a
second concurrency identity.

The `pull_request_target` lifecycle job checks out `github.workflow_sha`, uses
immutable checkout/setup actions, and receives the dedicated
`RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN` only in the controller step. It rejects
account-wide tokens, requires the pinned workspace and project to be visible,
and constrains every operation to fixed project resources. The credential is
workspace-scoped at Railway, so it must still be treated as workspace authority.
PR-head code is neither installed nor executed with that credential. Store the
token as a secret on the `railway-pr-preview-lifecycle` GitHub Environment, and
restrict that environment to the protected `main` branch; both the event and
scheduled paths call the same trusted reusable three-job workflow.
The controller verifies the credential-empty two-role base and complete project
visibility, creates an exact ephemeral `pr-676861-<N>` child with initial
deploys and staged/background apply disabled, removes cloned triggers to a
twice-observed zero state, and deploys the exact head SHA worker-first. It polls
only returned deployment IDs and finally requires the exact worker/web pair to
be the sole active non-stopped successes with the reviewed PR manifest,
Railway domains, and role/readiness identities. Cleanup validates the exact
custom ownership predicate before deleting by UUID and verifies both ID and
name disappear; absence is success only after complete inventory proves base
and production visibility.

The sealed E2E runs in a separate job that has no Railway secret. It executes
the verifier from the trusted default-branch workflow SHA and uses the exact
opted-in head checkout only as clean Git provenance evidence; PR code cannot
weaken its own verdict. A PR that adds a selector must therefore run its
exact-head verifier separately against the lifecycle-created hosts; until the
change reaches the default branch, the trusted verifier may have the preceding
request count. A final trusted, no-Railway-authority job revalidates that head and
publishes `Railway PR Preview E2E` as an informational commit
status, because an ordinary `pull_request_target` job result belongs to the
trusted workflow SHA rather than the PR head. The workflow writes `pending`
before reconciliation and a terminal result afterward. Do not make this
label-opt-in status globally required: unrelated unlabeled PRs are intentionally
not preview-gated. Creating the `railway-preview` label and provisioning the
protected GitHub Environment and its dedicated workspace secret are
repository/settings operations outside source control.

The controller refuses preview creation while Railway-native PR environments
remain enabled. During cutover, provision the label and protected environment
secret first, disable
the provider-native PR lifecycle, separately inventory and explicitly dispose
of any legacy `Arcanos-pr-*` environments after exact ownership review, and then
exercise a disposable labeled PR
through creation, synchronize, exact-head E2E, and close cleanup. Production
GitHub triggers remain disabled and paired promotion remains the only normal
production writer. The introducing PR cannot test its own trusted lifecycle;
the workflow must first exist on the default branch.

The Railway worker-diagnostics cleanup workflow is a trusted
`pull_request_target: closed` boundary. It never checks out pull-request code.
It resolves only the exact
`worker-diagnostics-pr-<PR_NUMBER>-e2e` environment in the fixed Arcanos
project, rejects ambiguous or foreign-service topology, deletes by the verified
environment UUID, requires visibility of the pinned production environment
before treating absence as success, and confirms that the environment
disappeared. Its deletion step receives only
`RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN` as a step-scoped
`RAILWAY_API_TOKEN`, requires Railway's account-identity query to be denied,
then validates exact access to only the pinned workspace and project. It calls
Railway's GraphQL API directly without CLI linking. The first PR that
introduces this workflow must still delete its disposable environment manually
if it is closed without merge, because unmerged workflow code is not present
on the default branch.

The Railway automatic deployment workflow runs a repository-owned rollout-policy
job before it creates the concurrent production deployment job. The
`ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD` value has two supported states:

- An exact reviewed hold ID blocks `workflow_run` promotion. The policy job
  succeeds with a bounded skip decision, but the deployment job remains
  skipped and therefore cannot acquire or cancel production deployment
  concurrency.
- The exact sentinel `none` restores normal automatic promotion. Missing, blank,
  whitespace-padded, or malformed values fail closed.

Both jobs use reviewed immutable commits for `actions/checkout` and
`actions/setup-node`. The deployment job downloads the Railway CLI `4.30.2`
GNU archive directly from its immutable upstream release, verifies SHA-256
`e8bd57fd6517b5cf387a9c072ce79fdc069fc0b877c171b58e325b22e96c9000`
before extraction, and rejects any version output other than
`railway 4.30.2`.

The Docker runtime image separately installs the pinned musl Railway CLI
archive used by application control-plane code. It retries that one upstream
download at most five times, verifies SHA-256
`7dd6633ced5c0ac579cbeb1842bc7e4bc14cfd2d43ea2e3a00b376320f80d1ce`
before extraction, checks exact `railway 4.30.2` output, and exposes both the
explicit `RAILWAY_CLI_BIN` path and the legacy bare `railway` command. The
unchecked `@railway/cli` npm postinstall is forbidden by Railway compatibility
validation.

The workflow maps `RAILWAY_PRODUCTION_PROJECT_TOKEN` to the CLI-standard
`RAILWAY_TOKEN` only on the access probe, deployment, status polling, and
post-deploy log-check steps. Checkout, Node setup, CLI acquisition, and
configuration validation do not receive the credential; validation receives
only a configured/unconfigured boolean. The post-deploy check invokes its
checked-in Node entry point directly so npm lifecycle hooks do not inherit the
token. Before enabling or manually dispatching this workflow, independently
verify that the stored secret is a project token for the intended production
project/environment. Source code cannot prove provider-side token scope.

These supply-chain controls do not resolve the deployment checkout's persisted
read-only GitHub credential or create a protected GitHub production
environment. Checkout credential persistence and a
single-maintainer-compatible protected-environment topology remain separate
defense-in-depth and repository-settings decisions.

The production deployment job has a 130-minute GitHub Actions timeout and uses
the `railway-auto-deploy-production` concurrency group without cancelling a
run that has already started. A newer run therefore waits while the active run
continues observing any remote deployment it created. GitHub may still
coalesce older runs that have not started.

The deployment job requires `RAILWAY_PROJECT_ID`,
`RAILWAY_ENVIRONMENT_NAME`, and explicit, distinct
`RAILWAY_WEB_SERVICE_ID` and `RAILWAY_WORKER_SERVICE_ID` repository variables.
Missing credentials or any identifier fails the promotion; there is no green
automatic skip and no implicit `production` environment default.
Static Railway compatibility validation runs before the first remote mutation.
The token preflight reads a bounded Railway project inventory and attests the
exact project, the single accessible non-deleted environment with the configured
name, and one matching service instance per role. Each target must have exactly
one active `SUCCESS` deployment, whose ID becomes its baseline; a newer failed
latest deployment cannot mask that active deployment. Missing, duplicate,
malformed, or mismatched inventory fails before upload. The preflight then reads
each service's resolved identity and role. It requires a direct current web
readiness response; a public worker also receives a direct request, while a
private worker retains current Railway active-`SUCCESS` platform evidence
rather than being made public solely for CI. Swapped or duplicated targets fail
before upload.

Promotion is one worker-first pair in a single job. The workflow uploads the
exact default-branch SHA to the worker, observes only the returned worker
deployment ID, and completes its activation checks before uploading that same
SHA to the web service. Each upload has a 10-minute command timeout; each
exact-deployment observation uses a 45-minute elapsed-time budget with
ten-second polling. Every Railway status or variable read also has an explicit
timeout and output cap. After web activation, both new deployment IDs must
still be the active successful and non-stopped deployment for their exact
service.

For a public web or worker role it then makes a bounded, no-redirect
`GET /readyz` request and requires the exact role response plus
`Cache-Control: no-store`. A private worker retains Railway's platform
activation result rather than acquiring a public domain solely for CI. The
validator fixes the tracked activation contract at `/readyz`, timeout `300`,
and numeric `drainingSeconds=60`; the resolved-variable verifier also rejects a
conflicting live provider-native drain override when one is present. These are
one-time activation checks; they do not replace continuous monitoring, exact
web/worker effective-settings readback, or a measured drain rehearsal before
production promotion.

Each detached upload is a remote mutation that can outlive the GitHub runner.
The pair is coordinated but not provider-atomic. An upload timeout before an ID
is returned, a manual workflow cancellation, runner loss, worker success
followed by web failure, or a deployment that remains nonterminal beyond the
45-minute observer budget requires operator reconciliation against the logged
baseline/attempt deployment IDs, exact project, environment, service, and
revision. The workflow does not guess a prior revision, call generic
`railway redeploy`, or automatically roll application code across a potentially
incompatible schema. Post-deploy web log retrieval is limited to 30 seconds and
4 MiB and fails closed if either bound is exceeded.

The historical `20260727-dag-snapshot-generation-v1` hold protected the
coordinated DAG snapshot-generation migration. That rollout is complete and
the tracked marker is now the exact inactive sentinel `none`, so successful
default-branch CI admits normal paired promotion. If that hold is reactivated,
a deliberate `workflow_dispatch` may pass it only when the operator types
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1` exactly. That phrase
is an operator attestation, not a drain command: separately confirm the approved
revision, project, environment, database, every DAG-writing service, and the
actual stopped/drained state before dispatch.

This GitHub policy does not control Railway-native GitHub auto-deploy. Keep
native triggers disabled for both `ARCANOS V2` and `ARCANOS Worker` while this
paired workflow is the canonical production path. Enabling either native
trigger would create an independent single-service deployment that can bypass
the pair's ordering, exact-ID observation, and shared concurrency lock.

Keep the hold active during rollout and any rollback decision. After the schema
and compatible revision are verified on every DAG writer, no old writer can
still run, and post-deploy health is accepted, change the workflow marker to
`none` in a reviewed follow-up commit. Do not delete or blank the marker. The
guard remains in place for future coordinated migrations, while the `none`
state preserves the workflow's normal automatic deployment behavior.

## Troubleshooting
- Workflow fails on missing secret or paired target: restore the exact scoped
  secret and repository variables; do not convert the failure into a green skip.
- Deployment job fails after build passes: validate Railway auth token and service linkage.
- Automatic Railway deploy is skipped with
  `automatic_promotion_blocked`: inspect the active coordinated-writer hold and
  follow the Railway deployment and database migration runbooks; do not clear
  the hold merely to make the workflow green.
- Docs audit fails: run `npm run docs:check` locally.
- Scheduled link audit fails: run `npm run docs:links`; treat access-restricted
  or transient results as warnings and repair definitive failures.

## References

- [CI/CD pipeline](../.github/workflows/ci-cd.yml)
- [PR CI](../.github/workflows/pr-ci.yml)
- [Documentation audit](../.github/workflows/doc-audit.yml)
- [Documentation update analysis](../.github/workflows/auto-update-documentation.yml)
- [Documentation link audit](../.github/workflows/documentation-links.yml)
- [Arcanos deployment](../.github/workflows/arcanos-deploy.yml)
- [Railway automatic deployment](../.github/workflows/railway-auto-deploy.yml)
- [Railway worker-diagnostics preview cleanup](../.github/workflows/railway-worker-diagnostics-preview-cleanup.yml)
- [Railway configuration](../railway.json)
- [Railway deployment guide](RAILWAY_DEPLOYMENT.md)

## Workflow and npm script alignment
- Ensure that any npm scripts referenced in `.github/workflows/ci-cd.yml` (for example, `npm run audit:sdk-compliance`) are defined in `package.json`, or update the workflow to remove or replace them.
