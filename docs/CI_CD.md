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
