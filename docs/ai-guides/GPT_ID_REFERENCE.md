# 🆔 GPT Identifier Playbook

ARCANOS relies on GPT identifiers ("GPT IDs") to authenticate Custom GPT callers,
route automation to the correct backend module, and maintain audit trails.
This guide describes how GPT IDs are defined, resolved, and consumed across the
stack so that new assistants can be onboarded safely.

## 🔍 What Counts as a GPT ID?

A GPT ID is a lowercase string (e.g. `arcanos-tutor`) that uniquely identifies a
Custom GPT integration. IDs double as routing keys and security tokens:

- **Routing** – `src/config/gptRouterConfig.ts` maps each ID to a module route
  and canonical module name. This allows incoming traffic to be dispatched to
  the correct module implementation without hard-coding new routes.
- **Trust** – `src/middleware/confirmGate.ts` accepts trusted GPT IDs listed in
  `TRUSTED_GPT_IDS`, allowing vetted automations to bypass manual
  `x-confirmed: yes` headers while still logging every request.
- **Telemetry** – Modules can surface the active GPT ID for debugging or
  analytics. For example, Backstage workflows thread the `USER_GPT_ID`
  environment value into storyline audits.

## 🗺️ Resolution Order

`loadGptModuleMap()` in
[`src/config/gptRouterConfig.ts`](../../src/config/gptRouterConfig.ts) builds the
runtime lookup in three layers:

1. **Module defaults** – Every file in `src/modules/` can export `gptIds`.
   During discovery, each identifier (plus the module route itself) is bound to
   the module name. Example: `arcanos-tutor` and `tutor` both resolve to
   `ARCANOS:TUTOR`.
2. **`GPT_MODULE_MAP` overrides** – Supplying a JSON object (stringified) allows
   deployments to redefine or append bindings without shipping new code.
3. **Legacy `GPTID_*` variables** – `GPTID_BACKSTAGE_BOOKER`,
   `GPTID_ARCANOS_GAMING`, and `GPTID_ARCANOS_TUTOR` are still honoured so older
   environments keep working while migrating to the consolidated map.

The first match wins; later layers overwrite earlier defaults. After resolution
the map is cached for the process lifetime.

## 🧩 Default GPT IDs by Module

| Module | Route | Default IDs |
| --- | --- | --- |
| `BACKSTAGE:BOOKER` | `backstage-booker` | `backstage-booker`, `backstage` |
| `ARCANOS:GAMING` | `arcanos-gaming` | `arcanos-gaming`, `gaming` |
| `ARCANOS:TUTOR` | `arcanos-tutor` | `arcanos-tutor`, `tutor` |
| `ARCANOS:RESEARCH` | `arcanos-research` | `arcanos-research`, `research` |

When introducing new modules, declare a `gptIds` array to publish their default
identifiers. `loadModuleDefinitions()` will automatically ingest the file as long
as it lives under `src/modules/` and exports actions.

## ✅ Establishing Trust

The confirmation gate enforces OpenAI ToS compliance by blocking sensitive
requests unless either condition holds:

1. The caller supplies `x-confirmed: yes`.
2. The caller supplies `x-gpt-id: <id>` where `<id>` exists in
   `TRUSTED_GPT_IDS` (comma-separated, case-sensitive).

Trusted GPT IDs are parsed once at boot and kept in memory. Additions therefore
require a process restart or redeploy. See
[`docs/CONFIGURATION.md`](../CONFIGURATION.md) for the variable reference and the
broader security matrix.

## 🛠️ Registration Checklist for New GPTs

1. **Pick an ID** – Use lowercase kebab-case with a product prefix (e.g.
   `backstage-scout`). Avoid collisions with existing IDs and reserve
   human-readable names for manual callers.
2. **Bind the module** – Add the new ID to the target module’s `gptIds` array or
   include it in `GPT_MODULE_MAP` if the module lives in another deployment.
3. **Grant trust (optional)** – Append the ID to `TRUSTED_GPT_IDS` when the GPT
   should bypass manual confirmations. Otherwise keep the GPT in untrusted mode
   so humans must acknowledge high-risk actions.
4. **Document headers** – Update GPT Builder instructions to send
   `x-gpt-id: <id>` and any confirmation requirements. Existing templates in
   `docs/ai-guides/custom-gpt/` cover common phrasing.
5. **Test the route** – Issue a request that includes the new `x-gpt-id` and
   confirm the module receives the payload. Watch for `[🛡️ CONFIRM-GATE]`
   console entries to verify that the ID is recognised.

## 🧪 Troubleshooting

- **403 Forbidden despite correct ID** – Ensure the ID is spelled exactly as it
  appears in `TRUSTED_GPT_IDS`. Leading/trailing spaces are stripped, but casing
  must match.
- **Routing to the wrong module** – Dump the active map via a quick `console.log`
  of `await loadGptModuleMap()` during development. Overrides from
  `GPT_MODULE_MAP` or legacy `GPTID_*` variables may be shadowing defaults.
- **Module not loading** – Confirm the file is discoverable by
  `loadModuleDefinitions()` (correct extension, not named `moduleLoader.ts`, and
  exporting a default object with `actions`).
- **Need per-user auditing** – Set `USER_GPT_ID` to the human-facing alias. The
  Backstage module will thread the value through booking logs for context.

Keeping GPT IDs consistent across configuration, code, and documentation makes
Custom GPT integrations debuggable and compliant while preserving a simple
upgrade path.
