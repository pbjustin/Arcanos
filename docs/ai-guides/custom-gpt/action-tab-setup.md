# Custom GPT Action Tab Setup Guide

This guide explains how to configure the **Actions** tab inside the OpenAI Custom GPT builder so it can talk to the ARCANOS Unified AI Dispatcher. Follow these steps whenever you publish a new GPT or rotate credentials for an existing one.

## 1. Prerequisites
- ✅ Production ARCANOS backend deployed and reachable over HTTPS.
- ✅ Service account or API key with permission to call the `/ask` dispatcher route.
- ✅ Latest OpenAPI document (v3.1) describing the dispatcher contract.
- ✅ Confirmed GPT identifier (`gptId`) registered in `TRUSTED_GPT_IDS` or the `GPT_MODULE_MAP`.

> ℹ️ The OpenAPI schema fragment below matches the version that ships with `Arcanos Unified AI Dispatcher` (v1.0.1). Update the `servers` block if you deploy to a different domain.

```yaml
openapi: 3.1.0
info:
  title: Arcanos Unified AI Dispatcher
  description: Central interface to the ARCANOS system via /ask.
  version: 1.0.1
servers:
  - url: REDACTED_BACKEND_URL
    description: Production backend (updated)
paths:
  /ask:
    post:
      operationId: ask
      summary: Central AI dispatcher (natural language prompts)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                gptId:
                  type: string
                  description: Unique identifier for the calling GPT
                  example: arcanos-gaming
                gptVersion:
                  type: string
                  description: Optional version tag
                  example: 1.0.0
                prompt:
                  type: string
                  description: Natural language prompt to route to ARCANOS
                context:
                  type: object
                  description: Optional metadata (user, task type, priority)
              required:
                - gptId
                - prompt
      responses:
        "200":
          description: AI or module response
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/AskResponse"
components:
  schemas:
    AskResponse:
      type: object
      required:
        - result
      properties:
        result:
          type: string
          description: Primary AI or module-generated response
        module:
          type: string
          description: Handler or model used (fine-tuned, memory, RAG, etc.)
        meta:
          type: object
          description: Debug metadata (routing trace, time, tokens, etc.)
```

## 2. Create the Action
1. In the Custom GPT builder, open **Actions → Add new action**.
2. Choose **Import from OpenAPI schema** and paste the YAML above (or the updated production copy).
3. Ensure the builder displays a single `POST /ask` operation. If more routes appear, clear the action and re-import to avoid stale definitions.
4. Set **Authentication** to the service account method you provisioned (usually Bearer token). Store secrets in the GPT builder vault; never hard-code them inside the schema.
5. Click **Save**. OpenAI should now list the dispatcher action as `ask`.

## 3. Required GPT Instructions
Add the following bullets to the GPT’s system instructions so the model uses the dispatcher safely:
- Call the `ask` action whenever a user request needs ARCANOS automation or backend data.
- Always supply the correct `gptId` (e.g., `arcanos-gaming`, `arcanos-tutor`, etc.).
- Include a brief natural-language `prompt` summarizing the user’s request.
- Provide a `context` object only when auxiliary metadata is necessary (user id, priority, etc.).
- Mirror backend error messages to the user and pause automation until they confirm next steps.

## 4. Versioning & Modernization Tips
- **Stick with OpenAPI 3.1.0.** The current dispatcher uses JSON Schema vocabulary features that are only valid in 3.1. Downgrading to 3.0 removes `type: object` flexibility.
- **Keep examples current.** Update the `example` values (`gptId`, domain, version) whenever you introduce a new GPT or deploy to staging. Misleading examples cause the builder to cache invalid payloads.
- **Document optional fields.** `gptVersion` and `context` remain optional; do not mark them as required or the GPT will attempt to fabricate placeholder data.
- **Regenerate the action** after any backend contract change. The builder does not diff schemas, so deleting and re-importing prevents ghost fields.

## 5. Validation Checklist
Before publishing the GPT:
- Run `npm test -- src/routes/api-ask.ts` to confirm dispatcher coverage.
- Issue a manual `curl` against `/ask` with the new credentials to verify authentication and TLS.
- Trigger a dry-run conversation inside the GPT builder and confirm the action logs show a single `POST /ask` call with the expected payload.

Following this playbook keeps every Custom GPT aligned with the unified dispatcher and avoids regressions when the backend contract evolves.
