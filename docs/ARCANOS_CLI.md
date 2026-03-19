# Arcanos TypeScript CLI

## What it is

The Arcanos TypeScript CLI is the user-facing command-line interface in `packages/cli/`.

It is the thin protocol-first shell for the existing backend and runtime. It does not replace the backend, and it does not invent its own command contract. It converts terminal input into protocol v1 requests, sends them to the configured backend or runtime transport, and validates responses on the way back.

Primary implementation files:
- `packages/cli/src/index.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/commands/`
- `packages/cli/src/client/`

## What it does

The CLI exposes these commands:

- `arcanos ask "..."`
- `arcanos plan "..."`
- `arcanos exec`
- `arcanos status`
- `arcanos doctor implementation`

It also supports:

- deterministic `--json` output for machine consumption
- protocol passthrough mode via `arcanos protocol ...`
- backend transport selection and base URL overrides
- local runtime execution for selected commands

## How it works

Command flow:

1. Parse CLI arguments from `process.argv`
2. Build a typed invocation model
3. Convert that invocation into a protocol v1 request
4. Send the request through the CLI transport layer
5. Validate the response against protocol schemas
6. Render either human-readable output or deterministic JSON

This keeps the CLI aligned with the existing command system rather than bypassing it.

## Commands

### `ask`

Purpose:
- send a natural-language prompt through the `task.create` flow

Example:
```bash
arcanos ask "summarize the repo health"
arcanos ask "summarize the repo health" --json
```

### `plan`

Purpose:
- request a structured plan through the `plan.generate` flow

Example:
```bash
arcanos plan "add auth"
arcanos plan "add auth" --json
```

### `exec`

Purpose:
- start or inspect execution-oriented runtime flow

Example:
```bash
arcanos exec
arcanos exec "run the queued task" --json
```

### `status`

Purpose:
- report current runtime or backend status through the CLI bridge

Example:
```bash
arcanos status
arcanos status --json
```

### `doctor implementation`

Purpose:
- run implementation-oriented diagnostics using the repo-aware command path

Example:
```bash
arcanos doctor implementation
arcanos doctor implementation --json
```

## JSON mode

Every supported top-level command accepts `--json`.

Example:
```bash
arcanos plan "add auth" --json
```

Expected shape:
```json
{
  "ok": true,
  "data": {}
}
```

The exact `data` contract depends on the protocol command response schema.

## Configuration

Relevant flags:

- `--json`
- `--base-url <url>`
- `--session-id <id>`
- `--project-id <id>`
- `--environment <workspace|sandbox|host|remote>`
- `--cwd <path>`
- `--shell <name>`
- `--python-bin <path>`
- `--transport <python|local>`

Default backend URL:

- `ARCANOS_BACKEND_URL`
- fallback: `http://127.0.0.1:3000`

## Installation and entrypoint

The workspace exposes the CLI from the root package bin map:

- `arcanos`
- `arcanos-protocol`

Examples:
```bash
npm exec arcanos -- --help
npm exec arcanos -- plan "add auth" --json
```

## What it is not

The TypeScript CLI is not the optional Python daemon CLI in `daemon-python/`.

The repo currently contains two distinct CLI surfaces:

- TypeScript CLI in `packages/cli/`
- optional Python daemon/operator CLI in `daemon-python/`

They serve different roles. The TypeScript CLI is the protocol-bound monorepo CLI. The Python daemon is the local assistant/operator runtime.
