# ARCANOS Core advisory bridge

## Purpose

`arcanos_core.consult` is a standalone stdio MCP tool for bounded architecture and security review by the existing `arcanos-core` backend AI. It does not import or start the ARCANOS application server, broad MCP registry, workers, database clients, Redis clients, or a local OpenAI client.

The bridge is locally observational, but it is not a read-only remote operation: each new consultation creates a durable GPT Access job. The MCP tool therefore intentionally has no `readOnlyHint`. It is marked non-destructive and idempotent because equivalent requests use a versioned SHA-256 request fingerprint.

## Fixed boundary

- GPT identity: `arcanos-core`
- Create operation: `POST /gpt-access/jobs/create`
- Result operation: `POST /gpt-access/jobs/result`
- Transport: an exact configured HTTPS origin; redirects are rejected
- Authentication: bearer credential supplied only through the bridge process environment
- Tool input: `task`, optional `context`, and optional bounded `maxOutputTokens`

The caller cannot provide a host, endpoint, token, headers, GPT identity, transport, or proxy. The bridge rejects credential-shaped prompt content before network access. It accepts only JSON responses, streams them through a byte cap, applies request timeouts and bounded polling, and returns fixed public errors without remote exception details.

## Configuration and startup

Inject these variables into the local stdio process without writing their values to repository files or command output:

- `ARCANOS_CORE_ADVISORY_BASE_URL`: exact remote HTTPS origin, with no path, query, fragment, or user information
- `ARCANOS_CORE_ADVISORY_ACCESS_TOKEN`: an existing GPT Access credential of 16 to 4096 characters; the target gateway must have only the required `jobs.create` and `jobs.result` scopes enabled for this use

Start only the narrow bridge:

```text
npm run mcp:arcanos-core-advisory
```

The primary command runs the compiled entrypoint after the repository build. For source-level local iteration, use `npm run mcp:arcanos-core-advisory:dev`.

Do not start `mcp:stdio` for advisory use: that entrypoint loads the broad application MCP context. Do not pass an OpenAI key to this bridge. Provider initialization and job execution occur only in the already deployed backend runtime.

## Disclosure and residual risk

The bridge redacts common credential-shaped values, omits sensitive or credential-shaped response keys, and omits unsafe trace identifiers before polling or output. It never includes raw dependency errors in MCP output and never logs the token or request/response body. Advisory prompts must still contain only sanitized findings.

The backend gateway currently authorizes job-result reads through its existing GPT Access credential and job-origin marker. This bridge polls only the job ID returned by its own create call, but it cannot independently prove per-principal job ownership. That backend authorization limitation remains outside this narrow bridge.
