# Arcanos Codebase Index

Quick orientation for IDEs and AI/cloud agents. For full architecture see [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) and [docs/](docs/).

## Entry points

| Role | Path |
|------|------|
| TypeScript server (source of truth) | `src/start-server.ts` |
| Route registration | `src/routes/register.ts` |
| Python daemon CLI | `daemon-python/arcanos/cli.py` |
| Workers entry | `workers/src/` (memory, openai, memorySync) |

## Key directories

| Area | Path | Notes |
|------|------|--------|
| API routes | `src/routes/` | `api-ask.ts`, `api-vision.ts`, `api-transcribe.ts`, etc. |
| Services | `src/services/` | OpenAI, memory, orchestration, PR assistant, research |
| DB layer | `src/db/` | Client, schema, repositories, audit store |
| Middleware | `src/middleware/` | Validation, error handling, confirm gate, cost control |
| Python daemon | `daemon-python/arcanos/` | CLI, backend client, vision, audio, config |
| Workers | `workers/src/` | Job handlers and worker processes |
| Config | `src/config/`, `config/` | Prompts, env, fallback messages |
| Tests | `tests/` | Jest and Python tests |

## Where to find

- **API contract (server ↔ daemon):** `.cursorrules` (API routes and client methods); `scripts/sync-config.json` for sync mapping.
- **OpenAI integration:** `src/services/openai.ts`, `src/services/openai/`, `daemon-python/arcanos/gpt_client.py`.
- **Database:** `src/db/`, `prisma/schema.prisma`.
- **Coding standards and sync rules:** `AGENTS.md`, `.cursorrules`.

## IDE and cloud agents

Open **`Arcanos.code-workspace`** (in this repo root) in Cursor, VS Code, or GitHub Codespaces so the workspace root is the repo and codebase indexing targets Arcanos. See README section "IDE and cloud agents" for details.
