# Security Policy

## Overview
Arcanos handles API keys, backend tokens, and optional automation paths. This document defines reporting, secret handling, and operational hardening.

## Prerequisites
- Understand local `.env` usage and Railway secret management.
- Use least-privilege access for repository and Railway roles.

## Setup
If you find a vulnerability:
1. Do not open a public issue.
2. Report privately using GitHub Security Advisories: `https://github.com/pbjustin/Arcanos/security/advisories/new`.
3. Include impact, reproduction steps, and suggested mitigations.

## Configuration
Secret and auth guidance:
- Never commit real values from `.env` or `daemon-python/.env`.
- Use Railway Variables for production secrets (`OPENAI_API_KEY`, `DATABASE_URL`, etc.).
- Keep `DEBUG_SERVER_TOKEN` set when daemon debug server is enabled.
- Keep `DEBUG_SERVER_ALLOW_UNAUTHENTICATED=false` except isolated local testing.
- Prefer HTTPS for daemon backend routing (`BACKEND_ALLOW_HTTP=false` except local dev).

## Run locally
Recommended checks:
```bash
npm audit --audit-level=moderate
```

Optional daemon dependency/security checks (in daemon venv):
```bash
python -m pip list --outdated
```

## Deploy (Railway)
- Store secrets only in Railway Variables or GitHub Actions Secrets.
- Keep production and development environments separated.
- Validate post-deploy health: `/health`, `/readyz`.
- If a secret leaks, rotate immediately and redeploy.

## Troubleshooting
- Suspected leaked key: rotate key, invalidate old token, redeploy, review logs.
- Unexpected debug endpoint access: rotate `DEBUG_SERVER_TOKEN` and review daemon host/network exposure.
- Repeated confirmation bypass concerns: review `TRUSTED_GPT_IDS`, `ARCANOS_AUTOMATION_SECRET`, and header usage.

## References
- Security advisories: `https://github.com/pbjustin/Arcanos/security`
- Railway secrets docs: `https://docs.railway.app/guides/variables`
- OpenAI key safety: `https://platform.openai.com/docs/guides/security`
- TODO: add dedicated private security contact email if the maintainers publish one.
