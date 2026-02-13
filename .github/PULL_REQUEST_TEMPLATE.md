## Overview
Describe the change and user impact in 1-3 sentences.

## Prerequisites
- [ ] Branch is up to date with target base branch
- [ ] Scope is limited to a single coherent change

## Setup
Validation run before requesting review:
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
- [ ] Backend startup and `/health` check
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
- Evidence (logs/screenshots/tests):
