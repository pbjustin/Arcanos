# ARCANOS Gaming Module

**Profile:** Nintendo-style hotline advisor that delivers actionable game strategies, hints, and walkthrough summaries. The module is exposed to ChatGPT via the normalized `/api/ask` intake path, so every Custom GPT must mirror the schema defined in `src/routes/api-ask.ts`.

## When to Route Here
- Player needs help with a puzzle, boss fight, or progression blocker.
- Caller is requesting a walkthrough summary or strategy breakdown.
- User provides an optional guide URL that should be ingested before answering.

## Request Payload
```json
{
  "prompt": "How do I beat the Guardian Ape in Sekiro?",
  "url": "https://example.com/sekiro/guardian-ape-guide"
}
```
- `prompt` (string) – Required user question or context. A raw string is also accepted when the calling workflow does not wrap the payload.
- `url` (string, optional) – Remote guide to hydrate the prompt. The service attempts to fetch and clean this URL before intake.
- `metadata` (object, optional) – Include `{ "gpt_id": "<custom gpt id>", "module": "ARCANOS:GAMING" }` when called from ChatGPT. The `/api/ask` shim records this information for telemetry.

## Pipeline
1. **Intake (Fine-tuned model).** Normalizes the user prompt and routes to the Gaming persona. System message: `ARCANOS Intake: Route to Gaming module.`
2. **Reasoning (GPT-5).** Generates hotline-quality strategy guidance with a friendly, professional tone.
3. **Audit (Fine-tuned model).** Validates clarity, safety, and alignment before releasing the answer. System message: `ARCANOS Audit: Validate Gaming module response for clarity, safety, and alignment.`

If OpenAI access is unavailable, the module emits deterministic mock text plus a trace indicating that intake and reasoning were skipped.

## Response Shape
```json
{
  "gaming_response": "Final audited answer...",
"audit_trace": {
    "intake": "Refined prompt...",
    "reasoning": "Raw GPT-5 output...",
    "finalized": "Audited answer"
  }
}
```
The `audit_trace` fields mirror the three pipeline stages, enabling downstream logging or escalation flows.

## Implementation Notes
- Module name: `ARCANOS:GAMING` (`src/modules/arcanos-gaming.ts`).
- Delegates to `runGaming` (`src/services/gaming.ts`) for all orchestration, including optional guide hydration via `fetchAndClean`.
- Temperature is set to `0.6` during reasoning for energetic yet reliable hints.

## Custom GPT Action Blueprint
Configure an Action named `Gaming Hotline` that calls `/api/ask` with the following contract:

```json
{
  "name": "Gaming Hotline",
  "description": "Route gameplay questions through the ARCANOS Gaming module",
  "url": "https://your-arcanos-deployment.com/api/ask",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "x-confirmed": "yes"
  },
  "body": {
    "message": "{{user_input}}",
    "domain": "arcanos:gaming",
    "useRAG": true,
    "metadata": {
      "gpt_id": "{{gpt_id}}",
      "module": "ARCANOS:GAMING"
    }
  }
}
```

## Sync Checklist
- Execute `npm test -- src/routes/api-ask.ts` to confirm the Action payload still aligns with the backend shim and associated Jest coverage in `tests/placeholder.test.ts`.
- Update `GPT_MODULE_MAP` or the legacy `GPTID_*` variables with the published GPT ID so automated calls receive the `x-gpt-id` fast path.
- Reflect any new optional payload keys (e.g., walkthrough URLs) in both this document and the GPT Builder instructions.
