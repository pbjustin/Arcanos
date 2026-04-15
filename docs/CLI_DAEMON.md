# Python CLI Daemon (arcanos-daemon)

## Purpose
The Python CLI in `daemon-python/` is a **local** agent that connects to the Arcanos backend and provides a “personal AI assistant” experience in the terminal.

It is designed to behave like a coding assistant:
- the backend **proposes** changes (patches / commands)
- the CLI **asks for approval** in the terminal before any local action
- the CLI applies patches safely with backups and supports rollback
- the CLI can iterate with a **multi-step loop** until the task is complete

## Contracts (what the daemon sends to the backend)

The daemon calls the backend with this routing split:
- generic daemon chat/state → `/ask`
- module-bound writing traffic → `/gpt/:gptId`
- control-plane reads and ops → direct endpoints such as `/jobs/:id`, `/jobs/:id/result`, `/status`, `/workers/status`, `/worker-helper/health`, `/status/safety/self-heal`, `/api/arcanos/dag/*`, and `/mcp`
- legacy compatibility callers may still use `/api/ask` when intentionally targeting that compatibility layer

CLI examples:
- `arcanos query --gpt arcanos-core --prompt "Draft the release summary"` → writing plane through `/gpt/:gptId` with canonical `action: "query"`
- `arcanos query-and-wait --gpt arcanos-core --prompt "Draft the release summary"` → writing plane through `/gpt/:gptId` with canonical `action: "query_and_wait"`
- `arcanos generate-and-wait --gpt arcanos-core --prompt "Draft the release summary"` → writing plane through `/gpt/:gptId`
- `arcanos job-status <job-id>` → direct control read through `GET /jobs/:id`
- `arcanos job-result <job-id>` → direct control read through `GET /jobs/:id/result`

Do **not** send Custom GPT payloads with `gptId` to `/ask`; the backend rejects that contract on purpose.
Do **not** send job lookups, DAG traces, runtime diagnostics, or MCP tool calls through `/gpt/:gptId` as prompt text; that route is reserved for the writing plane, and retrieval must stay structured through `action + jobId`.

For generic daemon chat, the daemon sends:
- `sessionId`: stable local instance id (machine/user)
- `prompt`: the user’s message
- `context.repoIndex`: lightweight repository index (when enabled)

Example payload:
```json
{
  "sessionId": "host:user",
  "prompt": "Fix failing tests",
  "context": {
    "repoIndex": {
      "repoRoot": "...",
      "filesCount": 523,
      "languages": {"python": 220, "markdown": 18},
      "keyFiles": ["README.md", "pyproject.toml"],
      "samplePaths": ["daemon-python/arcanos/cli/cli.py", "..."]
    }
  }
}
```

## Contracts (what the backend returns)

The daemon supports **inline proposals** inside normal assistant text:

### Patch proposals
- Markdown fenced blocks:
  - ```diff ... ```
- Explicit delimiters:
  - `---patch.start---` … `---patch.end---`

The daemon extracts proposals and shows a prompt:
- `Apply patch? [y/N]`

### Command proposals
- ```bash blocks
- `Command:` suggestions

The daemon prompts:
- `Run command? [y/N]`

Commands are executed through an allowlist safety check.

## Multi-step agent loop
When proposals are present, the daemon:
1. applies/runs what the user approves
2. summarizes tool results
3. sends a follow-up prompt back to the backend
4. repeats up to `AGENT_MAX_STEPS`

This enables test → patch → retest style iterations.

## Audit, history, rollback
The daemon persists:
- messages
- patches (with rollback ids and hashes)
- commands (stdout/stderr)

Rollback restores backed-up files from `PATCH_BACKUP_DIR/<rollback_id>/...`.

## Relevant source directories
- `daemon-python/arcanos/cli/`: interactive shell + approvals + slash commands
- `daemon-python/arcanos/agentic/`: repo indexing, proposals parsing, patch orchestration, history DB, agent loop
- `daemon-python/arcanos/assistant/translator.py`: response translation middleware
- `daemon-python/arcanos/backend_client/`: backend HTTP client and payload builder

## Async GPT Bridge
Agent and tool clients now have one canonical async flow:

1. `arcanos query --gpt <gpt-id> --prompt "..."` to create one durable writing job.
2. `arcanos query-and-wait --gpt <gpt-id> --prompt "..." --timeout-ms 25000 --poll-interval-ms 500` when a fast inline completion is useful.
3. `arcanos job-status <job-id>` to read lifecycle state on the control plane.
4. `arcanos job-result <job-id>` to read the terminal result on the control plane.

Lane ownership:
- Writing plane: `query`, `query-and-wait`, `generate-and-wait`
- Control plane: `job-status`, `job-result`

Python client parity:
- `BackendApiClient.request_query(...)`
- `BackendApiClient.request_query_and_wait(...)`
- `BackendApiClient.request_gpt_job_status(...)`
- `BackendApiClient.request_gpt_job_result(...)`

These wrappers normalize the async payload into a consistent shape with top-level `ok`, `action`, `jobId`, `status`, and `result`/`output` fields where available.
