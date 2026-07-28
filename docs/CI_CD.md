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

## Configuration
Common secrets referenced in workflows:
- `GITHUB_TOKEN` (provided by GitHub Actions)
- `OPENAI_API_KEY`
- `RAILWAY_TOKEN` (for workflows that deploy through Railway CLI/actions)

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
  Railway compatibility, and Jest gates. A failed or incomplete `npm audit`
  report is blocking, and installation or validation must leave tracked files
  unchanged.
- Broad dependency lifecycle scripts remain disabled. The workflow explicitly
  runs only `node node_modules/@prisma/client/scripts/postinstall.js` after
  installation because the audited package requires it to generate the
  TypeScript stubs consumed by type-check and build.
- The trusted default-branch copy of `scripts/check-npm-audit.js` is the
  canonical exception policy.
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

The required `PostgreSQL Fencing & Local Agent Concurrency` job provisions an
isolated PostgreSQL 18 service with database
`arcanos_audit_pg18_20260727`. It runs both
`npm run test:local-agent-postgres` and `npm run test:postgres-fencing` through
their dedicated test-only URL variables. Local runs must likewise use an
explicit disposable database; neither command should inherit an ambient
`DATABASE_URL`.

## Deploy (Railway)
Deployment workflows are repository-specific; verify current trigger and required
secrets in each workflow file before enabling auto-deploy.

The Railway automatic deployment workflow runs a repository-owned rollout-policy
job before it creates the concurrent production deployment job. The
`ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD` value has two supported states:

- An exact reviewed hold ID blocks `workflow_run` promotion. The policy job
  succeeds with a bounded skip decision, but the deployment job remains
  skipped and therefore cannot acquire or cancel production deployment
  concurrency.
- The exact sentinel `none` restores normal automatic promotion. Missing, blank,
  whitespace-padded, or malformed values fail closed.

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
- [Railway configuration](../railway.json)
- [Railway deployment guide](RAILWAY_DEPLOYMENT.md)

## Workflow and npm script alignment
- Ensure that any npm scripts referenced in `.github/workflows/ci-cd.yml` (for example, `npm run audit:sdk-compliance`) are defined in `package.json`, or update the workflow to remove or replace them.
