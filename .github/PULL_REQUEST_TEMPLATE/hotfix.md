## Overview
Describe the production issue and why this is a hotfix.

## Prerequisites
- [ ] Issue reproduced and severity confirmed
- [ ] Scope limited to minimal fix

## Setup
Required verification before merge:
- [ ] `npm run build`
- [ ] Targeted tests executed
- [ ] Basic health check verified

## Configuration
- [ ] No secret/config changes
- [ ] Required variable changes documented
- [ ] Security implications reviewed

## Run locally
- [ ] Reproduction no longer occurs locally
- [ ] No obvious regression in adjacent flow

## Deploy (Railway)
- [ ] Deploy order and rollback plan documented
- [ ] On-call/owners notified
- [ ] Post-deploy checks listed (`/health`, key endpoint)

## Troubleshooting
If hotfix fails in production, rollback trigger:
- [ ] Error-rate spike
- [ ] Health check failures
- [ ] New critical regression

## References
- Incident ticket:
- Related issue:
- Follow-up hardening TODO:
