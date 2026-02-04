# CI/CD and Environment Separation

## Overview
This repository uses GitHub Actions workflows in `.github/workflows/` for build/test validation, docs checks, release automation, and Railway deployment helpers.

## Prerequisites
- GitHub repository write access.
- Required secrets configured in repository/environment settings.
- Railway project access for deployment workflows.

## Setup
Core workflows to review first:
- `.github/workflows/ci-cd.yml`
- `.github/workflows/doc-audit.yml`
- `.github/workflows/arcanos-release.yml`
- `.github/workflows/arcanos-deploy.yml`

## Configuration
Common secrets referenced in workflows:
- `GITHUB_TOKEN` (provided by GitHub Actions)
- `OPENAI_API_KEY`
- `RAILWAY_TOKEN` (for workflows that deploy through Railway CLI/actions)

Environment separation guidance:
- Use Railway `production` and `development` variable sets from `railway.json` as baseline.
- Keep production and development secrets separate in both Railway and GitHub.
- Restrict deployment-triggering workflows to protected branches.

## Run locally
Pre-CI local validation:
```bash
npm run type-check
npm run lint
npm test
npm run build
npm run validate:railway
```

## Deploy (Railway)
Deployment workflows are repository-specific; verify current trigger and required secrets in each workflow file before enabling auto-deploy.

## Troubleshooting
- Workflow fails on missing secret: add the secret in GitHub settings or disable that job.
- Deployment job fails after build passes: validate Railway auth token and service linkage.
- Docs audit fails: run `./scripts/doc_audit.sh` locally.

## References
- `../.github/workflows/ci-cd.yml`
- `../.github/workflows/doc-audit.yml`
- `../.github/workflows/arcanos-deploy.yml`
- `../.github/workflows/arcanos-ci-cd-pipeline.yml`
- `../railway.json`
- `RAILWAY_DEPLOYMENT.md`

## TODO (verified)
- `ci-cd.yml` currently references `npm run audit:sdk-compliance`, but that npm script is not present in `package.json`. Add script or update workflow.
