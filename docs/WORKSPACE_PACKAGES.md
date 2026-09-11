# Workspace Packages

## Overview
Arcanos is an npm workspace. The root backend owns deploy/runtime startup, while shared TypeScript packages own protocol, CLI, runtime helpers, and OpenAI adapter utilities.

## Prerequisites
- Exact Node.js 24.18.1 with its bundled npm 11.16.0.
- Dependencies installed from the repository root with `npm install`

## Setup
Run workspace commands from the repository root unless a package-specific command uses `npm --prefix` or `npm -w`.

## Packages
| Path | Package | Purpose |
| --- | --- | --- |
| `packages/protocol/` | `@arcanos/protocol` | Public protocol command ids, JSON schemas, schema catalog, validation helpers, and separate registered module-action contract families. |
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

`arcanos-ai-runtime/` is standalone and can be tested independently through its
package scripts. Its package test builds this runtime and exercises the
fail-closed `/jobs` HTTP boundary against an injected queue; it does not require
Redis, OpenAI, or a live listener outside loopback. Runtime callers must
configure the purpose-bound Bearer token, stable server-owned principal, and
explicit `runtime:enqueue`/`runtime:read` scopes documented in
`CONFIGURATION.md`. The separately guarded `test:redis-integration` suite
exercises admission concurrency and BullMQ lifecycle fencing only against an
explicitly confirmed disposable loopback Redis database; the required CI job
provides that service. Never point this suite at shared, developer, staging, or
production Redis.

For a separately authorized standalone run, provide the documented
[runtime configuration](CONFIGURATION.md#standalone-bullmqredis-ai-runtime)
in each process environment; these entry points do not load the root `.env`.
Use already-installed dependencies and build from the repository root:

```bash
npm run build:packages
npm --prefix arcanos-ai-runtime run build
```

Then run each command in a separate terminal from the repository root:

```bash
node arcanos-ai-runtime/dist/server.js
```

```bash
node arcanos-ai-runtime/dist/worker.js
```

The first starts the standalone HTTP queue API; the second starts its BullMQ
consumer. They access the configured Redis service, and the worker can call
the configured provider when processing jobs. Select those targets explicitly;
these commands are operational startup, not offline validation. The package
has no `start` script; its `main: index.js` field is not a runtime entry point.
See the [standalone API](API.md#standalone-arcanos-ai-runtime-api) for readiness,
authentication, job acceptance, and result boundaries.

### Separate `workers/` workspace

The `arcanos-workers` package has its own in-process `TypedWorkerQueue`
(`workers/src/queue/index.ts`). It dispatches registered EventEmitter listeners
sequentially, with up to three attempts per listener by default and retry
delays of 500 ms, then 1000 ms. This is separate from the canonical PostgreSQL
consumer in `src/workers/jobRunner.ts` and the BullMQ runtime above; it does
not implement a broker consumer, durable queue, or cross-process memory store.

With dependencies installed and shared packages built, build this package from
the repository root:

```bash
npm run build:workers --workspace=arcanos-workers
```

Its manifest provides three manual entry points. These are configured-runtime
operations; provider jobs can make external calls.

| Command from repository root | Registered jobs |
| --- | --- |
| `npm run start:openai --workspace=arcanos-workers` | `OPENAI_COMPLETION`, `OPENAI_EMBEDDING` |
| `npm run start:memory --workspace=arcanos-workers` | `MEMORY_SET`, `MEMORY_GET` |
| `npm run start:memorySync --workspace=arcanos-workers` | `MEMORY_SYNC` |

Each entry point parses one `WORKER_JOB` plus JSON `WORKER_PAYLOAD` from its
process environment and attempts one dispatch when both parse to a known job
and non-null payload. It also resumes stdin.
Stdin is not a job transport, and these commands do not poll the backend queue.
The parser checks the shared job-name allowlist and JSON syntax, not the
per-job payload shape in `workers/src/jobs/index.ts`. Choose a job registered
by the selected entry point; another allowed job has no listener and returns
an empty result array. Treat payloads and printed results as potentially
sensitive data, keep credentials out of payloads and shell history, and do not
treat log redaction as approval to print private content.

`workers/src/infrastructure/sdk/openaiConfig.ts:resolveWorkerOpenAIConfig`
selects chat models by `WORKER_OPENAI_MODEL`, then `OPENAI_MODEL`, then
`gpt-4.1-mini`; embeddings use `EMBEDDING_MODEL` or `text-embedding-3-large`.
Completion/embedding payloads can override the model. Key aliases are
`OPENAI_API_KEY`, `RAILWAY_OPENAI_API_KEY`, `API_KEY`, then `OPENAI_KEY`;
`WORKER_API_TIMEOUT_MS` defaults to 60000. Supply these values in the process
environment; the package does not load `.env`. Provider retries also occur in
the shared adapter/SDK path, so three queue attempts is not a three-provider-call
limit. The parsed `OPENAI_MAX_RETRIES` value is not forwarded by this adapter;
changing that setting does not establish a retry limit here.

`MEMORY_SET`/`MEMORY_GET` use one process-local map. `MEMORY_SYNC` uses a
different map in `workers/src/infrastructure/memory/index.ts` and can optionally
request an embedding when `embed` is true. Despite the handler's persistence
comment, neither map writes a database or file; restarting loses its contents.
The exported rollback deletes keys from that map and is not automatically
invoked by the queue.

Top-level modules such as `worker-gpt5-reasoning.ts`, `worker-planner-engine.ts`,
and `worker-memory.ts` instead expose context-based work and schedule metadata.
The reasoning pulse calls the supplied `context.ai.query`; its GPT-5.1 label
does not choose a model. The planner counts pending database jobs, while the
memory module counts entries rather than synchronizing them. A build or a
schedule field does not prove activation: the separate loader in
`src/platform/runtime/workerBoot.ts` and its invocation/export expectations
must be checked before claiming any module is scheduled.

## Deploy (Railway)
Railway builds from the root package and uses `scripts/start-railway-service-with-integrity.mjs`, which validates configured runtime-owned protected digests before invoking the role launcher. Workspace package changes must be built into `dist/` before deploy.

## Troubleshooting
- Package import fails after a change: run `npm run build:packages` and then `npm run build`.
- CLI binary missing: rebuild `@arcanos/cli` through `npm run build:packages`.
- Runtime package export missing: update the package `exports` map and rebuild before changing consumers.

## Ownership Rules

### Protocol and CLI

- Public protocol commands, envelopes, and schema-catalog entries belong in `packages/protocol/` first.
- Backstage Booker's ten request/response pairs are exported by
  `@arcanos/protocol` as a registered module-action family. Consumers should
  use the exported action types, `DEFAULT_BACKSTAGE_UNIVERSE_ID`, schema
  catalog, and dedicated validation/assertion helpers rather than reproducing
  request or persistence shapes in backend code. These action names do not
  extend either public protocol command-ID list.
  For `queryContinuity`, the exported `BackstageContinuityScopeKind` and related
  request/response types preserve exact-page scope when `scopeKind` is omitted
  or `"page"`; explicit `"subtree"` excludes `sectionPath` and couples
  `resolvedScope.scopeKind` to subtree-only page coverage.
  The Phase 2A exports include typed storyline/beat models, storyline status,
  mutation UUID and decimal revision aliases, and the durable-or-unknown
  `upsertStoryline` / `appendCanonBeat` request and response unions. Unlike the
  original actions, both canon requests require an explicit `universeId`.
  `isValidBackstageCanonUtcTimestamp` and its exported pattern source keep the
  portable JSON schema and backend normalization aligned on real UTC calendar
  dates from year 0001 through 9999 and one to nine optional fractional digits.
- `packages/cli/` owns the TypeScript `arcanos` / `arcanos-protocol` binaries and transports. Its behavior is documented in `CLI_OVERVIEW.md`.
- `daemon-python/` owns the interactive Python local agent. It also installs an `arcanos` executable, so use `arcanos-protocol` or `node packages/cli/dist/index.js` when the TypeScript executable must be unambiguous, and `python -m arcanos.cli` for the Python executable.
- Python consumes the TypeScript-owned protocol behind the backend/protocol boundary and must not define a competing public shape.

### Runtime helpers

- `@arcanos/runtime` is canonical for runtime budgets, structured runtime errors, abort helpers, and redaction.
- Its redactor preserves ordinary object shape while projecting
  credential-shaped and prototype-sensitive property names to collision-safe
  opaque markers before recursively sanitizing values.
- `src/platform/resilience/runtimeBudget.ts` and `src/platform/resilience/runtimeErrors.ts` are backend compatibility facades that re-export package APIs. Do not add a second implementation there.
- `arcanos-ai-runtime/src/runtime/runtimeBudget.ts` and `runtimeErrors.ts` are likewise compatibility facades over the workspace package.
- New consumers should use package exports such as `@arcanos/runtime`, `@arcanos/runtime/requestAbort`, `@arcanos/runtime/runtimeBudget`, `@arcanos/runtime/runtimeErrors`, and `@arcanos/runtime/redaction`.

### OpenAI integration

- `@arcanos/openai` owns portable client construction, retry/backoff utilities, resilience defaults, Responses helpers, structured-reasoning helpers, and response parsing.
- `@arcanos/openai/responses` owns the cross-runtime Responses lifecycle,
  refusal, usage, and legacy function/custom-tool projection contract. Backend
  and worker adapters keep only their surface-specific IDs, timestamps, models,
  envelopes, telemetry, and orchestration.
- Its structured JSON helpers require an explicit completed lifecycle before
  parsing, reject incomplete partial JSON, and surface terminal, pending,
  unknown, or missing status without accepting provider output as success.
- `@arcanos/openai/structuredReasoning` accepts optional `reasoningEffort`, a
  positive-integer `maxOutputTokens`, and a best-effort `onUsage` observer while
  preserving its parsed-value return type. Usage is reported before parsing so
  billed incomplete, refusal, malformed, and validation-failure responses remain
  observable; observer failures do not replace the provider or parser outcome.
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
