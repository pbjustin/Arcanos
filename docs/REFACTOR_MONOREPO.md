# Monorepo refactor (workspaces + shared packages)

This repository now uses **npm workspaces** to manage the Node sub-projects:

- `packages/arcanos-runtime` → shared runtime budget/errors primitives
- `packages/arcanos-openai` → shared OpenAI helpers (budget-aware wrappers)
- `workers/` → worker processes
- `arcanos-ai-runtime/` → AI runtime service

## Workspaces

Root `package.json` contains:

- `"workspaces": ["packages/*", "workers", "arcanos-ai-runtime"]`

Install dependencies from the repo root.

## Shared packages

### `@arcanos/runtime`
- `runtimeBudget`
- `runtimeErrors`

### `@arcanos/openai`
- `runGPT5(client, request, budget)`
- `runStructuredReasoning(client, { model, prompt, budget, schema, validate })`

## Legacy modules

`cli/`, `cli_v2/`, and `agent_core/` have been moved to `legacy/` and are treated as read-only.
ESLint enforces a **no-import** rule from production code into legacy folders.

## Route refactor

`src/routes/ask.ts` was slimmed down by extracting pure helper functions into `src/routes/ask/helpers.ts`.
