# Schema and Protocol Guide

## Overview
Arcanos is schema-first at its public protocol boundary. TypeScript owns the public protocol surface in `packages/protocol/`; Python daemon code consumes that surface through the protocol runtime and backend clients.

## Prerequisites
- Read `AGENTS.md` for protocol-first repository rules.
- Build packages before backend validation when protocol schemas or exports change.

## Setup
Install dependencies from the repository root:
```bash
npm install
```

## Source of Truth
| Area | Source |
| --- | --- |
| Protocol command ids | `packages/protocol/src/commands.ts` |
| JSON schema catalog | `packages/protocol/src/schemaCatalog.ts` |
| Command schemas | `packages/protocol/schemas/v1/commands/*.schema.json` |
| Shared noun schemas | `packages/protocol/schemas/v1/nouns/*.schema.json` |
| Tool schemas | `packages/protocol/schemas/v1/tools/*.schema.json` |
| ActionPlan execution schemas | `packages/protocol/schemas/v1/action-plan/` |
| ActionPlan shared TypeScript types | `src/shared/types/actionPlanExecution.ts` |
| ActionPlan OpenAPI contract | `contracts/action_plan_execution.openapi.v1.json` |
| ActionPlan Python consumer constants | `daemon-python/arcanos/action_plan_execution_protocol.py` |
| Backend/CLI OpenAPI contracts | `contracts/*.openapi.v1.json` and `contracts/backend_cli_contract.v1.json` |
| Custom GPT bridge OpenAPI | `openapi/custom-gpt-bridge.yaml` |

Protocol v1 distinguishes protocol-visible command ids from implemented command ids. `ARCANOS_PROTOCOL_COMMAND_IDS` includes forward-compatible reserved commands so clients can reason about future surfaces. `ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS` is the supported set with concrete schemas and dispatcher behavior in this checkout.

ActionPlan execution is a separate contract family. Keep its schemas, shared TypeScript types, OpenAPI contract, Python constants, and focused contract tests synchronized; do not register these schemas in `packages/protocol/src/schemaCatalog.ts`.

Implemented protocol commands:
- `task.create`
- `plan.generate`
- `artifact.store`
- `control-plane.invoke`
- `context.inspect`
- `daemon.capabilities`
- `tool.registry`
- `tool.describe`
- `tool.invoke`
- `exec.start`
- `exec.resume`
- `exec.status`
- `state.snapshot`

Reserved but not implemented in the current protocol runtime:
- `patch.create`
- `patch.apply`
- `run.start`
- `event.stream`
- `artifact.fetch`

## Change Workflow
1. Add or update the JSON schema first.
2. Register new implemented command schemas in `packages/protocol/src/schemaCatalog.ts`.
3. Add or update command ids in `packages/protocol/src/commands.ts` only when the supported or reserved command set changes.
4. Update TypeScript callers in `packages/cli/`, `src/`, or `workers/`.
5. Update Python daemon consumers only after the protocol shape is stable.
6. Document route, CLI, or env changes in the matching doc:
   - API routes: `docs/API.md`
   - CLI commands: `docs/CLI_OVERVIEW.md`
   - daemon behavior: `daemon-python/README.md`
   - env variables: `.env.example` and `docs/CONFIGURATION.md`

## Validation
```bash
npm run build:packages
npm run type-check
npm run lint
node scripts/run-jest.mjs --testPathPatterns=protocol --coverage=false
npm run validate:backend-cli:contract
npm run validate:backend-cli:offline
npm run sync:check
```

Use focused Jest patterns for changed areas. For Python protocol-runtime work, run the relevant daemon tests after installing daemon dev dependencies:
```bash
cd daemon-python
python -m pip install -e ".[dev]"
pytest tests/ -q
```

## Configuration
Protocol changes do not require runtime environment variables by default. If a schema change introduces an env-dependent behavior, update `.env.example` and `docs/CONFIGURATION.md` in the same change.

## Run locally
After changing protocol or CLI schemas:
```bash
npm run build:packages
npm run build
```

Use `arcanos protocol <command> --payload-json '{}' --transport local` for local protocol-dispatch checks when the command supports local transport.

## Deploy (Railway)
Railway builds packages through the root build. Validate schema changes locally before deploy because protocol drift can break CLI, daemon, and backend consumers at the same time.

## Troubleshooting
- Python runtime rejects a command: confirm the command has request/response schemas and is supported by the Python protocol runtime.
- TypeScript import fails: confirm `packages/protocol/src/schemaCatalog.ts` and package exports are updated, then rebuild packages.
- A command is listed but returns unsupported: check whether it is in `ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS`, not only `ARCANOS_PROTOCOL_COMMAND_IDS`.

## Compatibility Rules
- Keep command outputs deterministic JSON.
- Do not route system operations through writing-plane GPT prompts.
- Prefer direct control endpoints or `/gpt-access/*` for job-result and runtime inspection. `/gpt/:gptId` is the writing plane and rejects job lookup, runtime inspection, worker status, queue inspection, MCP calls, and other control actions.
- Do not expose raw shell execution, raw SQL, arbitrary proxying, or destructive self-heal operations through GPT access routes.
- If a command is listed but not implemented, document it as reserved rather than presenting it as supported.

## References
- `../packages/protocol/src/commands.ts`
- `../packages/protocol/src/schemaCatalog.ts`
- `../packages/protocol/schemas/v1/`
- `../contracts/`
- `CLI_OVERVIEW.md`
- `../daemon-python/README.md`
