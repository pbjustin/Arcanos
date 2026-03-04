# OpenAI Responses + Tools (Arcanos)

> Updated: 2026-03-03

This repo uses the **OpenAI Responses API** as the primary integration surface for:
- text generation
- tool calling (function tools)
- tool output continuation (`previous_response_id`)
- streaming (where applicable)

## Key modules
- Call pipeline: `src/services/openai/chatFlow/`  
  Stages: `prepare → execute → parse → trace`
- Request builders: `src/services/openai/requestBuilders/`  
  Stages: `build → normalize → convert → validate`
- Shared output parsing: `packages/arcanos-openai/src/responseParsing.ts`
- Daemon tools + continuation loop: `src/routes/ask/daemonTools.ts`

## Developer instructions
System-level guidance is injected into Responses input as a **developer** message during normalization.

Where:
- `src/services/openai/requestBuilders/normalize.ts`

Why:
- Modern OpenAI guidance prefers **developer** messages for instruction hierarchy in Responses-based flows.

## Tool calling + continuation loop
Arcanos supports a tool-call loop:

1) The model returns `function_call` output items.
2) The backend executes or queues the tool work.
3) The backend sends `function_call_output` items containing JSON output and the matching `call_id`.
4) The backend calls `responses.create` again with:
   - `previous_response_id` from the prior response
   - new `input` containing the outputs

Where:
- `src/routes/ask/daemonTools.ts`

Safety model behavior:
- `run_command` remains **confirmation-gated** (never executes immediately).
- `capture_screen` is queued to the daemon; results can be awaited and fed back into the continuation loop.

### Waiting for daemon results
If the daemon reports results quickly, Arcanos can continue the model response in the same request flow.

- Env knobs (backend):
  - `DAEMON_RESULT_WAIT_MS` (default: 8000)
  - `DAEMON_RESULT_POLL_MS` (default: 250)

Daemon result reporting endpoint:
- `POST /api/daemon/commands/result` (see `docs/API.md`)

## Data retention (`store`)
Responses requests default to **stateless**:
- `store: false`

To enable OpenAI-side storage:
- `OPENAI_STORE=true`

The flag is read from:
- `src/config/openaiStore.ts`

## Tracing + retries
- A stable request identifier is propagated into OpenAI request headers:
  - `Request-Id`
  - `Idempotency-Key`
- Retry policy is controlled in the app layer (avoid stacked SDK+app retries).

Where:
- `src/services/openai/chatFlow/execute.ts`
