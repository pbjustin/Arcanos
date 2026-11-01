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
- Keep prompt and AI-routing tracing at the default metadata-only mode or turn
  it off. Treat `PROMPT_DEBUG_TRACE_MODE=full` and every historical prompt-debug
  JSONL file as sensitive data.
- Keep prompt-debug persistence disabled unless an approved diagnostic workflow
  requires it; configure an explicit byte cap and restrict access to the exact
  storage path.

## Run locally
Dependency checks below contact external package registries/advisory services;
they are not offline documentation validation. Run them only when network
dependency analysis is in scope:
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
- With an approved target, distinguish public registry/lifecycle health
  (`/healthz` and `/health`) from activation readiness (`/readyz`). A
  successful response does not establish complete Notion authority, ingestion,
  retrieval, or protected-operation eligibility; those retain separate gates
  (see [startup resilience](docs/STARTUP_RESILIENCE.md) and
  [Railway deployment](docs/RAILWAY_DEPLOYMENT.md)).
- If a secret leaks, rotate immediately and redeploy.

## Troubleshooting
- Suspected leaked key: rotate key, invalidate old token, redeploy, review logs.
- Unexpected debug endpoint access: rotate `DEBUG_SERVER_TOKEN` and review daemon host/network exposure.
- Unexpected prompt or AI-routing trace access: rotate the control-plane access
  token, review `arcanos:read` grants, disable trace capture, and separately
  assess any configured JSONL file without printing its contents.
- Repeated confirmation bypass concerns: review `TRUSTED_GPT_IDS`, `ARCANOS_AUTOMATION_SECRET`, and header usage.

`confirmGate` is an action-confirmation gate, not caller authentication or
resource ownership. GPT identifiers from paths, bodies, or headers are metadata;
ordinary allowlist membership does not grant approval. With global allow-all
disabled, where one-time-token approval is permitted, `x-arcanos-confirm-token`
must identify an unexpired backend-issued token, which is consumed on successful
approval. Token issuance requires the
configured automation secret. These tokens are process-local and do not survive
restarts or work across replicas; an unknown token fails closed. Authenticated
automation and explicit manual confirmation retain their existing flows. Worker
healing requires an explicit execution request or the configured automation
secret; GPT identity metadata cannot enable automatic execution.
Challenge-only CEF routes accept only their issued, request-bound, one-use
challenge; other confirmation approvals cannot substitute for it. Route-specific
authentication and scopes remain required independently of confirmation. See
[CEF controls](docs/cef-hardening-controls.md).

Global allow-all compatibility remains an explicit configuration exception:
`TRUSTED_GPT_IDS` containing a standalone `*` (after trimming comma-separated
entries), or exact `ALLOW_ALL_GPTS=true`, approves every ordinary request reaching
`confirmGate`. `ALLOW_ALL_GPTS=false` does not override the wildcard. No GPT ID or
confirmation token is required, and supplied tokens are neither validated nor
consumed. This materially removes the confirmation boundary when either setting
is active and a request can reach an ordinary gated action; independent route
authentication and scopes still apply. Challenge-only routes retain their issued
one-use challenge requirement. No production configuration has been inspected
to establish whether this exposure is active.

The narrow configuration correction is to remove standalone `*` entries and keep
`ALLOW_ALL_GPTS` unset or `false`, through an authorized configuration change and
normal restart/deployment process. Callers relying on allow-all must then supply
a supported approval. Making `false` override `*` would change existing runtime
compatibility and is a separate policy change; this repair preserves that behavior.

## References
- Security advisories: `https://github.com/pbjustin/Arcanos/security`
- Railway secrets docs: `https://docs.railway.com/guides/variables`
- OpenAI key safety: `https://platform.openai.com/docs/guides/security`
- TODO: add dedicated private security contact email if the maintainers publish one.
