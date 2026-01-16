# Custom GPT → ARCANOS Ask Dispatcher

## Overview
OpenAI Custom GPTs reach the ARCANOS backend through the **Ask dispatcher**, a hardened HTTP entrypoint that normalizes GPT action payloads and forwards them into the shared Trinity brain pipeline. The dispatcher is responsible for validating requests, enriching them with routing hints, and ensuring that every prompt is examined by ARCANOS’ routing logic before any downstream module executes.

## 1. Express surface area
All core routers are mounted inside `registerRoutes`, which exposes both `/ask` and `/api/ask` at the application root. `/ask` is the canonical entrypoint, while `/api/ask` is a normalization shim intended for Custom GPT Actions that may send prompts under different field names. Both routes ultimately call the same handler. 【F:src/routes/register.ts†L1-L103】

## 2. Normalization for Custom GPT payloads
The `/api/ask` route accepts flexible payloads (`message`, `prompt`, `text`, `query`, etc.), validates them, and collapses the values into a single `prompt`. Optional flags such as `domain`, `useRAG`, `useHRC`, and arbitrary metadata are converted into `[ARCANOS CONTEXT]` directives that are appended to the prompt. The shim then rewrites the Express request body so it matches the `AskRequest` contract before delegating to the shared handler. This is what allows diverse Custom GPT Actions to rely on a single dispatcher contract without rewriting their payloads. 【F:src/routes/api-ask.ts†L1-L93】

## 3. Shared Ask handler and Trinity pipeline
`handleAIRequest` powers both `/ask` and `/api/ask`. After running the standard request validator and audit logging, the handler invokes `runThroughBrain`. The Trinity pipeline performs staged dispatching:

1. **ARCANOS intake** validates the fine-tuned model and applies audit-safe constraints.
2. **GPT-5.1 reasoning** is invoked unconditionally to perform deep analysis.
3. **ARCANOS finalization** filters GPT-5.1 output, applies memory context, and emits the final response along with routing metadata.

This pipeline is the “dispatcher” that interprets the normalized prompt (including the context hints added by `/api/ask`) and decides how to process it, tracking every stage in the `routingStages` array that flows back to the caller. 【F:src/routes/ask.ts†L1-L87】【F:src/logic/trinity.ts†L1-L200】

## 4. Module-aware routing for Custom GPT IDs
When a Custom GPT is configured with an ID (e.g., `arcanos-tutor`), requests sent to `/gpt/:gptId` are automatically rewritten to `/modules/<route>` by the GPT router. The router loads the GPT → module map at startup, attaches the resolved module name to the request body, and hands control to the module registry. Module definitions declare their supported actions, so the dispatcher can forward prompts to the correct specialized handler (tutor, backstage booker, etc.) once the Trinity pipeline signals that module execution is required. 【F:src/routes/gptRouter.ts†L1-L29】【F:src/config/gptRouterConfig.ts†L1-L88】【F:src/modules/arcanos-tutor.ts†L1-L15】

## 5. Putting it together
1. A Custom GPT Action POSTs to `/api/ask` (or `/ask` if it already conforms to the contract).
2. The route normalizes the payload, adds routing hints, and forwards the request to `handleAIRequest`.
3. The Trinity dispatcher validates models, runs GPT-5.1 reasoning, and produces a response annotated with `routingStages`, memory, and audit metadata.
4. If the GPT is tied to a module-specific endpoint, the `/gpt/:gptId` router ensures the prompt reaches the proper module handler after Trinity processing.

Because all of these steps are wired together in code, you can point Custom GPTs at the Ask dispatcher with confidence that the backend will normalize the payload, audit it, and route it to the appropriate execution path without bypassing any guardrails.
