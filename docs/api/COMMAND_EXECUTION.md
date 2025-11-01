# Command Execution API

This guide explains how to issue commands to the ARCANOS backend over HTTP. The
command centre is exposed under the `/api/commands` namespace and allows trusted
clients to list available commands, inspect health data, and execute approved
commands with optional payloads.

## Base URL

All endpoints in this guide assume requests are sent to the running ARCANOS
service. For local development the default base URL is:

```
http://localhost:8080/api/commands
```

Adjust the host and port to match your deployment environment.

## Security Requirements

Command execution is protected by the `confirmGate` middleware. Every mutating
request (`POST /execute`) must include **either**:

- The header `x-confirmed: yes` indicating the action has explicit human
  approval, or
- A trusted GPT identifier in the `x-gpt-id` header (or `gptId` field in the
  request body). Trusted identifiers are configured through the
  `TRUSTED_GPT_IDS` environment variable.

Requests that do not satisfy one of these conditions receive a
`403 Confirmation required` response.

The route is also rate-limited to 50 requests per 15 minutes per IP address. If
you exceed this quota you will receive an HTTP 429 error until the window
resets.

## Available Endpoints

### `GET /`

Lists all commands currently registered with the command centre. Each entry
includes the command name, description, whether confirmation is required, and an
example payload.

**Example response**

```json
{
  "success": true,
  "commands": [
    {
      "name": "audit-safe:set-mode",
      "description": "Directly set the Audit-Safe enforcement mode.",
      "requiresConfirmation": true,
      "payloadExample": { "mode": "true" }
    },
    {
      "name": "audit-safe:interpret",
      "description": "Interpret a natural-language instruction to adjust Audit-Safe mode.",
      "requiresConfirmation": true,
      "payloadExample": { "instruction": "Enable strict audit safe mode" }
    },
    {
      "name": "ai:prompt",
      "description": "Execute an AI command through the centralized OpenAI routing pipeline.",
      "requiresConfirmation": true,
      "payloadExample": { "prompt": "Summarize current system status" }
    }
  ],
  "metadata": {
    "count": 3,
    "timestamp": "2024-10-30T12:30:00.000Z"
  }
}
```

### `GET /health`

Returns a lightweight status document confirming the command service is
reachable. The payload contains the current timestamp and the number of
commands registered.

```json
{
  "status": "ok",
  "timestamp": "2024-10-30T12:30:00.000Z",
  "availableCommands": 3
}
```

### `POST /execute`

Executes a specific command. The request body must be JSON with the fields:

- `command` – The command name exactly as listed by `GET /`.
- `payload` – (optional) An object containing command-specific parameters.

**Request example**

```bash
curl -X POST "http://localhost:8080/api/commands/execute" \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "command": "audit-safe:set-mode",
        "payload": { "mode": "passive" }
      }'
```

**Successful response**

```json
{
  "success": true,
  "command": "audit-safe:set-mode",
  "message": "Audit-Safe mode set to passive.",
  "output": { "mode": "passive" },
  "metadata": {
    "executedAt": "2024-10-30T12:30:05.000Z",
    "auditSafeMode": "passive"
  }
}
```

Validation errors return HTTP 400 with an explanatory message (for example,
missing `command` value or an invalid payload shape). Unknown commands also
produce a `success: false` response with `message: "Unsupported command."`.

If the `ai:prompt` command is executed without a configured OpenAI API key, the
response includes a mock result with `fallback: true` in the `output` field to
indicate that the system returned simulated data.

## Troubleshooting

- **403 Confirmation required** – Ensure you include `x-confirmed: yes` or
  provide a trusted GPT identifier via `x-gpt-id`/`gptId`.
- **429 Too Many Requests** – Reduce request volume or wait for the rate-limit
  window to reset.
- **400 Validation error** – Check that `command` is a string between 3 and 100
  characters and that the payload matches the command expectations.
- **500 Internal error** – Review server logs for additional context; the
  response body still includes the command name and timestamp for auditing.

## Related Source Files

- Express route: [`src/routes/api-commands.ts`](../../src/routes/api-commands.ts)
- Command implementations: [`src/services/commandCenter.ts`](../../src/services/commandCenter.ts)
- Confirmation middleware: [`src/middleware/confirmGate.ts`](../../src/middleware/confirmGate.ts)
