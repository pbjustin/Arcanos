# Custom GPT Integration Overview

The ARCANOS Custom GPT integration links deployed backend modules with OpenAI’s Custom GPT features. Use this document to confirm prerequisites and the mandatory setup checklist.

## Requirements
- OpenAI account with Custom GPT support.
- ARCANOS backend deployed (Railway, Vercel, etc.).
- Custom GPT API key and endpoint configuration.
- Fine-tuned model deployed via the OpenAI API.

## Integration Checklist
1. **Map the GPT ID to a backend module** using `GPT_MODULE_MAP` (or legacy `GPTID_*`). Example:
   ```bash
   GPT_MODULE_MAP='{"gpt-backstage":{"route":"backstage","module":"BACKSTAGE:BOOKER"}}'
   ```
2. **Document allowed endpoints** in the GPT Builder instructions. Include HTTP verb, full URL, and routing cue (e.g., `POST https://<host>/backstage/book-gpt → BACKSTAGE:BOOKER`).
3. **State required headers and confirmation flow.** Protected routes expect manual confirmation via `x-confirmed: yes` or trusted automation via `x-gpt-id` that matches `TRUSTED_GPT_IDS`.
4. **Describe fallback and error handling.** Instruct the GPT to surface backend errors, pause automation, and wait for user guidance before retrying.
5. **Echo pipeline traces when required.** Backstage audit logs, Tutor pipeline, and Gaming audit trace should mirror backend expectations.
