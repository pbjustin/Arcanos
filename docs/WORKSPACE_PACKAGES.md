# Workspace Packages

## Overview
Arcanos is an npm workspace. The root backend owns deploy/runtime startup, while shared TypeScript packages own protocol, CLI, runtime helpers, and OpenAI adapter utilities.

## Prerequisites
- Node.js 20.19.0 recommended; current dependencies require Node 20.18.1+ despite the older root `engines` floor. npm 8+.
- Dependencies installed from the repository root with `npm install`

## Setup
Run workspace commands from the repository root unless a package-specific command uses `npm --prefix` or `npm -w`.

## Packages
| Path | Package | Purpose |
| --- | --- | --- |
| `packages/protocol/` | `@arcanos/protocol` | Public protocol command ids, JSON schemas, schema catalog, and validation helpers. |
| `packages/cli/` | `@arcanos/cli` | TypeScript CLI binaries: `arcanos` and `arcanos-protocol`. |
| `packages/arcanos-runtime/` | `@arcanos/runtime` | Canonical shared runtime errors, abort handling, redaction, and runtime-budget helpers. |
| `packages/arcanos-openai/` | `@arcanos/openai` | Portable OpenAI client construction, Responses utilities, retry/resilience helpers, structured reasoning, and response parsing. |
| `workers/` | `arcanos-workers` | Separately built TypeScript worker package under `workers/src/`. |
| `arcanos-ai-runtime/` | `arcanos-ai-runtime` | Standalone BullMQ/Redis AI runtime with its own `build`, `test`, and `test:integration` scripts. |

## Build Order
Root scripts build shared packages before backend validation:
```bash
npm run build:packages
npm run build
```

`npm run build:packages` runs the package builds in this order:
1. `@arcanos/protocol`
2. `@arcanos/cli`
3. `@arcanos/runtime`
4. `@arcanos/openai`

The full root `npm run build` also builds `workers/`, compiles `src/`, repairs/checks dist aliases, and copies runtime assets.

## Local Validation
```bash
npm run build:packages
npm run type-check
npm run lint
node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false
npm run test:unit
```

Use `npm --prefix arcanos-ai-runtime run test:integration` through the root shortcut:
```bash
npm run test:runtime-integration
```

## Configuration
Workspace package resolution is controlled by root `package.json` `workspaces` and file dependencies between packages. Do not publish these private packages without revisiting package metadata and exports.

## Run locally
The root backend is the normal local runtime:
```bash
npm run build
npm start
```

`arcanos-ai-runtime/` is standalone and can be tested independently through its package scripts.

## Deploy (Railway)
Railway builds from the root package and uses `scripts/start-railway-service.mjs`. Workspace package changes must be built into `dist/` before deploy.

## Troubleshooting
- Package import fails after a change: run `npm run build:packages` and then `npm run build`.
- CLI binary missing: rebuild `@arcanos/cli` through `npm run build:packages`.
- Runtime package export missing: update the package `exports` map and rebuild before changing consumers.

## Ownership Rules

### Protocol and CLI

- Public protocol commands, envelopes, and schema-catalog entries belong in `packages/protocol/` first.
- `packages/cli/` owns the TypeScript `arcanos` / `arcanos-protocol` binaries and transports. Its behavior is documented in `CLI_OVERVIEW.md`.
- `daemon-python/` owns the interactive Python local agent. It also installs an `arcanos` executable, so use `arcanos-protocol` or `node packages/cli/dist/index.js` when the TypeScript executable must be unambiguous, and `python -m arcanos.cli` for the Python executable.
- Python consumes the TypeScript-owned protocol behind the backend/protocol boundary and must not define a competing public shape.

### Runtime helpers

- `@arcanos/runtime` is canonical for runtime budgets, structured runtime errors, abort helpers, and redaction.
- `src/platform/resilience/runtimeBudget.ts` and `src/platform/resilience/runtimeErrors.ts` are backend compatibility facades that re-export package APIs. Do not add a second implementation there.
- `arcanos-ai-runtime/src/runtime/runtimeBudget.ts` and `runtimeErrors.ts` are likewise compatibility facades over the workspace package.
- New consumers should use package exports such as `@arcanos/runtime`, `@arcanos/runtime/runtimeBudget`, `@arcanos/runtime/runtimeErrors`, and `@arcanos/runtime/redaction`.

### OpenAI integration

- `@arcanos/openai` owns portable client construction, retry/backoff utilities, resilience defaults, Responses helpers, structured-reasoning helpers, and response parsing.
- The backend keeps server-specific adapter configuration, credential resolution, telemetry, circuit-breaker integration, request staging, and chat-flow orchestration in `src/core/adapters/openai.adapter.ts` and `src/services/openai/`.
- `workers/` and `arcanos-ai-runtime/` import shared client/retry helpers rather than maintaining separate copies.
- Retry is not globally app-only: the backend adapter can configure SDK retries, while backend chat flow and other runtimes may also apply an application retry helper. Changes must account for the combined attempt budget.
- Current Responses/tool-loop behavior is documented in `OPENAI_RESPONSES_TOOLS.md`.

### Legacy code

- `legacy/cli/`, `legacy/cli_v2/`, and `legacy/agent_core/` are read-only historical zones.
- Production code must not import from `legacy/`; ESLint and boundary checks enforce the supported layer boundaries.
- Current CLI work belongs in `packages/cli/` or `daemon-python/arcanos/`, not the legacy directories.

### Export and documentation changes

- Respect package export maps rather than deep-importing package source.
- Package export changes require matching export-map and consumer updates, a package rebuild, and updates to this document.
- Do not edit generated `dist/` output as source.

## References
- `../package.json`
- `../packages/protocol/package.json`
- `../packages/cli/package.json`
- `../packages/arcanos-runtime/package.json`
- `../packages/arcanos-openai/package.json`
- `../workers/package.json`
- `../arcanos-ai-runtime/package.json`
- `CLI_OVERVIEW.md`
- `OPENAI_RESPONSES_TOOLS.md`
- `../daemon-python/README.md`
