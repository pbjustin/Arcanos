# Custom GPTs and Backend Integration

## Overview
Arcanos routes Custom GPT requests through the `/gpt/:gptId` gateway. This gateway is the writing plane: it resolves a GPT ID to a backend module, forwards generative work to the matched module, and returns route metadata describing the matched module/action set. The routing table is built from module definitions (including their `gptIds`), with optional overrides via environment configuration. The canonical Custom GPT contract is path-based: call `/gpt/<gpt-id>` with either a prompt-first generative request or the typed GPT bridge actions `query` and `query_and_wait`. Use direct control endpoints for job status/results, DAG traces, runtime diagnostics, and MCP tools. Legacy `get_status` and `get_result` aliases are reserved and rejected by `/gpt/:gptId` so control-plane reads do not enter the writing route.【F:src/routes/gptRouter.ts†L16-L159】【F:src/platform/runtime/gptRouterConfig.ts†L1-L180】【F:src/services/moduleLoader.ts†L1-L64】

## Why We Use Custom GPTs
Custom GPTs let Arcanos ship specialized assistants (Backstage Booker, Arcanos Gaming, Tutor) that:
- **Map cleanly to backend modules** so each assistant uses its own action surface (book events, run tutoring flows, etc.). The GPT router and module registry enforce this boundary and keep action lists explicit per module.【F:src/routes/gptRouter.ts†L16-L159】【F:src/routes/modules.ts†L1-L83】
- **Provide traceable acknowledgements** back to the caller, including matched module, action inventory, and routing metadata for auditability and debugging.【F:src/routes/gptRouter.ts†L96-L159】
- **Support secure automation** by allowing trusted GPT IDs to bypass manual confirmations when required, while still honoring confirmation gates for sensitive endpoints.【F:src/middleware/confirmGate.ts†L1-L200】

## How Custom GPT Routing Works
1. The GPT calls `POST /gpt/:gptId` with a request body that contains `prompt` and optional `gptVersion`, `action`, `payload`, and `context`.
2. Async job status/results must be fetched explicitly through `GET /jobs/:id`, `GET /jobs/:id/result`, or the authenticated GPT Access job-result endpoint.
3. Prompt-based control requests are rejected: job lookup prompts, DAG execution/tracing prompts, runtime inspection prompts, and explicit MCP tool calls must use their canonical control-plane endpoints.
4. Control actions are intercepted in the router and handled on the control plane before any writing dispatch or Trinity entry.
5. Simple prompt-generation requests may be handled by the inline GPT fast path. These return directly with `routeDecision.path: "fast_path"` and do not create a job.
6. Complex requests continue through the existing orchestrated path. The GPT router resolves the incoming GPT ID to a module route using the module map and fuzzy matching strategy if needed.
7. The writing request is forwarded to `/modules/:route`, and the response is wrapped with a `_route` metadata block.
8. The module handler calls the action implementation and returns the result as JSON.【F:src/routes/gptRouter.ts†L16-L159】【F:src/routes/modules.ts†L1-L83】

## Setup: Connect a Custom GPT to the Backend

### 1) Confirm the target module and GPT IDs
Each module declares a name, description, and `gptIds`. The router auto-discovers these modules and binds GPT IDs to their routes (unless overridden). Confirm the module name and the GPT ID you plan to use. Note that module routes are derived from their filenames; for files prefixed with `arcanos-`, the prefix is stripped to create the route name (e.g., `arcanos-gaming.ts` becomes `gaming`).
- Module discovery and routes: `src/services/moduleLoader.ts`.
- GPT ID routing map: `src/platform/runtime/gptRouterConfig.ts`.
- Module definitions: `src/services/*.ts` with compatibility shims in `src/modules/*.ts` where needed.
【F:src/services/moduleLoader.ts†L1-L64】【F:src/platform/runtime/gptRouterConfig.ts†L1-L180】

### 2) (Optional) Override GPT ID routing
If you want a custom GPT ID that is not in the module’s `gptIds`, set `GPT_MODULE_MAP` to a JSON mapping of GPT IDs to `{ route, module }`. Legacy environment variables (`GPTID_*`) are still supported for Backstage Booker, Arcanos Gaming, and Tutor if required.【F:src/platform/runtime/gptRouterConfig.ts†L1-L180】

### 3) Keep writing-plane and control-plane access separate
`/gpt/:gptId` module traffic does not grant control-plane privileges. Sensitive direct endpoints require their own approved auth and confirmation flow. Do not add non-core module GPTs such as `arcanos-gaming` or `gaming` to control-plane trust lists just to make writing requests work; Gaming should remain a non-privileged module client.【F:src/routes/_core/gptPlaneClassification.ts†L1-L107】【F:src/services/controlPlane/gptPolicy.ts†L1-L158】

### 4) Configure the Custom GPT action
Use a single HTTP action in your Custom GPT definition:
- **Method:** `POST`
- **URL:** `https://<your-backend>/gpt/{gptId}`
- **Headers:**
  - `Content-Type: application/json`
  - `x-gpt-id: <gpt-id>` (optional; only needed if you rely on trusted-gpt bypass)
- **Body schema:**
```json
{
  "prompt": "Describe the request for this GPT/module route.",
  "gptVersion": "optional-version",
  "action": "optional-supported-action",
  "payload": { "...": "optional-structured-input..." },
  "context": { "...": "optional-caller-context..." }
}
```
Rules:
- `gptId` belongs in the path, not the JSON body.
- Omit `action` by default so the backend can infer intent from the GPT/module binding.
- Use `executionMode: "fast"` for small prompt-generation requests that should return inline without queueing.
- Use `executionMode: "async"` or `executionMode: "orchestrated"` when the caller wants durable/orchestrated behavior even for prompt-generation text.
- Use `action: "query"` with a non-empty `prompt` when the caller wants a durable writing job immediately and will poll later.
- Use `action: "query_and_wait"` with a non-empty `prompt` when the caller wants the core GPT to complete synchronously through the lightweight direct action lane. The route returns a typed error if direct execution fails or times out; it does not synthesize bounded fallback content for latency guard events. Non-core GPT IDs keep the durable job plus bounded wait behavior.
- Body `action` is canonical. The router also accepts `?action=query_and_wait` and operation-style aliases such as `operationId: "requestQueryAndWait"` for generated GPT Action clients that separate operation metadata from body arguments.
- Use `GET /jobs/:id`, `GET /jobs/:id/result`, or `POST /gpt-access/jobs/result` when you need to fetch canonical async GPT job state without creating new work.
- Use direct control endpoints instead of `/gpt/:gptId` for runtime inspection, DAG tracing/execution, and MCP tool calls.
- Retrieval by natural-language prompt is intentionally blocked. Do not ask the GPT route to “look up job 123” in `prompt`; use the structured `action + payload.jobId` contract.
- Do **not** inject a default action like `"ask"`; only send `action` when the caller explicitly selects a supported backend action.

The router injects the module name server-side, so your Custom GPT does not need to specify `module` in the payload.【F:src/routes/gptRouter.ts†L16-L159】

### Canonical OpenAPI Contract
The machine-readable contract lives at [contracts/custom_gpt_route.openapi.v1.json](../contracts/custom_gpt_route.openapi.v1.json).

For live integrations, prefer the backend-served contract URL instead of a manually copied local file:
- `https://<your-backend>/contracts/custom_gpt_route.openapi.v1.json`

Important:
- Updating the repo file alone does not update an already-configured Custom GPT action.
- After changing the contract, refresh or re-import the action schema in the Custom GPT builder.
- `arcanos-core` is the built-in GPT ID for the main `ARCANOS:CORE` route.
- `arcanos-tutor` and `tutor` remain separate tutor-only GPT IDs for `ARCANOS:TUTOR`.
- Use `GPT_MODULE_MAP` only when you need additional custom GPT IDs beyond the built-in routes.

## Canonical Async Bridge
Use these request shapes for agent-safe async GPT work:

Inline fast-path prompt generation:
```json
{
  "prompt": "Generate a prompt for a launch email.",
  "executionMode": "fast"
}
```

Create a durable writing job:
```json
{
  "action": "query",
  "prompt": "Draft the release summary."
}
```

Execute a core GPT action synchronously:
```json
{
  "action": "query_and_wait",
  "prompt": "Draft the release summary.",
  "timeoutMs": 25000,
  "pollIntervalMs": 500
}
```

Canonical response guidance:
- Pending write: `{ "ok": true, "action": "query", "jobId": "job_123", "status": "pending" }`
- Completed `query_and_wait`: `{ "ok": true, "action": "query_and_wait", "status": "completed", "result": "..." }`
- Status/result read: use the canonical direct job endpoints; `/gpt/:gptId` rejects `get_status` and `get_result`.
- Error: `{ "ok": false, "action": "...", "error": { "code": "...", "message": "..." } }`

For a full architecture and operations runbook, see [GPT_FAST_PATH.md](GPT_FAST_PATH.md).

## Spec Sheet Template (for Custom GPT Actions)
Use this format when defining or documenting a Custom GPT:

```yaml
name: <Custom GPT name>
gpt_id: <gpt-id>
base_url: https://<your-backend>
endpoint: /gpt/{gptId}
method: POST
headers:
  Content-Type: application/json
body:
  prompt: <required natural-language request>
  gptVersion: <optional version string>
  action: <optional supported backend action>
  payload: <optional structured JSON>
  context: <optional caller context JSON>
success_response:
  description: JSON payload from the module, plus _route metadata.
```

For async bridge callers, prefer the generated OpenAPI schema instead of hand-written examples so the action discriminator stays aligned with the backend.

## Migration Note
- What was broken: older integrations still modeled GPT requests as `/ask` plus body-level `gptId`, and some wrappers injected an implicit `"action": "ask"` even though GPT routes are module-specific.
- What changed: the canonical contract is now `POST /gpt/{gptId}` with `gptId` as a required path parameter and `action` omitted unless the caller explicitly sets a backend-supported value.
- How to call it now: send `prompt` in the JSON body, optionally add `gptVersion`, `action`, `payload`, or `context`, and never duplicate `gptId` in the body.
- Legacy ask-style responses advertise migration state with `Deprecation`, `Sunset`, `x-canonical-route`, and `x-ask-route-mode` headers.
- Safe migration path: the default `ASK_ROUTE_MODE` is `gone`, which returns `410 Gone` for `/brain`. Set `ASK_ROUTE_MODE=compat` only as a temporary migration bridge for older callers, then remove the override.

## Custom GPT Catalog

### Backstage Booker
**What it is:** A pro wrestling booking assistant that handles event scheduling, roster updates, storyline tracking, match simulation, and GPT-generated booking narratives. It is implemented as the `BACKSTAGE:BOOKER` module and exposes multiple actions for booking workflows.【F:src/modules/backstage-booker.ts†L1-L44】【F:src/routes/backstage.ts†L1-L91】

**Known GPT IDs:** `backstage-booker`, `backstage`. The module route is derived from `backstage-booker.ts`, so the default route is `backstage-booker` and both GPT IDs map to it automatically.【F:src/modules/backstage-booker.ts†L1-L18】【F:src/services/moduleLoader.ts†L19-L52】

**Available actions (via `/gpt/<gpt-id>`):**
- `bookEvent`
- `updateRoster`
- `trackStoryline`
- `simulateMatch`
- `generateBooking`
- `saveStoryline`
【F:src/modules/backstage-booker.ts†L1-L44】

**Spec sheet example:**
```yaml
name: Backstage Booker
gpt_id: backstage-booker
base_url: https://<your-backend>
endpoint: /gpt/backstage-booker
method: POST
headers:
  Content-Type: application/json
body:
  prompt: "Book an AEW card at Daily's Place for 2024-09-20 with Omega vs. Danielson in the main event."
success_response:
  description: Booking ID plus _route metadata.
```

### Arcanos Gaming
**What it is:** A Core-managed, non-privileged Custom GPT module for gameplay guides, builds, and meta advice. The `ARCANOS:GAMING` module exposes only the `query` action, validates `mode` as `guide`, `build`, or `meta`, and forwards the validated request to the Gaming pipelines without exposing Core control-plane capabilities.【F:src/services/arcanos-gaming.ts†L1-L65】【F:src/services/gamingModes.ts†L1-L122】

**Known GPT IDs:** `arcanos-gaming`, `gaming`. The module route is derived from `arcanos-gaming.ts` (route: `gaming`) and both GPT IDs are pinned to `ARCANOS:GAMING` in direct dispatch so environment overrides cannot route them to Core.【F:src/services/arcanos-gaming.ts†L52-L65】【F:src/routes/_core/gptDispatch.ts†L701-L735】【F:src/services/moduleLoader.ts†L19-L52】

**Available actions (via `/gpt/<gpt-id>`):**
- `query`
【F:src/services/arcanos-gaming.ts†L52-L65】

**Spec sheet example:**
```yaml
name: Arcanos Gaming
gpt_id: arcanos-gaming
base_url: https://<your-backend>
endpoint: /gpt/arcanos-gaming
method: POST
headers:
  Content-Type: application/json
body:
  action: "query"
  payload:
    mode: "guide"
    prompt: "Give me beginner tips for surviving the first night."
    game: "Minecraft"
success_response:
  description: Direct Gaming module response envelope plus _route metadata for `ARCANOS:GAMING`.
```

**Payload contract:** `mode: "guide"` needs a prompt and may include `game`; `mode: "build"` and `mode: "meta"` require both `prompt` and `game`. Optional `url`, `urls`, `guideUrls`, `audit` / `enableAudit`, and `hrc` / `enableHrc` fields are validated by `gamingModes` before any pipeline runs. When callers send a partial explicit `payload`, top-level Gaming fields are merged only where the explicit payload omits them; explicit `payload` fields keep precedence.

**Boundary:** Gaming can call its own module action through `/gpt/arcanos-gaming` or `/gpt/gaming`. It cannot use `/gpt/:gptId` to run `runtime.inspect`, `workers.status`, `queue.inspect`, `self_heal.status`, `system_state`, `get_status`, `get_result`, MCP control actions, DAG control actions, or Core diagnostics; those are rejected by the writing-plane guard before Gaming dispatch.

### Arcanos Core
**What it is:** The primary ARCANOS entryway for the main custom GPT. The `ARCANOS:CORE` module sends prompt-first requests through the Trinity brain so the main GPT can use the general ARCANOS pipeline without being coupled to tutor-specific logic.

**Known GPT IDs:** `arcanos-core`, `core`. The module route is derived from `arcanos-core.ts` (route: `core`).

**Available actions (via `/gpt/<gpt-id>`):**
- `query`

**Spec sheet example:**
```yaml
name: Arcanos Core
gpt_id: arcanos-core
base_url: https://<your-backend>
endpoint: /gpt/arcanos-core
method: POST
headers:
  Content-Type: application/json
body:
  prompt: "Give me a direct answer using the main ARCANOS pipeline."
success_response:
  description: Main ARCANOS response with Trinity metadata and _route metadata.
```

### Arcanos Tutor
**What it is:** A professional tutoring kernel with modular learning flows, research augmentation, and auditing traces. The `ARCANOS:TUTOR` module accepts a `TutorQuery` that selects a domain/module pipeline and returns a structured response with audit traces.【F:src/modules/arcanos-tutor.ts†L1-L16】【F:src/logic/tutor-logic.ts†L14-L205】

**Known GPT IDs:** `arcanos-tutor`, `tutor`. The module route is derived from `arcanos-tutor.ts` (route: `tutor`).【F:src/modules/arcanos-tutor.ts†L1-L13】【F:src/services/moduleLoader.ts†L19-L52】

**Available actions (via `/gpt/<gpt-id>`):**
- `query`
【F:src/modules/arcanos-tutor.ts†L1-L13】

**Spec sheet example:**
```yaml
name: Arcanos Tutor
gpt_id: arcanos-tutor
base_url: https://<your-backend>
endpoint: /gpt/arcanos-tutor
method: POST
headers:
  Content-Type: application/json
body:
  prompt: "Explain session memory round-trips in under 250 tokens."
success_response:
  description: Tutor response with audit_trace and _route metadata.
```

## Validation Checklist (Minimal Test Plan)
- **Happy path:** Call `/gpt/<gpt-id>` with a valid `action` and `payload` and confirm `_route` metadata returns for the matched module.【F:src/routes/gptRouter.ts†L96-L159】
- **Edge case:** Use an unknown GPT ID and confirm a `404` with `Unknown GPTID` is returned.【F:src/routes/gptRouter.ts†L70-L104】
- **Failure mode:** Call a valid GPT ID with an invalid action and confirm the module returns `Action not found` or `Module not found` as appropriate.【F:src/routes/modules.ts†L16-L56】
- **Async bridge:** Confirm `query` creates one job, core `query_and_wait` completes through the direct action lane without bounded fallback text, non-core durable writes still use jobs, and `get_status` / `get_result` are rejected with direct endpoint guidance.
- **Fast path:** Confirm `executionMode: "fast"` for a prompt-generation request returns `200`, `routeDecision.path: "fast_path"`, `x-gpt-fast-path-queue-bypassed: true`, and `x-gpt-queue-bypassed: true`.
- **Guardrail:** Confirm prompt-based job retrieval is rejected and callers are pointed at structured control actions or `/jobs/*`.
