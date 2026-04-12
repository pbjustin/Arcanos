# Custom GPTs and Backend Integration

## Overview
Arcanos routes Custom GPT requests through the `/gpt/:gptId` gateway. This gateway resolves a GPT ID to a backend module, forwards the request to the module route, and returns an acknowledgement payload describing the matched module/action set. The routing table is built from module definitions (including their `gptIds`), with optional overrides via environment configuration. The canonical Custom GPT contract is now path-based: call `/gpt/<gpt-id>` with a prompt-first request body, and let the backend infer the action unless you explicitly set a supported one.【F:src/routes/gptRouter.ts†L16-L159】【F:src/config/gptRouterConfig.ts†L1-L92】【F:src/modules/moduleLoader.ts†L1-L64】

## Why We Use Custom GPTs
Custom GPTs let Arcanos ship specialized assistants (Backstage Booker, Arcanos Gaming, Tutor) that:
- **Map cleanly to backend modules** so each assistant uses its own action surface (book events, run tutoring flows, etc.). The GPT router and module registry enforce this boundary and keep action lists explicit per module.【F:src/routes/gptRouter.ts†L16-L159】【F:src/routes/modules.ts†L1-L83】
- **Provide traceable acknowledgements** back to the caller, including matched module, action inventory, and routing metadata for auditability and debugging.【F:src/routes/gptRouter.ts†L96-L159】
- **Support secure automation** by allowing trusted GPT IDs to bypass manual confirmations when required, while still honoring confirmation gates for sensitive endpoints.【F:src/middleware/confirmGate.ts†L1-L200】

## How Custom GPT Routing Works
1. The GPT calls `POST /gpt/:gptId` with a request body that contains `prompt` and optional `gptVersion`, `action`, `payload`, and `context`.
2. Async job status/results must be fetched explicitly, either through `GET /jobs/:id` / `GET /jobs/:id/result`, or through `POST /gpt/:gptId` with `action: "get_status"` / `action: "get_result"` plus `payload.jobId`.
3. The GPT router resolves the incoming GPT ID to a module route using the module map and fuzzy matching strategy if needed.
4. The request is forwarded to `/modules/:route`, and the response is wrapped with a `_gptAck` metadata block.
5. The module handler calls the action implementation and returns the result as JSON.【F:src/routes/gptRouter.ts†L16-L159】【F:src/routes/modules.ts†L1-L83】

## Setup: Connect a Custom GPT to the Backend

### 1) Confirm the target module and GPT IDs
Each module declares a name, description, and `gptIds`. The router auto-discovers these modules and binds GPT IDs to their routes (unless overridden). Confirm the module name and the GPT ID you plan to use. Note that module routes are derived from their filenames; for files prefixed with `arcanos-`, the prefix is stripped to create the route name (e.g., `arcanos-gaming.ts` becomes `gaming`).
- Module discovery and routes: `src/modules/moduleLoader.ts`.
- GPT ID routing map: `src/config/gptRouterConfig.ts`.
- Module definitions (examples below): `src/modules/*.ts`.
【F:src/modules/moduleLoader.ts†L1-L64】【F:src/config/gptRouterConfig.ts†L1-L92】

### 2) (Optional) Override GPT ID routing
If you want a custom GPT ID that is not in the module’s `gptIds`, set `GPT_MODULE_MAP` to a JSON mapping of GPT IDs to `{ route, module }`. Legacy environment variables (`GPTID_*`) are still supported for Backstage Booker, Arcanos Gaming, and Tutor if required.【F:src/config/gptRouterConfig.ts†L1-L92】

### 3) Add trust or confirmation headers when required
Sensitive endpoints enforce confirmation. You can:
- Manually confirm with `x-confirmed: yes`.
- Use confirmation tokens (`x-confirmed: token:<challengeId>`).
- Bypass the gate by adding your GPT ID to `TRUSTED_GPT_IDS` and sending `x-gpt-id: <gpt-id>`.
The confirmation gate reads GPT IDs from `x-gpt-id` headers or request bodies, and uses `TRUSTED_GPT_IDS` to allow safe automation.【F:src/middleware/confirmGate.ts†L1-L200】

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
- Use `action: "get_status"` or `action: "get_result"` with `payload.jobId` when you need to fetch canonical async GPT job state without creating new work.
- Use `action: "query_and_wait"` with a non-empty `prompt` when the integration surface needs one explicit caller action that creates one async GPT job and waits internally for completion.
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
  description: JSON payload from the module, plus _gptAck metadata.
```

## Migration Note
- What was broken: older integrations still modeled GPT requests as `/ask` plus body-level `gptId`, and some wrappers injected an implicit `"action": "ask"` even though GPT routes are module-specific.
- What changed: the canonical contract is now `POST /gpt/{gptId}` with `gptId` as a required path parameter and `action` omitted unless the caller explicitly sets a backend-supported value.
- How to call it now: send `prompt` in the JSON body, optionally add `gptVersion`, `action`, `payload`, or `context`, and never duplicate `gptId` in the body.
- Legacy `/ask` responses now advertise migration state with `Deprecation`, `Sunset`, `x-canonical-route`, and `x-ask-route-mode` headers.
- Safe removal path: leave `ASK_ROUTE_MODE` unset for compatibility mode, then switch to `ASK_ROUTE_MODE=gone` when you are ready for `/ask` to return `410 Gone`.

## Custom GPT Catalog

### Backstage Booker
**What it is:** A pro wrestling booking assistant that handles event scheduling, roster updates, storyline tracking, match simulation, and GPT-generated booking narratives. It is implemented as the `BACKSTAGE:BOOKER` module and exposes multiple actions for booking workflows.【F:src/modules/backstage-booker.ts†L1-L44】【F:src/routes/backstage.ts†L1-L91】

**Known GPT IDs:** `backstage-booker`, `backstage`. The module route is derived from `backstage-booker.ts`, so the default route is `backstage-booker` and both GPT IDs map to it automatically.【F:src/modules/backstage-booker.ts†L1-L18】【F:src/modules/moduleLoader.ts†L19-L52】

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
  description: Booking ID plus _gptAck metadata.
```

### Arcanos Gaming
**What it is:** A Nintendo-style hotline advisor for game strategies, walkthroughs, and hints. The `ARCANOS:GAMING` module expects a prompt plus optional guide URLs that the service can use as reference material.【F:src/modules/arcanos-gaming.ts†L1-L43】

**Known GPT IDs:** `arcanos-gaming`, `gaming`. The module route is derived from `arcanos-gaming.ts` (route: `gaming`).【F:src/modules/arcanos-gaming.ts†L1-L19】【F:src/modules/moduleLoader.ts†L19-L52】

**Available actions (via `/gpt/<gpt-id>`):**
- `query`
【F:src/modules/arcanos-gaming.ts†L1-L31】

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
  prompt: "How do I beat the Thunderblight boss?"
success_response:
  description: Strategy guidance plus _gptAck metadata.
```

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
  description: Main ARCANOS response with Trinity metadata and _gptAck metadata.
```

### Arcanos Tutor
**What it is:** A professional tutoring kernel with modular learning flows, research augmentation, and auditing traces. The `ARCANOS:TUTOR` module accepts a `TutorQuery` that selects a domain/module pipeline and returns a structured response with audit traces.【F:src/modules/arcanos-tutor.ts†L1-L16】【F:src/logic/tutor-logic.ts†L14-L205】

**Known GPT IDs:** `arcanos-tutor`, `tutor`. The module route is derived from `arcanos-tutor.ts` (route: `tutor`).【F:src/modules/arcanos-tutor.ts†L1-L13】【F:src/modules/moduleLoader.ts†L19-L52】

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
  description: Tutor response with audit_trace and _gptAck metadata.
```

## Validation Checklist (Minimal Test Plan)
- **Happy path:** Call `/gpt/<gpt-id>` with a valid `action` and `payload` and confirm `_gptAck` metadata returns for the matched module.【F:src/routes/gptRouter.ts†L96-L159】
- **Edge case:** Use an unknown GPT ID and confirm a `404` with `Unknown GPTID` is returned.【F:src/routes/gptRouter.ts†L70-L104】
- **Failure mode:** Call a valid GPT ID with an invalid action and confirm the module returns `Action not found` or `Module not found` as appropriate.【F:src/routes/modules.ts†L16-L56】
