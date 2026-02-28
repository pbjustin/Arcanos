# OpenAI Adapter Migration Guide

## Scope
This guide documents migration to unified OpenAI construction and adapter-first runtime usage across:
- TypeScript backend/runtime (`src/`)
- TypeScript workers (`workers/`)
- Python daemon CLI (`daemon-python/`)

## Locked Architecture
- TypeScript canonical adapter: `src/core/adapters/openai.adapter.ts`
- Worker canonical adapter: `workers/src/infrastructure/sdk/openai.ts`
- Python canonical client singleton: `daemon-python/arcanos/openai/unified_client.py`
- Python canonical adapter: `daemon-python/arcanos/openai/openai_adapter.py`

Runtime env boundaries:
- TypeScript: `src/config/env.ts`
- Python: `daemon-python/arcanos/env.py`

## TypeScript Migration Map
Old pattern:
```ts
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const response = await client.responses.create({ ... });
```

New pattern:
```ts
import { createOpenAIAdapter } from "../core/adapters/openai.adapter.js";

const adapter = createOpenAIAdapter({
  apiKey: "...",
  baseURL: "...",
  timeout: 60000,
  maxRetries: 2,
});

const response = await adapter.responses.create(
  {
    model: "gpt-4.1-mini",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  },
  { signal, headers }
);
```

Image generation:
```ts
await adapter.images.generate(
  { model: "gpt-image-1", prompt: "..." },
  { signal, headers },
);
```

Escape hatch:
- Use `getClient()` from `src/core/adapters/openai.adapter.ts` only when adapter surface does not yet cover a required Beta/Assistants API.

## Worker Migration Map
Old pattern:
- Handler or worker entrypoint read `process.env` directly and instantiated local OpenAI client.

New pattern:
- Resolve worker config/job contract in `workers/src/infrastructure/sdk/openaiConfig.ts`
- Use singleton adapter from `workers/src/infrastructure/sdk/openai.ts`
- Keep direct env reads out of handlers and worker entrypoints (except centralized contract/config module)

## Python Daemon Migration Map
Old pattern:
```python
client = get_or_create_client(Config)
resp = client.responses.create(...)
```

New pattern:
```python
from arcanos.openai.openai_adapter import (
    chat_completion,
    chat_stream,
    vision_completion,
    transcribe,
    embeddings,
)

resp = chat_completion(user_message="hello")
```

Method mapping:
- chat non-stream: `chat_completion(...)`
- chat stream: `chat_stream(...)`
- vision: `vision_completion(...)`
- transcription: `transcribe(...)`
- embeddings: `embeddings(...)`

Compatibility note:
- Unified client now resolves from `Config` only (legacy env shims removed).

## CI and Validation Expectations
Authoritative required workflow:
- `.github/workflows/ci-cd.yml`

Required checks are mock-only for OpenAI:
- `OPENAI_API_KEY=mock-api-key`
- No required job depends on live OpenAI network calls

Required verification commands:
```bash
npm run build
npm test
npm run validate:railway
npm run guard:commit
npm run validate:backend-cli:offline
python daemon-python/tests/test_telemetry_sanitization.py
python daemon-python/scripts/continuous_audit.py --max-depth=1 --no-recursive --no-railway-check
```
