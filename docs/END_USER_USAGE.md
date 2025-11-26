# Arcanos Backend – End User Usage Guide

This guide explains how to run the Arcanos backend locally and how to call its most common endpoints as an end user. It focuses on the HTTP interface and the minimal headers you need to send to get real responses from the AI pipeline.

## What the backend does for end users

The Arcanos backend powers several AI-first experiences shipped as separate frontends:

- **Arcanos Gaming Tutor** – a conversational coach that answers gameplay questions and generates tailored drills by hitting `/ask`, `/write`, and RAG routes for topical tips.
- **BackstageBooker** – a WWE/AEW booking engine that hits `/backstage/book-event`, `/backstage/book-gpt`, `/backstage/simulate-match`, `/backstage/update-roster`, and `/backstage/track-storyline` to manage events, simulate matches, and persist rosters and storylines.

All of these products share the same core: the Trinity pipeline for reasoning, content generation, and safety checks; memory storage for user context; and worker automation for background jobs. Any frontend that can send HTTP requests can reuse these capabilities without change.

## Adapting the backend to your product

You can re-skin the backend for a different surface—web app, CLI, chatbot—by changing inputs, prompts, or persistence without touching the core runtime.

- **Tune prompts and behaviors:** Adjust the prompt templates and role hints in `src/commands` (e.g., `write.ts`, `guide.ts`, `sim.ts`) to align with your domain voice. Use feature flags or custom request headers to switch personas per tenant.
- **Extend or rename routes:** Add new Express handlers in `src/routes/register.ts` and corresponding controller files to expose bespoke flows (e.g., `/bookings/create`, `/support/escalate`). Reuse existing confirmation middleware to keep safeguards consistent.
- **Swap storage options:** Point `DATABASE_URL` to your own Postgres instance or implement alternative adapters in the memory service if you need organization-scoped data or stricter retention.
- **Automate background tasks:** Add or modify worker scripts in `workers/` to schedule cleanups, enrichment jobs, or alerts. You can trigger them from your frontend via `/workers/run/:name` once you gate them with `x-confirmed` or a trusted GPT ID.
- **Embed in your auth model:** Wrap calls behind your authentication proxy and inject user or tenant identifiers as headers. The backend is header-driven, so you can propagate identity (`x-user-id`, `x-tenant`) into prompts or storage keys without modifying every route.

Because the API surface is HTTP and schema-light, you can start by calling `/ask` or `/brain` from your UI, then incrementally wire deeper features—memory, research, workers—based on what your product needs.

## Prerequisites

- Node.js 20+ and npm.
- An OpenAI API key (`OPENAI_API_KEY`). The server can return mocked replies without it, but real completions require the key.
- Optional: PostgreSQL if you want persistent storage instead of the built-in filesystem fallbacks.

## Start the server

1. Install dependencies and copy the example environment file:
   ```bash
   npm install
   cp .env.example .env
   ```
2. Edit `.env` to set `OPENAI_API_KEY` and any other variables you need (e.g., `PORT`, `HOST`, `DATABASE_URL`).
3. Build and start the service:
   ```bash
   npm run build
   npm start
   ```

The server binds to `http://localhost:8080` by default. Health probes are available at `/health`, `/healthz`, and `/readyz` to verify the process is ready before you issue other calls.

## Confirmation and identity headers

Most routes are confirmation-gated to prevent accidental actions. You can satisfy the gate in two ways:

- **Manual runs:** send `x-confirmed: yes` on the first request.
- **Automation runs:** first call the endpoint without `x-confirmed`; it will return a pending challenge token. Retry the same request with `x-confirmed: token:<challengeId>`.

If you are routing through a trusted GPT model, you can skip the confirmation header by providing its ID via `x-gpt-id: <model-id>`. If you cannot expose a GPT ID, configure `ARCANOS_AUTOMATION_SECRET` and send it with `x-arcanos-automation: <secret>` (or your custom header) to self-approve automated calls.

## Common request patterns

### Conversational chat

Primary chat endpoint with no confirmation requirement:

```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Summarize the deployment steps"}'
```

To use the confirmation-gated alias, send the same body to `/brain` with `-H "x-confirmed: yes"`.

### AI utilities (write, guide, audit, sim)

These endpoints require confirmation. Example for `/write`:

```bash
curl -X POST http://localhost:8080/write \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"prompt":"Draft a changelog entry for the latest release"}'
```

### Image generation

```bash
curl -X POST http://localhost:8080/image \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"prompt":"Futuristic city skyline at dusk","size":"1024x1024"}'
```

### Memory service

Store, read, and list values (confirmation required for mutations):

```bash
# Save a value
curl -X POST http://localhost:8080/api/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key":"release-notes","value":"v1.0 shipped"}'

# Load a value
curl "http://localhost:8080/api/memory/load?key=release-notes"

# List recent values
curl http://localhost:8080/api/memory/list
```

### Research and RAG

Use the curated research pipeline or the SDK bridge to fetch, summarize, and persist topic briefs:

```bash
curl -X POST http://localhost:8080/commands/research \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"topic":"Hallucination resistant prompting","urls":["https://example.com/article"]}'

curl -X POST http://localhost:8080/sdk/research \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"topic":"Knowledge management for AI teams"}'
```

### Workers and automation

Inspect worker status or trigger a run (confirmation required). When you provide a trusted GPT ID or automation secret, the service can auto-approve heals:

```bash
# List workers and their runtime config
curl http://localhost:8080/workers/status

# Run a worker by filename (e.g., healthcheck.js)
curl -X POST http://localhost:8080/workers/run/healthcheck \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{}'

# Trigger the self-healing workflow
curl -X POST http://localhost:8080/workers/heal \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"mode":"plan"}'
```

### Status and diagnostics

- `GET /status` – Read the current system state.
- `POST /status` – Update the state (requires confirmation).
- `GET /api/memory/health` – Memory service diagnostics.
- `GET /health`, `/healthz`, `/readyz` – Health and readiness probes.

## Tips for production usage

- Set `PORT`, `HOST`, and `SERVER_URL` explicitly when deploying behind proxies or in containerized environments.
- Configure `TRUSTED_GPT_IDS` or `ARCANOS_AUTOMATION_SECRET` so automated repairs and deploys can run without human headers.
- Keep `logs/` and `memory/` directories writable so the service can persist audit data, heartbeats, and research summaries.
- Use `RUN_WORKERS=false` if you want to disable worker startup during constrained deployments or CI runs.

## Where to look next

- Route definitions: [`src/routes/register.ts`](../src/routes/register.ts) lists every endpoint mounted by the server.
- Configuration details: [`docs/CONFIGURATION.md`](CONFIGURATION.md) enumerates all environment variables and defaults.
- Trinity and orchestration internals: [`docs/TRINITY_PIPELINE.md`](TRINITY_PIPELINE.md) explains the shared AI pipeline and safeguards.
