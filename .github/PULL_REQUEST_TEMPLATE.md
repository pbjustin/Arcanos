## Overview
Describe the change and user impact in 1-3 sentences.

## Prerequisites
- [ ] Branch is up to date with target base branch
- [ ] Scope is limited to a single coherent change

## Setup
Validation run before requesting review:
Choose checks for the changed area in [CONTRIBUTING.md](../CONTRIBUTING.md).
Mark irrelevant or unexecuted checks as not run with a reason; do not start a
service solely to validate documentation.

- [ ] `npm run docs:check` and `npm run docs:links -- --local-only` (documentation changes)
- [ ] `git diff --check`
- [ ] `npm run type-check`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run validate:railway` (when deploy-affecting)

## Configuration
Configuration and secrets changes:
- [ ] No env changes
- [ ] `.env.example` updated for new vars
- [ ] Railway variable changes documented
- [ ] Security-sensitive changes reviewed

## Run locally
Manual verification performed:
Identify the exact local/fixture/preview/live target and authorization when
applicable. A fixture or liveness pass does not prove live dependencies.

- [ ] Backend startup and `/healthz` check
- [ ] Changed endpoints/scripts tested locally
- [ ] Confirmation-gated routes tested (if applicable)

## Deploy (Railway)
Deployment notes:
- [ ] No deploy impact
- [ ] Backward-compatible deploy
- [ ] Rollback plan documented

## Troubleshooting
Known risks / follow-ups:
- [ ] None
- [ ] TODOs listed in PR description

## References
- Related issue(s):
- Docs updated (paths):
- Evidence (redacted logs/screenshots/tests, exact revision and limitations):
