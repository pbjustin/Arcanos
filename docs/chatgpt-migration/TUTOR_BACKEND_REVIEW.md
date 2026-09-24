# Tutor backend regression review

This companion identifies unchanged backend boundaries and the deterministic
coverage selected for the migration candidate. It is not a live account, provider,
production Action, or migrated-skill verification result. Execution results belong
in the draft pull request's validation record.

| Boundary reviewed | Source | Relevant deterministic coverage |
| --- | --- | --- |
| Canonical prompt-only request and bounded public result | [Protocol binding](../../packages/protocol/src/chatgptTutor.ts), [input schema](../../packages/protocol/schemas/v1/tools/arcanos-tutor.input.schema.json), [output schema](../../packages/protocol/schemas/v1/tools/arcanos-tutor.output.schema.json) | [MCP integration](../../tests/chatgpt-mcp.integration.test.ts) checks schemas, exact single tool, extra-argument rejection, empty/oversized prompts, and forbidden tool names. |
| OAuth authority remains purpose-bound | [Authentication](../../src/chatgpt/auth.ts) | [Auth tests](../../tests/chatgpt-auth.test.ts) cover signatures, issuer/audience/type/expiry/scope, forged principals, purpose-bound credential rejection, and bounded JWKS behavior. |
| Scope and unsupported-operation checks precede Tutor execution | [Tutor adapter](../../src/chatgpt/tutor.ts) | [Pipeline tests](../../tests/chatgpt-tutor.pipeline.test.ts) and [HTTP E2E fixtures](../../tests/chatgpt-tutor.e2e.integration.test.ts) reject control requests, memory requests, session injection, invalid identities, and unsafe runtime state. |
| Isolation strips ambient history and optional effects | [Tutor service](../../src/services/arcanos-tutor.ts), [Tutor logic](../../src/core/logic/tutor-logic.ts) | Pipeline tests assert no memory/RAG/database/scholarly access, no saved patterns or optional feedback, provider storage disabled, and caller separation. HTTP fixtures verify actual abort propagation through the synthetic upstream socket. |
| Cancellation and failure remain explicit | [MCP route](../../src/routes/chatgptMcp.ts), Tutor adapter/service | MCP integration and HTTP fixtures cover timeout, disconnect, fixed unavailable errors, provider-budget exhaustion, closed storage admission, and no false completed/mock success after provider failure. |
| Existing teaching and literal behavior remain intact | [Tutor prompts](../../src/platform/runtime/tutorPrompts.ts), Tutor logic | [Prompt-forwarding tests](../../tests/tutor-logic.prompt-forwarding.test.ts) preserve direct prompt forwarding and exact-literal shortcuts; pipeline tests distinguish `model`, `mock`, and `shortcut`. |
| Existing Tutor Custom GPT Actions remain separate | [GPT router](../../src/routes/gptRouter.ts) | [Application composition](../../tests/chatgpt-app-composition.test.ts) verifies old routing and operator boundaries with the new route disabled/misconfigured. [Migration legacy tests](../../tests/tutor-migration-legacy.test.ts) add a successful legacy `query` response with MCP disabled, misconfigured, and enabled while anonymous MCP remains denied. Legacy execution is mocked; the real HTTP router runs. |
| Legacy query scheduling is not replaced by synchronous MCP | [GPT execution policy](../../src/routes/_core/gptRouteExecutionPolicy.ts) | [Execution-policy tests](../../tests/gpt-route-execution-policy.test.ts) retain ordinary non-core `query` scheduling and explicit synchronous precedence. The new migration test explicitly selects that existing sync option; it does not change defaults. |

The reviewed backend files are unchanged by this package work. Legacy Tutor
domain/module selection, scholarly research, queue behavior, and audit output
remain on their existing routes. None becomes a new plugin argument or capability.
The plugin continues to call only the isolated generic Tutor adapter with `{prompt}`.

The prior composition suite tested a legacy `ping` success and expected queued
query denial without a job backend. The focused new test closes the narrow gap
of a successful legacy Tutor `query` response while the new OAuth route is enabled.
It does not claim that the user's published Builder Action schema or production
worker behavior was exercised. Those account artifacts are still required.

No backend route, OAuth rule, provider model, teaching prompt, memory policy,
credential, production variable, or deployment is changed. A real response's
unrequested disclaimer or formatting difference must remain a parity concern
until compared with the captured published GPT and explicitly resolved or accepted;
synthetic transport tests cannot establish pedagogical parity.
