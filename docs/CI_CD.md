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

## Deploy (Railway)
Deployment workflows are repository-specific; verify current trigger and required secrets in each workflow file before enabling auto-deploy.

## Troubleshooting
- Workflow fails on missing secret: add the secret in GitHub settings or disable that job.
- Deployment job fails after build passes: validate Railway auth token and service linkage.
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
