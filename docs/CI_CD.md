# CI/CD and Environment Separation

## Overview
This repository uses GitHub Actions workflows in `.github/workflows/` for build/test validation, docs checks, release automation, and Railway deployment helpers.

## Prerequisites
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
  pull request.
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
  validation.
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
  internally inconsistent audit-v2 reports and every unregistered advisory,
  package, or dependency path. Advisories disclosed on 2026-08-03 whose patched
  releases are not yet available from npm have temporary exact-advisory and
  exact-node exceptions bound to exact aggregate and per-advisory severities,
  one complete observed platform graph (Linux npm 10 or Windows npm 10/11), a
  record-consistent severity histogram, the candidate lockfile's exact versions,
  sources, integrity hashes, profile-specific propagated dependency sets, and
  remediation metadata; review and remove them no later than 2026-08-10.
  Workflows record npm's raw audit exit code while relying on the fail-closed
  policy classification.
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
their dedicated test-only URL variables. The fencing command includes the
Backstage storyline forward/runtime/rollback DDL, advisory-lock concurrency,
retention-order, and legacy-containment suite. CI sets
`BACKSTAGE_STORYLINE_ATOMICITY_REQUIRE_DATABASE=1`, so a missing storyline test
URL fails instead of silently skipping. Local runs must likewise use an explicit
disposable database; neither command should inherit an ambient `DATABASE_URL`.

## Deploy (Railway)
Deployment workflows are repository-specific; verify current trigger and required
secrets in each workflow file before enabling auto-deploy.

Railway-native PR deployments use the tracked
`--pr-preview-app-safe-v1` launcher contract. The web role imports only a
credential-empty, deny-by-default synthetic generic-jobs application plus
sealed Research and Backstage storyline contract fixture surfaces; the worker
role stays passive and denies both contract paths. The
Research surface imports only the central `src/shared/researchRequest.ts`
validator and storage-component helper. It does not import the normal Research
route, confirmation middleware, hub, provider, fetcher, database, memory, or
persistence code. Its ten server-owned fixtures cover exact and over-limit
topic, URL count, URL item, and aggregate boundaries in JavaScript
`String.length` units, one normalized URL descriptor snapshot, and the
deterministic ASCII storage component capped at 97 UTF-8 bytes. Requests contain
only `{ "fixture": "<sealed-name>" }`; they never carry raw Research URLs or
credentials. The descriptor probe is constructed by the server-owned fixture;
it does not claim that caller JSON can carry accessors or property descriptors.
Accepted fixtures are reported only as eligible for confirmation;
the surface never attempts confirmation or crosses an effects boundary.

The exact `POST /backstage/storyline-contract` surface accepts only the
server-owned `lifecycle-exact` and `payload-over` selectors. `lifecycle-exact`
calls the real storyline validator, response selector, and repository
transaction helper through a fresh per-request in-memory query adapter. Its two
mutations prove the exact 16,384-byte beat boundary, 100-beat retention,
fresh-read response, chronological newest-25 selection, and accepted-beat
inclusion. `payload-over` proves a 16,385-byte beat is rejected before the
repository helper is reached. This is a contained component E2E, not a database
E2E: it does not connect to PostgreSQL or prove SQL-engine locking or atomicity.
The PostgreSQL 18 CI suite remains authoritative for those properties. The
storyline fixtures carry no credentials, contact no provider, and do not reach
memory, confirmation, persistence effects, or any other protected effect.

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
format-only edits do not. The central Research helper is likewise
semantic-digest pinned, with only its exact `createHash` import and pure
`Reflect.ownKeys(descriptors)` read admitted to the contained graph. Both
required PR workflows run that contract suite. A live run requires both
`--execute --allow-network`, exact independently confirmed web/worker preview
origins, the PR number, a clean tracked/untracked worktree, the canonical
Arcanos `origin`, and the local HEAD commit. Its result is served-identity
evidence, not Railway control-plane provenance. The fixed 65-request plan is the
original 50 checks, ten Research web fixtures, three storyline web requests (two
`lifecycle-exact` requests plus `payload-over`), and
one worker-role denial for each contract path.

This repository containment is for trusted same-repository PRs and accidental
effects only. A PR controls its own launcher code, so untrusted or forked code
must not receive inherited production secrets or copied production data.
Provider-level secret isolation or a trusted-source deployment policy is a
prerequisite for those previews.

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

The production deployment job has a 60-minute GitHub Actions timeout and uses
the `railway-auto-deploy-production` concurrency group without cancelling a
run that has already started. A newer run therefore waits while the active run
continues observing any remote deployment it created. GitHub may still
coalesce older runs that have not started.

The deployment job captures the exact deployment ID returned by its own
detached upload and observes deployment history for that ID only. The upload
has a 10-minute command timeout; observation uses a 45-minute elapsed-time
budget with ten-second polling. Each Railway status or variable read also has
an explicit timeout and output cap. That exact deployment must reach Railway
`SUCCESS`, after which the job runs
`node scripts/validate-railway-compatibility.js`, confirms the same deployment
remains the active successful and non-stopped deployment, and reads the exact
service's resolved Railway identity and role.
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

The detached upload is a remote mutation that can outlive the GitHub runner.
An upload timeout before an ID is returned, a manual workflow cancellation,
runner loss, or a deployment that remains nonterminal beyond the 45-minute
observer budget requires operator reconciliation against the exact project,
environment, service, and revision. The workflow does not call `railway down`
because that command does not safely target the captured in-flight deployment.
Post-deploy log retrieval is limited to 30 seconds and 4 MiB and fails closed
if either bound is exceeded.

The active `20260727-dag-snapshot-generation-v1` hold protects the coordinated
DAG snapshot-generation migration. A deliberate `workflow_dispatch` may pass it
only when the operator types
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1` exactly. That phrase
is an operator attestation, not a drain command: separately confirm the approved
revision, project, environment, database, every DAG-writing service, and the
actual stopped/drained state before dispatch.

This GitHub policy does not control Railway-native GitHub auto-deploy. Keep that
trigger disabled on every production writer for the entire coordinated rollout;
for the current topology, independently verify `ARCANOS V2` and
`ARCANOS Worker`. Re-enable native triggers only after every writer is on the
accepted revision and the reviewed `none` follow-up has restored normal
repository promotion.

Keep the hold active during rollout and any rollback decision. After the schema
and compatible revision are verified on every DAG writer, no old writer can
still run, and post-deploy health is accepted, change the workflow marker to
`none` in a reviewed follow-up commit. Do not delete or blank the marker. The
guard remains in place for future coordinated migrations, while the `none`
state preserves the workflow's normal automatic deployment behavior.

## Troubleshooting
- Workflow fails on missing secret: add the secret in GitHub settings or disable that job.
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
