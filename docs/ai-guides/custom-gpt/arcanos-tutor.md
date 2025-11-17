# ARCANOS Tutor Module

**Profile:** Professional tutoring kernel with dynamic schema binding, modular instruction patterns, and full audit traceability. ChatGPT integrations must call the `/api/ask` intake to guarantee parity with internal tooling.

## When to Route Here
- Learner asks for structured explanations, study plans, or concept breakdowns.
- Memory, research, or logic workflows require pedagogical validation.
- Follow-up tutoring is needed after Backstage or Gaming escalations.

## Request Payload
```json
{
  "intent": "research",
  "domain": "research",
  "module": "findSources",
  "payload": {
    "topic": "Neural architecture search"
  },
  "metadata": {
    "gpt_id": "<custom gpt id>",
    "module": "ARCANOS:TUTOR"
  }
}
```
Fields:
- `intent` (string, optional) – Free-form description recorded in the audit trace.
- `domain` (string) – Selects a pattern (`memory`, `research`, `logic`). Defaults to `default` if unspecified or unknown.
- `module` (string) – Chooses the instruction module within the selected domain (for example `findSources`).
- `payload` (object) – Module-specific arguments consumed by downstream helpers.

## Pipeline
1. **Intake (Default fine-tuned model).** Routes to the tutor persona (`ARCANOS Intake: Route to Tutor module.`) and normalizes the prompt.
2. **Reasoning (GPT-5).** Produces structured, learner-friendly guidance. Temperature defaults to `0.3` but can be overridden by modules.
3. **Audit (Default fine-tuned model).** Validates accuracy, tone, and clarity (`ARCANOS Audit: Validate the tutoring response...`).

Mock responses are generated when the OpenAI client is unavailable or the environment is configured for testing.

## Domain Modules
| Domain | Module | Description |
| --- | --- | --- |
| `memory` | `explain` | Explains stored memory logic for a given topic. |
| `memory` | `audit` | Audits an individual memory entry for correctness. |
| `research` | `findSources` | Calls `searchScholarly` to gather academic references and synthesizes a learning brief. |
| `logic` | `clarify` | Clarifies an application logic flow based on structured payload input. |
| `default` | `generic` | Fallback tutor instructions for any payload. |

Each module can override token limits, temperature, and custom prompts when invoking the shared pipeline.

## Response Shape
```json
{
  "arcanos_tutor": "Finalized tutoring answer...",
  "audit_trace": {
    "received_at": "2024-04-01T00:00:00.000Z",
    "intent_clarified": "research",
    "domain_bound": "research",
    "instruction_module": "findSources",
    "pattern_ref": "pattern_1756454042135",
    "fallback_invoked": false,
    "pipeline": {
      "intake": "Refined prompt...",
      "reasoning": "Structured outline...",
      "finalized": "Audited guidance"
    },
    "model": {
      "intake": "gpt-4.1-mini",
      "reasoning": "gpt-5.1",
      "audit": "gpt-4.1-mini"
    }
  },
  "metadata": {
    "sources": [
      {
        "title": "Sample Source",
        "year": 2023,
        "journal": "Journal of AI"
      }
    ]
  }
}
```
Audit metadata exposes routing decisions alongside the pipeline trace for observability.

## Implementation Notes
- Module name: `ARCANOS:TUTOR` (`src/modules/arcanos-tutor.ts`).
- Core orchestration lives in `src/logic/tutor-logic.ts`.
- Uses `searchScholarly` to hydrate research flows with academic citations when available.
- Automatically falls back to a mock response if any stage throws, flagging `fallback_invoked` and noting the redirected module.

## Custom GPT Action Blueprint
Create an Action named `Tutor Intake` that forwards structured tutoring requests into `/api/ask`:

```json
{
  "name": "Tutor Intake",
  "description": "Send tutoring prompts to the ARCANOS Tutor module",
  "url": "https://your-arcanos-deployment.com/api/ask",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "x-confirmed": "yes"
  },
  "body": {
    "message": "{{user_input}}",
    "domain": "arcanos:tutor",
    "useRAG": true,
    "metadata": {
      "gpt_id": "{{gpt_id}}",
      "module": "ARCANOS:TUTOR"
    }
  }
}
```

## Sync Checklist
- Run `npm test -- src/routes/api-ask.ts` to verify the tutoring payload remains compatible with the normalization shim used in `tests/placeholder.test.ts`.
- Update the tutor persona instructions whenever new domain modules ship so the GPT mirrors the backend capabilities.
- Keep the fallback messaging aligned with the mock response shape described above so staging operators can differentiate between real and simulated tutor answers.
