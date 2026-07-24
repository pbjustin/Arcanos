# Arcanos Python CLI (Local Daemon Agent)

## What it is

`daemon-python/` is the local companion to the Arcanos backend. It provides an interactive Python CLI that can:

- chat with the backend through canonical `/gpt/:gptId` module-bound traffic
- detect patch and command proposals and ask for approval before local execution
- maintain lightweight repository context for backend requests
- keep durable SQLite audit/history data and patch backups for rollback
- run an optional loopback-only bridge and debug server for local integrations

The daemon runs on the operator's machine. The TypeScript backend is the component deployed to Railway, Docker, or another service environment.

## Choose the intended `arcanos` executable

Two packages in this repository can install an executable named `arcanos`:

- `packages/cli/` provides the TypeScript `@arcanos/cli` command surface and also installs `arcanos-protocol`.
- `daemon-python/` provides this interactive Python daemon CLI.

Which `arcanos` command runs depends on the active environment and `PATH`. Use an unambiguous invocation when both packages are installed:

```bash
# Python daemon CLI
python -m arcanos.cli

# TypeScript CLI, after npm run build:packages
arcanos-protocol --help
node packages/cli/dist/index.js --help
```

See `../docs/CLI_OVERVIEW.md` for the TypeScript CLI.

## Routing boundary

The daemon preserves the backend writing/control-plane split:

- assistant chat and GPT/module-bound writing traffic use `/gpt/:gptId`
- system-state reads use the direct `/system-state` endpoint
- daemon coordination uses `/api/daemon/*`
- update checks use `/api/update`
- job, runtime, DAG, and other control-plane reads use their structured direct or `/gpt-access/*` endpoints

The daemon does not use legacy ask-style routes such as `/api/arcanos/ask` or `/query-finetune` for its active chat flow. Do not encode job lookups, runtime diagnostics, DAG inspection, or MCP control calls as prompt text sent to `/gpt/:gptId`.

High-level flow:

```text
You (terminal)
  -> Python CLI shell
  -> backend /gpt/<gpt-id> request with session and optional repo context
  -> response translator and proposal parser
  -> explicit patch/command review
  -> approved local action
  -> summarized tool result returned to the backend for the next loop step
```

## Prerequisites

- Python 3.10+
- `git` for patch validation and application
- an OpenAI API key
- a backend URL and credential for backend-routed operation

The current CLI startup validation requires `OPENAI_API_KEY` even when the selected conversation path routes through the backend. Treat this as a current implementation constraint.

## Install

From the repository root:

```powershell
cd daemon-python
python -m venv venv

.\venv\Scripts\Activate.ps1

python -m pip install -e .

# For daemon test/development work:
python -m pip install -e ".[dev]"

Copy-Item .env.example .env
```

On macOS/Linux, activate with `source venv/bin/activate` and copy the environment template with `cp .env.example .env`.

## Minimal backend-routed configuration

```env
OPENAI_API_KEY=your-openai-api-key
BACKEND_URL=https://<your-service>.up.railway.app
BACKEND_GPT_ID=arcanos-daemon
BACKEND_TOKEN=your-backend-token
BACKEND_ALLOW_GPT_ID_AUTH=false
```

`BACKEND_TOKEN` is the preferred daemon credential. `BACKEND_ALLOW_GPT_ID_AUTH` defaults to `false`; enable GPT-ID-only authentication only when the backend deployment explicitly allows and authorizes that trusted caller model.

The complete environment-variable reference is `../docs/CONFIGURATION.md`.

### Agentic coding features

```env
AGENTIC_ENABLED=true
AGENT_MAX_STEPS=6

REPO_INDEX_ENABLED=true
REPO_INDEX_MAX_FILES=800
REPO_INDEX_MAX_CHARS=50000

HISTORY_DB_PATH=history.db
PATCH_BACKUP_DIR=patch_backups
AUTOMATIONS_FILE=automations.toml

# Optional patch delimiters understood by the response translator
PATCH_TOKEN_START=---patch.start---
PATCH_TOKEN_END=---patch.end---
```

## Run

From `daemon-python/` with the virtual environment active:

```bash
python -m arcanos.cli
```

Use `arcanos` only when the active environment is known to resolve to the Python package.

## Module ownership

Keep orchestration and side effects in their existing owners:

| Module | Responsibility |
| --- | --- |
| `arcanos/cli/cli.py` | CLI orchestration, command routing, lifecycle wiring, and delegation. |
| `arcanos/cli/context.py` | Shared context models and local context helpers; no backend I/O or governance decisions. |
| `arcanos/cli/bootstrap.py` | Startup guards, first-run setup, update checks, and debug-server startup. |
| `arcanos/cli/state.py` | Trust/registry/session state hydration and prompt assembly; no direct backend I/O. |
| `arcanos/cli/backend_ops.py` | Backend HTTP operations and request metadata propagation. |
| `arcanos/cli/local_ops.py` | Local GPT, vision, voice, and multimodal flows; backend calls delegate to `backend_ops.py`. |
| `arcanos/cli/confirmation.py` | Confirmation prompts and approval/rejection flow. |
| `arcanos/cli/memory_ops.py` | Conversation persistence and summary state. |
| `arcanos/cli/daemon_ops.py` | Daemon thread lifecycle, polling, and command dispatch. |
| `arcanos/cli/ui_ops.py` | Rendering, tables/Markdown output, and speech replay. |
| `arcanos/cli/run_ops.py` | Terminal-command orchestration under governance and idempotency controls. |
| `arcanos/agentic/` | Repository indexing, proposal parsing, patch orchestration, history, and the multi-step loop. |
| `arcanos/assistant/translator.py` | Response translation and proposal extraction. |
| `arcanos/backend_client/` | Backend request clients and payload construction. |
| `arcanos/openai/` | Python-local unified client and adapter helpers for chat, streaming, vision, transcription, and embeddings. |

TypeScript owns the public protocol contract. Python consumes that contract behind the backend/protocol boundary and must not define a competing public shape.

The backend/CLI compatibility contract is `../contracts/backend_cli_contract.v1.json`. From the repository root, validate both sides with:

```bash
npm run validate:backend-cli:contract
npm run validate:backend-cli:offline
```

## Patch proposals

The backend can propose a patch in a fenced diff:

````text
```diff
diff --git a/path/to/file.py b/path/to/file.py
...
```
````

It can also use explicit delimiters:

```text
---patch.start---
diff --git a/path/to/file.py b/path/to/file.py
...
---patch.end---
```

Before application, the daemon:

1. validates target paths and patch content against `../config/cli-policy.json`
2. rejects secret-like paths, absolute paths, traversal, symlinks, binary patches, and `.git` targets
3. shows a redacted preview and the patch SHA-256
4. binds approval to the exact proposal
5. creates backups under `PATCH_BACKUP_DIR/<rollback_id>/` and applies with `git apply`

History stores hashes, summaries, approval state, rollback metadata, and a redacted preview; it does not store raw patch text.

Rollback:

```text
/rollback <rollback_id>
```

## Command proposal safety

The daemon has distinct command surfaces; they do not all use the same policy implementation.

### Policy-bound bridge and patch flow

The local bridge `/commands/run` path and patch orchestration use `../config/cli-policy.json`. The policy controls sandbox roots, allowed command prefixes, deny patterns, timeout caps, output redaction/truncation, and patch safety. Bridge command approval is bound to the exact normalized command, working directory, and `proposalId`; changing any of those values invalidates the proposal. Policy load failure closes these paths.

### Inline agentic command flow

Commands extracted from assistant responses use the terminal safety layer:

- high-risk shell-token rejection
- `COMMAND_WHITELIST` and dangerous-command checks
- the `ALLOW_DANGEROUS_COMMANDS` override when deliberately configured
- a final interactive `Run command? [y/N]` prompt

Approval in one surface does not authorize a changed command or bypass the checks in another surface.

## Local bridge safety

The optional HTTP bridge:

- binds only to `127.0.0.1`, `localhost`, or `::1`
- requires `ARCANOS_CLI_BRIDGE_TOKEN` for POST requests
- accepts only `application/json`
- enforces request limits, a sandboxed working directory, timeout/output caps, redaction, and deterministic errors
- never returns raw tracebacks

Rotate the bridge token by replacing it in the daemon and calling-process environments, then restart both processes. Disable bridge execution by stopping the bridge, omitting its token, or setting backend `ARCANOS_CLI_BRIDGE_ENABLED=false`.

## Local debug server

The optional debug HTTP server binds to `127.0.0.1` and is not a Railway service.

```env
DEBUG_SERVER_ENABLED=true
DEBUG_SERVER_PORT=9999
DEBUG_SERVER_TOKEN=your-strong-random-token
```

`IDE_AGENT_DEBUG=true` and `DAEMON_DEBUG_PORT=<port>` remain compatibility toggles. The read-only `/debug/health`, `/debug/ready`, and `/debug/metrics` endpoints are unauthenticated. All other debug endpoints require one of:

- the configured automation-secret header
- a valid single-use `x-arcanos-confirm-token`
- `Authorization: Bearer your-debug-server-token`
- `X-Debug-Token: your-debug-server-token`

Query-string token authentication is disabled by default and should remain disabled. Use `GET /debug/help` for the live endpoint catalog; it includes status, instance/chat/log/audit/crash inspection and the authenticated `/debug/ask`, `/debug/run`, and `/debug/see` operations.

Example:

```bash
curl http://127.0.0.1:9999/debug/health
curl -H "X-Debug-Token: $DEBUG_SERVER_TOKEN" http://127.0.0.1:9999/debug/status
```

## Audit, history, and multi-step behavior

Audit events contain sanitized metadata. Command output is redacted and truncated before history storage. Patch history stores redacted previews and hashes rather than raw patch text, and audit exports omit command output and raw patches.

When a response contains proposals, the agent loop:

1. performs only actions the operator approves
2. summarizes results
3. sends the result back to the backend
4. repeats until no new proposal remains or `AGENT_MAX_STEPS` is reached

## Async backend client flow

Python clients use structured writing and control-plane operations:

- `BackendApiClient.request_query(...)`
- `BackendApiClient.request_query_and_wait(...)`
- `BackendApiClient.request_gpt_job_status(...)`
- `BackendApiClient.request_gpt_job_result(...)`

The query methods create writing work through the GPT route. Status and result methods read the job through direct control-plane endpoints. These wrappers normalize fields such as `ok`, `action`, `jobId`, `status`, and `result`/`output` when available.

## Built-in CLI commands

- `/open <path>`: print a file
- `/auto <name>`: run an automation with approval per step
- `/history` or `/patchlog`: show recent patches and rollback IDs
- `/rollback <rollback_id>`: restore files from backups
- `/audit export <path> [--all]`: export audit history as JSON
- `/intents`: show the last detected proposals
- `/dryrun on|off`: proposal-only mode
- `/safemode on|off`: block patch/command execution until disabled
- `/feedback <rollback_id> <rating 1-5> <note...>`: record patch feedback

## Troubleshooting

- Startup rejects configuration: set `OPENAI_API_KEY`; current validation requires it before the CLI starts.
- Backend route failure: verify `BACKEND_URL`, backend health, `BACKEND_TOKEN`, and the configured GPT ID.
- `410 Gone` from an old ask-style route: move writing calls to `/gpt/<gpt-id>`.
- System-state failure: verify the direct `/system-state` endpoint and backend authorization.
- Patch application failure: verify the repository is a Git worktree and that patch paths are valid.
- Debug-server `401`: configure one supported authentication method and send the matching header.
- Unexpected `arcanos` behavior: check which executable resolves on `PATH`, then use one of the unambiguous invocations above.

## References

- `../README.md`
- `../docs/CLI_OVERVIEW.md`
- `../docs/CONFIGURATION.md`
- `../docs/SCHEMA_PROTOCOL_GUIDE.md`
- `../contracts/backend_cli_contract.v1.json`
