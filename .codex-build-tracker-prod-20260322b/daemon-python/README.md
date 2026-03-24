# Arcanos Python CLI (Local Daemon Agent)

## What it is
`daemon-python/` is the **local companion** to the Arcanos backend. It gives you an interactive CLI that can:
- chat with your backend using generic `/ask` for daemon chat and `/gpt/:gptId` for module-bound GPT traffic
- **detect inline patches** (unified diffs) in AI responses and immediately prompt **“Apply patch? [y/N]”**
- **detect command proposals** and prompt **“Run? [y/N]”** (allowlisted)
- maintain **repo awareness** (light repo indexing injected into backend requests)
- keep a durable **audit/history log** (SQLite) with rollback support

> The daemon is meant to run **locally** (your machine). The backend is what you deploy (Railway, Docker, etc.).

## Where it fits in the overall codebase
- Backend (TypeScript/Express): `src/`  
  - Primary endpoints: `/ask`, `/gpt/:gptId`, `/api/ask`, `/query-finetune`
- Local daemon (Python): `daemon-python/`  
  - CLI runtime: `daemon-python/arcanos/cli/`
  - Agentic coding loop: `daemon-python/arcanos/agentic/`
  - Response translation layer: `daemon-python/arcanos/assistant/translator.py`

## Architecture (high level)

```
You (terminal)
  ↓
Arcanos CLI shell (daemon-python/arcanos/cli)
  ↓
Backend request with:
  - generic daemon chat → `/ask`
  - GPT/module-bound traffic → `/gpt/<gpt-id>`
  - sessionId=<machine/user instance>
  - context.repoIndex (optional)
  ↓
Raw AI response
  ↓
Translator (cleans narration + extracts proposals)
  ↓
Proposal router:
  - patch → preview → approve → git apply (+ backup + rollback_id)
  - command → preview → approve → run allowlisted command
  ↓
Tool results fed back to backend for the next step (multi-step loop)
```

## Prerequisites
- Python 3.10+
- `git` installed (patch application uses `git apply`)
- OpenAI API key **if** you use direct OpenAI routing
- Backend URL/token **if** you route through the backend (recommended for `arcanos-daemon`)

## Install
From repository root:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
cp .env.example .env
```

## Configuration

### Minimal (backend-routed assistant)
```env
BACKEND_URL=https://acranos-production.up.railway.app
BACKEND_GPT_ID=arcanos-daemon
BACKEND_ALLOW_GPT_ID_AUTH=true
```

### Agentic coding assistant features
```env
AGENTIC_ENABLED=true
AGENT_MAX_STEPS=6

REPO_INDEX_ENABLED=true
REPO_INDEX_MAX_FILES=800
REPO_INDEX_MAX_CHARS=50000

HISTORY_DB_PATH=history.db
PATCH_BACKUP_DIR=patch_backups
AUTOMATIONS_FILE=automations.toml

# Optional patch tokens (backend may emit these)
PATCH_TOKEN_START=---patch.start---
PATCH_TOKEN_END=---patch.end---
```

### Optional backend token auth
```env
BACKEND_TOKEN=your-backend-token
```

## Run
```bash
arcanos
# or
python -m arcanos.cli
```

## How patch proposals work

The backend can propose edits in either of these formats:

**A) Markdown fenced diff**
```diff
diff --git a/path/to/file.py b/path/to/file.py
...
```

**B) Explicit patch tokens**
```
---patch.start---
diff --git a/path/to/file.py b/path/to/file.py
...
---patch.end---
```

The CLI will:
1) extract patches
2) show a preview
3) prompt: **Apply patch? [y/N]**
4) on approval: create backups in `PATCH_BACKUP_DIR/<rollback_id>/...` and apply via `git apply`

Rollback:
```text
/rollback <rollback_id>
```

## How command proposals work
Commands are detected from:
- ```bash fenced blocks
- a simple `Command:` suggestion

The CLI prompts **Run? [y/N]** and executes only allowlisted commands.

## Multi-step reasoning loop
When the assistant proposes patches/commands, the CLI:
- executes only what you approve
- then sends a summarized tool-result message back to the backend
- repeats up to `AGENT_MAX_STEPS` or until no new actions are proposed

## Built-in CLI commands
- `/open <path>`: print a file
- `/auto <name>`: run an automation from `AUTOMATIONS_FILE` (approval per step)
- `/history` or `/patchlog`: show recent patches (rollback ids)
- `/rollback <rollback_id>`: restore files from backups
- `/audit export <path> [--all]`: export audit history as JSON
- `/intents`: show last detected proposals
- `/dryrun on|off`: proposal-only mode (no applying/running)
- `/safemode on|off`: block patch/exec until turned off
- `/feedback <rollback_id> <rating 1-5> <note...>`: store feedback about a patch

## Troubleshooting
- Backend route failures: verify `BACKEND_URL`, backend health, and auth headers.
- Patch apply fails: ensure repo is a `git` repo and patch paths are correct.
- Safe mode triggered: use `/safemode off` after reviewing failures and logs.
- History DB location: controlled by `HISTORY_DB_PATH`.

## References
- `../README.md`
- `../QUICKSTART.md`
- `../docs/CONFIGURATION.md`
- `../docs/CLI_CONSOLIDATION.md`
- `DEBUG_SERVER_README.md`
