# ARCANOS Core private plugin candidate

The repository candidate keeps the documented display name `ARCANOS` and the backend binding `arcanos-core` → `ARCANOS:CORE`. The existing Custom GPT, GPT Access Actions and stdio advisory bridge keep their current entry points. The implementation base is `e7f8a690d5164fa82db2d8c6a699e6c418f850e1`.

## Capability inventory

`REUSE` keeps an existing backend implementation. `WRAP` exposes an existing capability through the dedicated Core authorization boundary. `DEFER` leaves an existing capability on its existing authorized surface. `BLOCKED` identifies a capability that this connection cannot provide.

| Core or shared capability | Disposition | Plugin behavior |
| --- | --- | --- |
| Core questions, advice, explanation, planning, review, architecture, summarization, writing and exact answers | WRAP | `coreAsk` sends the complete request to the fixed Core query action. `direct` and `explained` answer modes remain available. |
| Trinity routing, Core time budgets, exact-literal shortcut and configured model selection | REUSE | The existing Core and Trinity services run under a server-owned plugin policy. The tool offers no model identifier, audit override or debug input. |
| GPT Access `createAiJob` and `getJobResult` | WRAP | The Core wrapper uses durable jobs and principal-bound retrieval. A completed answer may arrive during the initial wait. Otherwise the client continues the accepted job, using a result-only tool. |
| Request replay and conflict handling | REUSE | Reuse the existing durable idempotency mechanism with an owner-scoped key and an exact request. Follow-up reads use the existing job ID. |
| Session hydration, conversation persistence, memory recall and save | WRAP | The connection uses its own session authorization. `startCoreSession`, `readCoreMemory` and `writeCoreMemory` are purpose-bound. An explicit save requires a confirmation challenge bound to the requested write. |
| `getRuntimeStatus`, `getWorkersStatus`, and `inspectQueue` | WRAP | `inspectCoreDiagnostics` offers a closed area choice and aggregate fields. Existing runtime, worker and queue services supply the observations. |
| `arcanosAccessHealth`, `getWorkerHelperHealth`, `getSelfHealStatus`, `queryJobEventTimeline`, `runDeepDiagnostics`, `explainApprovedQuery`, and `queryBackendLogs` | DEFER | Keep their existing separately authorized GPT Access surfaces. The plugin provides only the scoped aggregate diagnostics. |
| `ARCANOS:PRODUCTIVITY` summary and focus reads | WRAP | `readCoreProductivity` offers two bounded views through the existing service. The backend requires the productivity read scope and an explicit owner mapping to a trusted productivity principal and workspace. |
| Other productivity operations, including inbox capture, project and task changes, knowledge, and reviews | DEFER | The existing GPT Access service retains the authorized workspace and its operator confirmation requirements. |
| `ARCANOS:LOCAL_AGENT` repository, Git, tests and patch actions, and device pairing/renewal/revocation | DEFER | Keep the separately authenticated device and workspace boundaries. Test runs and patch application require one-time approval bound to the exact request. |
| `listCapabilitiesV1`, `getCapabilityV1`, `listGptAccessModulesAlias`, `getGptAccessModuleAlias`, `runCapabilityV1`, `runDispatch`, and `arcanosMcpControl` | DEFER | Existing GPT Access authorization and confirmation continue to govern these operations. |
| `getGptAccessOpenApi`, legacy public bridge, generic job lookup and route health | DEFER | Existing routes retain their established callers and access controls. The plugin uses MCP discovery and exact owned continuation. |
| Deployment-wide memory list, search, tables, bulk writes and deletes | DEFER | The broad memory plane retains its existing credential and confirmation rules. |
| `arcanos_core.consult` stdio advisory tool | DEFER | The operator client continues to use the separately configured fixed gateway route. A plugin user can ask Core for advice through `coreAsk`. |
| Raw SQL, shell execution, proxying, service mutation, unrestricted MCP tools and cross-module access | BLOCKED | These operations are outside the Core tool catalog. |
| Job, session and memory access granted solely by a supplied ID, legacy credentials or claimed role | BLOCKED | The server derives ownership and grants from verified authorization. Existing legacy job or session IDs convey no plugin authority. |
| ChatGPT web search, image generation and code interpreter | DEFER | These settings belong to the host. Their availability in an installed Core plugin conversation requires host verification. |
| Original icon bytes and unmapped legacy workspace data | BLOCKED | Icon preservation needs the original asset. Existing productivity reads require an authorized mapping. Device data keeps its separate authorization. |

Baseline sources include the [Core module](../../../src/services/arcanos-core.ts), [Custom GPT guide](../../CUSTOM_GPTS.md#arcanos-core), [GPT Access guide](../../gpt-access-gateway.md), [migration inventory](../INVENTORY.md), [advisory bridge contract](../../security/arcanos-core-advisory-bridge.md), and the existing [Booker](../booker/README.md) and [Gaming](../gaming/README.md) migrations.

## Source and configuration parity

| Evidence | Result |
| --- | --- |
| Identity | The authenticated Builder showed `ARCANOS` with `Only me` visibility. Repository guides establish `arcanos-core` and route `core`. The candidate retains the name and canonical identity. |
| Saved instructions | Read-only Builder review confirmed general Core generation and same-job polling, protected diagnostics and exact one-use approval, productivity workflows, and bounded local-agent workflows. The source skill covers generation, continuation, aggregate diagnostics and the mapped productivity summary and focus views. It adds owned sessions and confirmed notes. Broader operations remain on their existing surfaces. Instruction parity is partial. |
| Saved Actions | Builder showed one Bearer-authenticated Action, ARCANOS GPT Access Gateway 1.0.0, with 20 saved operations. The inventory maps them to dedicated wrappers or their existing GPT Access surfaces. Current runtime grants and live behavior were unverified. |
| Uploaded knowledge | Builder displayed zero uploaded knowledge rows. The candidate includes zero uploads. The saved productivity knowledge workflow remains on its separately authorized legacy surface. |
| Saved presentation and host settings | Builder showed five starters, enabled web search, image generation and code interpreter, and disabled Apps. The candidate retains the display name and has a new integration description. Full presentation and installed host capability parity remain unverified. |

Keep any later Builder capture and reconciliation under the ignored `.local-migration/` boundary or in an owner-approved private store. Track only sanitized summaries and reviewed fingerprints.

## Connection and packaging

The candidate has a portable Agent Plugins 1.0 [manifest](../../../integrations/arcanos-core/plugin.json) and [tool-routing skill](../../../integrations/arcanos-core/skills/arcanos-core/SKILL.md). The Streamable HTTP path is `/chatgpt/core/mcp`. OAuth protected-resource discovery uses `/.well-known/oauth-protected-resource/chatgpt/core/mcp`.

The private package is pending a verified HTTPS resource and OAuth registration. After the exact approved endpoint is verified, add root `mcp.json` to the private release copy using the Agent Plugins MCP schema, server name `arcanos-core`, `streamable-http` transport and the exact URL. Use OpenAI’s server extension for OAuth with the verified client registration mode and the tool scopes actually granted. Use discovery for issuer endpoints, and keep client secrets in the host connection setup. A previously registered Core connection would require verifying its resource, ownership and tool contract before binding it.

Any provider setup must establish authorization-code flow with PKCE S256 and matching protected-resource and issuer metadata. Core requires `arcanos:core:query`. Its independent grants are `arcanos:core:memory:read`, `arcanos:core:memory:write`, `arcanos:core:diagnostics` and `arcanos:core:productivity:read`. Session-backed queries require both memory grants. The resource server checks the signed token against the exact resource, issuer and configured owner and client. Provider provisioning and real consent are separate acceptance steps. [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) · [OpenAI authentication](https://developers.openai.com/plugins/build/auth)

Before account installation, verify the final private archive’s member list, manifest, skill, OAuth configuration and reviewed identity assets. Record the exact archive hash and backend revision. A local manifest check establishes package structure. A fixture-signed token validates resource-server policy. Real OAuth requires the approved authorization server, and installed behavior requires the intended private package in an actual ChatGPT conversation.

## Owned continuity and confirmation

Core session records and job payloads use the existing durable storage with a dedicated encryption key. Conversation hydration draws from up to eight completed, retained Core jobs for the same owner and session, plus bounded saved notes. The existing GPT job retention window limits conversation history. Generic job lookups and generic worker detail views conceal private Core records.

Explicit saves reuse the existing process-local confirmation challenge, bound to the exact note, request key, session, and owner. A retry that reaches another web process or a restarted process requires a fresh challenge. Actual human approval handling remains an installed-client acceptance case.

## Acceptance cases

Use source-bound local fixtures to cover access, effects and failure handling. In an authorized installed test, use natural-language prompts and observe the actual selected tool, owned identifiers, response status and final answer.

| Case | Expected observation |
| --- | --- |
| Ask an ordinary question and a complex planning question | Both select the Core query. Final prose preserves the required content and format from a completed backend result. |
| Start a conversation and ask a follow-up in that session | The same owned session supplies continuity. An independent session or unowned handle cannot retrieve it. Explicit memory recall returns saved notes for the exact session. |
| Request a save, withhold approval, then approve the exact save | Initial challenge leaves memory unchanged. The approved write uses the same session, content and request key. A changed or foreign request cannot reuse the challenge. |
| Exercise a fast and a queued job, then repeat the original submission | Fast completion returns once. Pending triggers bounded result calls on the original job. Identical replay returns the same job and a changed request with the same key is rejected. |
| Request runtime, worker and queue status | The diagnostics grant authorizes bounded aggregate fields. Partial or unavailable observations remain explicit. |
| Ask what to focus on today or request a workspace summary | With the required scope and configured owner mapping, Core returns the authorized canonical productivity view. Missing mapping or data is visible in the outcome. |
| Request unsupported operational execution, foreign job access, or execution without a required scope | Access is rejected before the protected operation. Earlier legacy confirmation policies still apply on their own routes. |
| Induce timeout, provider failure and sensitive upstream error text in fixtures | Failures remain distinguishable from successful or pending results. Private diagnostics and credential-shaped data stay protected. |
| Exercise the existing Core Custom GPT, Gaming, Tutor and Booker contracts | Observe unchanged routing and authorization in the corresponding regression suites. |

Full migration parity requires reconciliation of the deferred Builder workflows and presentation, a linked and verified private connection, and installed behavior evidence. A sealed Railway preview can attest only the components it actually mounts and verifies.

## Local acceptance evidence

The [Core PostgreSQL fixture](../../../tests/integration/chatgpt-core.pg18.integration.test.ts)
uses the real MCP transport and repository SQL against a disposable PostgreSQL
18 database. It verifies synthetic signed bearer authentication, owner-scoped
jobs and sessions, exact confirmed memory writes, concurrent duplicate
submission, a committed result replay and a follow-up with backend continuity.
The fixture injects a model response and drives the worker's claim and terminal
write without starting the normal worker loop. The [offline transport suite](../../../tests/chatgpt-core-mcp.integration.test.ts)
also uses the MCP SDK client to verify discovery and structured responses.

Core is outside the current draft Railway preview profiles. Verification of the
authorized live OAuth issuer, Railway-hosted Core endpoint, provider output and
installed ChatGPT behavior is pending.
