# Tutor backend regression review

This companion records the backend boundaries and deterministic coverage selected
for the migration candidate, including the scoped repairs reviewed on 2026-09-24.
It is not a live provider, production Action, or migrated-skill verification result.
The exact-head sealed preview preceded these repairs and does not cover them.

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

At previewed head `7f4e8c6de2ad145be04de23a436a2dc106f118e7`, backend and protocol
files were unchanged from base `3f9fffe48219b784dca758bca87ade109324c7c9`. The
current candidate includes the two repairs below. Legacy Tutor domain/module
selection, scholarly research and queue behavior remain on their existing routes.
None becomes a new plugin argument or capability.
The plugin continues to call only the isolated generic Tutor adapter with `{prompt}`.

The prior composition suite tested a legacy `ping` success and expected queued
query denial without a job backend. The focused new test closes the narrow gap
of a successful legacy Tutor `query` response while the new OAuth route is enabled.
It does not claim that the user's published Builder Action schema or production
worker behavior was exercised. Those account artifacts are still required.

## Scoped repairs and local evidence

The final honesty filter previously treated learner-directed arithmetic such as
"check this by multiplying" as a claim that the assistant had performed live
verification. The repair introduces a server-owned `tutor-math-v1` policy only for
the isolated Tutor pipeline. A closed arithmetic vocabulary permits local learner
instructions; completed verification claims, external state, account/database
operations and unrecognized wording retain the existing checks. The policy grants
no capability and cannot be selected by prompt text or another pipeline source.

The implementation is in [Tutor logic](../../src/core/logic/tutor-logic.ts),
[Trinity](../../src/core/logic/trinity.ts) and
[honesty filtering](../../src/core/logic/trinityHonesty.ts).
[Focused regressions](../../tests/tutor-instructional-verification.test.ts) cover
both honesty passes, prohibited claims and policy activation. The pipeline suite
checks the repair with synthetic provider output. A negative control using the old
guard corrupted the synthetic two-sentence answer: the selected regression failed,
with 11 other tests intentionally skipped. The repaired four-suite run passed
118 tests. This reproduces one code-level failure mechanism; it does not fully
attribute the earlier live response or prove that live teaching style is fixed.

After account reconnect, the connector also rejected an ordinary prompt before
backend execution because it interpreted the advertised `\S` pattern as a whole
string match. The [canonical input schema](../../packages/protocol/schemas/v1/tools/arcanos-tutor.input.schema.json)
now advertises `^[\s\S]*\S[\s\S]*$`. The only argument remains `prompt`, with the
same non-whitespace requirement, 8,000-character maximum and rejection of extra
properties. Four MCP SDK regression cases cover ordinary, surrounding-whitespace,
multiline and 8,000-character boundary prompts; an independent comparison of
3,379 synthetic strings, including Unicode, found zero acceptance differences
under JSON Schema pattern semantics.

| Local validation | Result |
| --- | --- |
| Initial honesty/Tutor selection | PASS, four suites / 118 tests; included in the broader focused selection below |
| Final focused selection | PASS, thirteen suites / 407 tests, zero failures or skips |
| Protocol selection | PASS, four suites / 55 tests, zero failures or skips; nonoverlapping with the thirteen suites |
| Type-check and build | PASS after generating the local Prisma client; initial script-free dependency setup had skipped its generation |
| Lint | PASS, zero errors / 76 existing warnings |
| Backend/CLI contract and offline checks | PASS |
| Source package validation / release validation | PASS / expected exit 2 with RELEASE_BLOCKED; no archive |
| Sync check | PASS, zero errors / zero warnings / five informational notices |

The final focused and protocol selections total 17 suites / 462 tests. Do not add
the earlier 118-test selection again. A separate reviewer inspected the repair
diff and regression coverage and found no code blocker. Final tracked
evidence/documentation review also found no repository blocker. The package
ledger regression suite passed again after fixture isolation: 90/90, already
included in the 462-test selection above.

These repairs do not change a backend route, OAuth rule, provider model, teaching
prompt, memory policy, credential or production variable. They are not deployed.
The earlier live disclaimer/format issue remains `LIVE_RETEST_PENDING` until an
authorized deployment, catalog refresh and actual call provide fresh evidence.
Original-GPT and actual migrated-skill comparisons still require captured
configuration fingerprints. No accepted difference is inferred from local tests.

## Candidate acceptance follow-up

Review of the owner's exact Test C found another deterministic false positive:
the closed vocabulary omitted `cross` and `equality`. Two new learner-instruction
cases failed against the unchanged `607b6424` guard (2 failed, 15 passed). Adding
only those two arithmetic words passed all 17 cases, including a new mixed
arithmetic/live-account negative. A separate reviewer found no code blocker.
The Tutor-only policy, operation/prefix requirements and generic honesty behavior
remain unchanged; no model output is truncated or rewritten into a test pass.

The [acceptance checkpoint](TUTOR_CANDIDATE_ACCEPTANCE.md) separates repository
tests from the still-unexecuted authenticated deployment, SDK and ChatGPT tests.
`LIVE_RETEST_PENDING` remains the live formatting disposition. The earlier
156/156 sealed preview predates this repair and the previous schema repair.
