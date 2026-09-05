# Local Runbook

## Overview
This runbook covers local backend startup, optional daemon startup, and quick validation checks.

## Prerequisites
- Exact Node.js 24.18.1 with its bundled npm 11.16.0.
- Optional Python 3.10+ for daemon
- OpenAI API key for live AI calls; mock-mode tests do not require a real key

## Setup
Backend:
```bash
npm install
cp .env.example .env
```

Use `npm install` for local development. CI and Railway use reproducible `npm ci` installs. The Dockerfile declares its own two-stage dependency install sequence for image builds.

Set minimum backend values:
Set `PORT` to `3000` and set `OPENAI_API_KEY` to your local key in `.env`.

`PORT=3000` matches `.env.example` and the direct local server default. Railway injects `PORT`, and the Railway launcher also validates `ARCANOS_PROCESS_KIND`.

To use HTTP control-plane, legacy `POST /status`, reinforcement feedback or
inspection, `/api/self-heal/*`, `/api/self-improve/*`, detailed
`GET /status/safety/self-heal`, or `arcanos inspect self-heal` locally, also
configure a distinct `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN`,
`ARCANOS_CONTROL_PLANE_PRINCIPAL_ID`, and the least-privilege
`ARCANOS_CONTROL_PLANE_SCOPES`. Root `/memory`, `/memory/digest`, and
`/reinforcement/metrics` reads use `arcanos:read`; feedback writes and legacy
status mutation use `mcp:invoke`. Self-heal reads use `arcanos:read`; do not grant
`self-heal:probe`, `self-heal:execute`, or `self-improve:control` merely for
local health checks.

`arcanos inspect self-heal` sends the dedicated bearer only to HTTPS origins or
exact HTTP loopback origins and rejects redirects. Use HTTPS for any non-local
backend URL.

Optional daemon setup:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
# For daemon test/development work:
# python -m pip install -e ".[dev]"
cp .env.example .env
```

## Configuration
Backend local defaults are documented in `CONFIGURATION.md`. For daemon routing to backend, set:
```env
BACKEND_URL=http://localhost:3000
BACKEND_ROUTING_MODE=hybrid
ARCANOS_DAEMON_ACCESS_TOKEN=<same-distinct-32-plus-character-value-as-backend>
```

Put the same `ARCANOS_DAEMON_ACCESS_TOKEN` in the backend root `.env` and
`daemon-python/.env`. It is required for registry, heartbeat, command, result,
and confirmation traffic. `BACKEND_TOKEN` remains the optional generic
credential for non-daemon backend/GPT routes and is never a fallback for this
transport token.

## Run locally
Backend:
```bash
npm run build
npm start
```

Backend with rebuild on every run:
```bash
npm run dev
```

Dedicated async worker, after `npm run build`, when `DATABASE_URL` and `OPENAI_API_KEY` are configured:
```bash
npm run start:worker
```

`npm run start:worker` is not a read-only health check. It initializes database state, writes worker heartbeat state, and can claim queued jobs from the configured database. Point it only at an intentionally selected local/test database and queue.

Optional daemon:
```bash
cd daemon-python
arcanos
```

Validation:
```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/health
curl http://localhost:3000/api/test
```

An authenticated passive self-heal check, when the optional control-plane
identity is configured:

```bash
curl -H "Authorization: Bearer ${ARCANOS_CONTROL_PLANE_ACCESS_TOKEN}" \
  http://localhost:3000/api/self-heal/runtime
```

## Common commands
```bash
npm run build:packages
npm run build
node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false
npm run test:unit
npm run type-check
npm run lint
npm run validate:railway
npm run validate:backend-cli:offline
```

Use `npm run build:packages` before full backend validation whenever `packages/*`, protocol schemas, or package exports changed.

## Repository agent skills

Codex can discover the shared workflows in `.agents/skills/` when working in
this repository. Invoke one by name, such as `$arcanos-validation`, or describe
the matching task. Each workflow rechecks current repository instructions and
source and preserves the authorization already given for the task.

- [PR blocker review](../.agents/skills/arcanos-pr-blocker-review/SKILL.md): inspect code, CI, review threads, and merge readiness at the current PR head.
- [Validation](../.agents/skills/arcanos-validation/SKILL.md): select relevant local checks and report passed, failed, and skipped results.
- [Protocol changes](../.agents/skills/arcanos-protocol-change/SKILL.md): coordinate schemas, TypeScript/Python consumers, tests, and documentation.
- [Safe worktree synchronization](../.agents/skills/arcanos-safe-worktree-sync/SKILL.md): align a checkout with its remote while preserving local work and other worktrees.
- [Preview verification](../.agents/skills/arcanos-preview-verification/SKILL.md): verify an authorized isolated Railway preview and its scoped teardown.

## Deploy (Railway)
Local workflow should pass before Railway deploy:
```bash
npm run validate:railway
```
Then follow `RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Backend won't start: check `PORT`, `.env` loading, and the startup error in the terminal.
- Daemon exits immediately: ensure daemon `.env` has `OPENAI_API_KEY`.
- Daemon registry/heartbeat/command calls fail: verify `BACKEND_URL` and that
  both processes have the same valid `ARCANOS_DAEMON_ACCESS_TOKEN`. Generic
  GPT/backend failures may separately require `BACKEND_TOKEN`.
- Worker exits with database bootstrap errors: configure `DATABASE_URL`, `DATABASE_PRIVATE_URL`, `DATABASE_PUBLIC_URL`, or the full `PG*` connection set.
- Docker Compose note: `docker-compose.yml` builds the Railway-style image for `arcanos-core`, but the service definition does not set `ARCANOS_PROCESS_KIND`. If you use Compose before that config is repaired, set `ARCANOS_PROCESS_KIND=web` for the API container or use the direct `npm run build && npm start` flow above.

## References
- `../README.md`
- `CONFIGURATION.md`
- `RAILWAY_DEPLOYMENT.md`
- `../daemon-python/README.md`
