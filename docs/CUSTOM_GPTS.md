# Custom GPTs and Backend Integration

## Overview
Arcanos routes Custom GPT requests through the `/gpt/:gptId` gateway. This gateway resolves a GPT ID to a backend module, forwards the request to the module route, and returns an acknowledgement payload describing the matched module/action set. The routing table is built from module definitions (including their `gptIds`), with optional overrides via environment configuration. This means your Custom GPT only needs to call `/gpt/<gpt-id>` with an action and payload, and the backend handles the module wiring automatically.【F:src/routes/gptRouter.ts†L16-L159】【F:src/config/gptRouterConfig.ts†L1-L92】【F:src/modules/moduleLoader.ts†L1-L64】

## Why We Use Custom GPTs
Custom GPTs let Arcanos ship specialized assistants (Backstage Booker, Arcanos Gaming, Tutor) that:
- **Map cleanly to backend modules** so each assistant uses its own action surface (book events, run tutoring flows, etc.). The GPT router and module registry enforce this boundary and keep action lists explicit per module.【F:src/routes/gptRouter.ts†L16-L159】【F:src/routes/modules.ts†L1-L83】
- **Provide traceable acknowledgements** back to the caller, including matched module, action inventory, and routing metadata for auditability and debugging.【F:src/routes/gptRouter.ts†L96-L159】
- **Support secure automation** by allowing trusted GPT IDs to bypass manual confirmations when required, while still honoring confirmation gates for sensitive endpoints.【F:src/middleware/confirmGate.ts†L1-L200】

## How Custom GPT Routing Works
1. The GPT calls `POST /gpt/:gptId` with a request body that contains `action` and `payload`.
2. The GPT router resolves the incoming GPT ID to a module route using the module map and fuzzy matching strategy if needed.
3. The request is forwarded to `/modules/:route`, and the response is wrapped with a `_gptAck` metadata block.
4. The module handler calls the action implementation and returns the result as JSON.【F:src/routes/gptRouter.ts†L16-L159】【F:src/routes/modules.ts†L1-L83】

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
- **URL:** `https://<your-backend>/gpt/<gpt-id>`
- **Headers:**
  - `Content-Type: application/json`
  - `x-gpt-id: <gpt-id>` (required if you rely on trusted-gpt bypass)
- **Body schema:**
```json
{
  "action": "<module-action>",
  "payload": { "...": "..." }
}
```
The router injects the module name server-side, so your Custom GPT does not need to specify `module` in the payload.【F:src/routes/gptRouter.ts†L16-L159】

## Spec Sheet Template (for Custom GPT Actions)
Use this format when defining or documenting a Custom GPT:

```yaml
name: <Custom GPT name>
gpt_id: <gpt-id>
base_url: https://<your-backend>
endpoint: /gpt/<gpt-id>
method: POST
headers:
  Content-Type: application/json
  x-gpt-id: <gpt-id>
body:
  action: <module-action>
  payload: <action-specific JSON>
success_response:
  description: JSON payload from the module, plus _gptAck metadata.
```

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
  x-gpt-id: backstage-booker
body:
  action: bookEvent
  payload:
    brand: "AEW"
    venue: "Daily's Place"
    date: "2024-09-20"
    card:
      - match: "Omega vs. Danielson"
        stipulation: "20-minute time limit"
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
  x-gpt-id: arcanos-gaming
body:
  action: query
  payload:
    prompt: "How do I beat the Thunderblight boss?"
    urls:
      - "https://example.com/guide/thunderblight"
success_response:
  description: Strategy guidance plus _gptAck metadata.
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
  x-gpt-id: arcanos-tutor
body:
  action: query
  payload:
    intent: "explain"
    domain: "memory"
    module: "explain"
    payload:
      topic: "session memory round-trips"
      tokenLimit: 250
success_response:
  description: Tutor response with audit_trace and _gptAck metadata.
```

## Validation Checklist (Minimal Test Plan)
- **Happy path:** Call `/gpt/<gpt-id>` with a valid `action` and `payload` and confirm `_gptAck` metadata returns for the matched module.【F:src/routes/gptRouter.ts†L96-L159】
- **Edge case:** Use an unknown GPT ID and confirm a `404` with `Unknown GPTID` is returned.【F:src/routes/gptRouter.ts†L70-L104】
- **Failure mode:** Call a valid GPT ID with an invalid action and confirm the module returns `Action not found` or `Module not found` as appropriate.【F:src/routes/modules.ts†L16-L56】
