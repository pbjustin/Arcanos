# Workspace Packages

## Overview
Arcanos is an npm workspace. The root backend owns deploy/runtime startup, while shared TypeScript packages own protocol, CLI, runtime helpers, and OpenAI adapter utilities.

## Prerequisites
- Node.js 18+ and npm 8+
- Dependencies installed from the repository root with `npm install`

## Setup
Run workspace commands from the repository root unless a package-specific command uses `npm --prefix` or `npm -w`.

## Packages
| Path | Package | Purpose |
| --- | --- | --- |
| `packages/protocol/` | `@arcanos/protocol` | Public protocol command ids, JSON schemas, schema catalog, and validation helpers. |
| `packages/cli/` | `@arcanos/cli` | TypeScript CLI binaries: `arcanos` and `arcanos-protocol`. |
| `packages/arcanos-runtime/` | `@arcanos/runtime` | Shared runtime errors, abort handling, redaction, and runtime-budget helpers. |
| `packages/arcanos-openai/` | `@arcanos/openai` | Shared OpenAI client helpers, Responses utilities, retry/resilience, and response parsing. |
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
- Public protocol shape belongs in `packages/protocol/` first.
- Backend code should import shared runtime/OpenAI helpers instead of duplicating them.
- Python daemon behavior stays behind the protocol/backend boundary and should not define the public TypeScript protocol surface.
- Package export changes require rebuilding packages and updating docs that mention CLI or protocol behavior.

## References
- `../package.json`
- `../packages/protocol/package.json`
- `../packages/cli/package.json`
- `../workers/package.json`
- `../arcanos-ai-runtime/package.json`
