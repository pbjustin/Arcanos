# ARCHITECTURE_STATE

Generated at: 2026-03-07T20:16:46.123Z

- Files analyzed: 884
- Symbols analyzed: 3158
- Import edges: 3571
- Call edges: 12643

## High Fan-In Utilities

- src/lib/errors/index.ts: 106
- src/platform/logging/structuredLogging.ts: 78
- src/platform/runtime/env.ts: 69
- src/shared/http/index.ts: 53
- src/services/openai.ts: 45
- daemon-python/arcanos/config.py: 40
- daemon-python/arcanos/cli_config.py: 32
- src/platform/logging/telemetry.ts: 31
- src/services/openai/clientBridge.ts: 27
- src/platform/runtime/security.ts: 25

## High Fan-Out Abstractions

- daemon-python/arcanos/cli/cli.py: 46
- src/routes/register.ts: 40
- src/platform/index.ts: 37
- src/services/openai/chatFlow/index.ts: 34
- src/mcp/server/index.ts: 23
- src/core/logic/trinity.ts: 22
- src/transport/index.ts: 22
- src/routes/ask/index.ts: 21
- src/transport/http/middleware/memoryConsistencyGate/index.ts: 21
- src/core/logic/trinityStages.ts: 19

## Circular Dependencies

- daemon-python/arcanos/cli/__init__.py -> daemon-python/arcanos/cli/__init__.py
- daemon-python/arcanos/debug/logging.py -> daemon-python/arcanos/debug/logging.py

## Confirmed Duplicate Candidates

- 1775de5549797d0d (typescript, 2 symbols): arcanos-ai-runtime/src/http/errors.ts#sendJson, src/shared/http/errors.ts#sendJson
- 2b0be3c264f7b67c (typescript, 2 symbols): arcanos-ai-runtime/src/http/errors.ts#sendInternalErrorPayload, src/shared/http/errors.ts#sendInternalErrorPayload
- 5ff098f866b27f9e (typescript, 2 symbols): arcanos-ai-runtime/src/runtime/openaiClient.ts#resolveRequestInput, packages/arcanos-openai/src/runGPT5.ts#resolveRequestInput
- 4c54aa4fa774c3e1 (typescript, 2 symbols): arcanos-ai-runtime/src/runtime/openaiClient.ts#buildRequestPayload, packages/arcanos-openai/src/runGPT5.ts#buildRequestPayload
- 91529b01cf0c9090 (typescript, 2 symbols): arcanos-ai-runtime/src/runtime/openaiClient.ts#isAbortError, packages/arcanos-openai/src/runGPT5.ts#isAbortError
- 61dc8c5b035b1f10 (typescript, 2 symbols): packages/arcanos-openai/src/responseParsing.ts#isObject, packages/arcanos-runtime/src/redaction.ts#isObject
- 0ef29b8c2a8bb38f (typescript, 2 symbols): packages/arcanos-runtime/src/runtimeBudget.ts#getElapsedMs, src/platform/resilience/runtimeBudget.ts#getElapsedMs
- 7a7999f1dfda4823 (typescript, 2 symbols): packages/arcanos-runtime/src/runtimeBudget.ts#getRemainingMs, src/platform/resilience/runtimeBudget.ts#getRemainingMs
- 5e3366520428e3e0 (typescript, 2 symbols): packages/arcanos-runtime/src/runtimeBudget.ts#hasSufficientBudget, src/platform/resilience/runtimeBudget.ts#hasSufficientBudget
- f6491d97564148c2 (typescript, 2 symbols): src/core/adapters/openai.adapter.ts#normalizeMessageContent, src/services/openai/requestBuilders/normalize.ts#normalizeMessageContent
