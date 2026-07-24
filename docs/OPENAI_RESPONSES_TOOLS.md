# OpenAI Responses and Tools

> Updated: 2026-07-23

Arcanos uses the OpenAI Responses API as its primary backend integration surface for text generation, function tools, tool-output continuation, and supported streaming paths.

## Current ownership

| Area | Owner |
| --- | --- |
| Backend call pipeline | `src/services/openai/chatFlow/` (`prepare -> execute -> parse -> trace`) |
| Backend request staging | `src/services/openai/requestBuilders/` (`build -> normalize -> convert -> validate`) |
| Backend-specific adapter and SDK configuration | `src/core/adapters/openai.adapter.ts` |
| Portable client/retry/Responses/parsing helpers | `packages/arcanos-openai/` (`@arcanos/openai`) |
| Shared tool-continuation request construction | `src/routes/ask/toolLoop.ts` |
| General backend tool runtime | `src/routes/ask/toolRuntime.ts` |
| Daemon-specific tool definitions, queueing, and result polling | `src/routes/ask/daemonTools.ts` |

The workspace package provides portable helpers; it does not replace backend-specific telemetry, circuit-breaker, credential, or route orchestration. See `WORKSPACE_PACKAGES.md` for cross-runtime ownership.

## Developer instructions

System-level application guidance is normalized into a Responses `developer` message in:

- `src/services/openai/requestBuilders/normalize.ts`

Keep instruction hierarchy changes in the request-building layer rather than patching individual call sites.

## Tool calling and continuation

The common tool loop is:

1. The model returns `function_call` output items.
2. Arcanos validates and executes, queues, or rejects each tool operation.
3. Arcanos creates matching `function_call_output` items with JSON output and the original `call_id`.
4. Arcanos creates the next Responses request.

Continuation has two storage modes:

- When `OPENAI_STORE=true` and the prior response has a non-empty ID, the next request uses `previous_response_id` plus the new function outputs.
- When storage is disabled (the default), Arcanos does not reference a remote prior response. It replays the accumulated local response/tool transcript as the next `input` and sends `store: false`.

This branch is implemented in `src/routes/ask/toolLoop.ts`. Callers in both `daemonTools.ts` and `toolRuntime.ts` retain the returned local transcript between loop iterations.

### Daemon tool behavior

- `run_command` remains confirmation-gated; the backend does not immediately execute a proposed local command.
- `capture_screen` is queued for the daemon.
- If the daemon reports a result within the configured wait window, the backend can feed it into the same tool loop.

Backend wait controls:

- `DAEMON_RESULT_WAIT_MS` (default `8000`)
- `DAEMON_RESULT_POLL_MS` (default `250`)

Daemon result endpoint:

- `POST /api/daemon/commands/result` (see `API.md`)

## Data retention

Responses requests default to:

```text
store: false
```

Set `OPENAI_STORE=true` to enable OpenAI-side response storage and stateful `previous_response_id` continuation. The flag is read in `src/config/openaiStore.ts`.

Do not assume a response ID is remotely reusable when storage is disabled.

## Tracing and retry ownership

The backend chat flow propagates a stable request identifier through:

- `Request-Id`
- `Idempotency-Key`

Retry behavior has more than one layer:

- `src/core/adapters/openai.adapter.ts` can configure OpenAI SDK `maxRetries`.
- `src/services/openai/chatFlow/execute.ts` wraps calls with the application retry policy.
- worker and standalone runtime consumers use shared retry helpers from `@arcanos/openai`.

When changing attempt counts or adding a caller, account for both SDK and application layers so the total retry budget remains intentional. Backend retry, telemetry, and circuit-breaker policy remain backend-owned; portable retry helpers remain package-owned.

## Validation guidance

Use mocked OpenAI credentials and repository test commands for routine validation. Do not make live OpenAI calls merely to verify documentation or adapter wiring.

Relevant checks for backend/shared-package changes:

```bash
npm run type-check
npm run lint
node scripts/run-jest.mjs --testPathPatterns=<openai-or-route-pattern> --coverage=false
```

Expand to `npm run build` when package exports or cross-workspace consumers change.
