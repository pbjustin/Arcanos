# IDE and Cloud Agents

This doc describes how IDEs and cloud agents (Cursor, VS Code, GitHub Codespaces, etc.) can use the Arcanos codebase with full indexing and rules.

## Workspace file (Option B – multi-root, portable)

Open **`Arcanos.code-workspace`** (in the repo root) so the workspace root is this repo:

- **Cursor / VS Code:** File → Open Workspace from File → select `Arcanos.code-workspace`.
- **GitHub Codespaces:** Open the repo; the workspace file is in the root. Use File → Open Workspace from File → `Arcanos.code-workspace` so codebase indexing targets Arcanos.
- **Cloud agents:** When cloning this repo, open the workspace file (e.g. `Arcanos.code-workspace`) so the “codebase” for semantic search and rules is the Arcanos repo.

The workspace file lives **inside the repo** with a single folder `"."`, so it works on any machine or cloud clone (paths are relative).

## Rules and orientation

- **Project rules:** `.cursorrules` (server–daemon sync, API contract) and `AGENTS.md` (coding standards) apply when this workspace is open.
- **Quick map:** `CODEBASE_INDEX.md` lists entry points and key directories for AI/agent orientation.

## .cursorignore (focused indexing)

A project-level `.cursorignore` file is included in the repo root to keep the index focused on source code. It excludes dependencies (`node_modules/`), build artifacts (`dist/`), Python caches (`__pycache__/`), logs, and secrets. This ensures that Cursor and other agents index only relevant files.

You can review the contents of the [`.cursorignore`](../.cursorignore) file directly.

## Debugging the backend

- **Debug live code while backend is running:** Start the backend with `npm run dev:inspect`, then in the IDE run **Attach to Backend**. Breakpoints in `src/*.ts` will hit.
- **Launch under debugger:** IDE → **Backend (TS) Launch** (runs the `build` task first, then launches with inspector).
- **Debug Python daemon:** IDE → **Daemon (Python)**; breakpoints in `daemon-python/arcanos/*.py` will hit.
- **CLI debug server:** Run the CLI with the HTTP debug server so IDE agents can inspect the live daemon (status, logs, audit, ask/run/see). Use the **Daemon (Python)** launch configuration, or run `.\daemon-python\start_cli_debug.ps1` in a terminal. The server listens on `http://127.0.0.1:9999` (e.g. `GET /debug/status`, `GET /debug/logs?tail=100`). Set `DEBUG_SERVER_TOKEN` for authenticated endpoints. See [daemon-debugging.md](daemon-debugging.md) for all endpoints and security.

Configs: [`.vscode/launch.json`](../.vscode/launch.json), [`.vscode/tasks.json`](../.vscode/tasks.json). Script: `npm run dev:inspect`.

### Audit (verification)

**Pass criteria**

- Backend can be started with inspector enabled and VS Code can attach.
- Breakpoints in `src/**/*.ts` bind and hit during execution.
- Source maps resolve to TS (call stack shows `src/.../*.ts`).
- **Backend (TS) Launch** works (preLaunch build runs, server starts under debugger).
- (Optional) Python daemon breakpoints work.
- (Optional) CLI debug server responds at `http://127.0.0.1:9999/debug/status`.
- Docs are runnable by a new agent with no extra context.

**Manual checklist (3–5 min)**

1. **Inspector enabled:** Run `npm run dev:inspect`; confirm Node prints “Debugger listening …9229…”. VS Code → **Attach to Backend** (must attach cleanly).
2. **Breakpoints bind + hit:** Place breakpoint in `src/start-server.ts` (startup) and in a request handler (e.g. `/ask`). Trigger the path (curl/client). Pass if breakpoint hits in `.ts`.
3. **Source map integrity:** Call stack shows `src/.../*.ts`; stepping follows TS lines correctly.
4. **Launch config:** VS Code → **Backend (TS) Launch**; pass if preLaunch build runs and server starts under debugger.
5. **PORT:** Verify `PORT` env overrides default; otherwise uses 8080.
6. **Python daemon (optional):** VS Code → **Daemon (Python)**; breakpoints in `daemon-python/arcanos/cli.py` should hit. You can also verify the debug server is running by executing `curl http://127.0.0.1:9999/debug/status`, which should return JSON.

**Automatable checks (optional)**

- After `npm run build`, confirm `dist/**/*.js.map` exists and references `src/`.
- (Local) Confirm inspector port 9229 is listening while the process runs.

**CLEAR-style rubric**

- **Clarity:** Exact commands and config names in docs.
- **Leverage:** One script (`dev:inspect`) enables attach; launch config works too.
- **Efficiency:** Audit &lt;5 minutes.
- **Alignment:** No runtime logic changes, only tooling/config.
- **Resilience:** Works across OSes; stable sourcemap/outFiles mapping.

## User-level rule (workspace = home)

If you sometimes open the user home folder instead of Arcanos, a Cursor rule at `.cursor/rules/arcanos-context.mdc` (in your user config) tells the AI that the primary codebase is Arcanos under `Arcanos/`. That rule is optional and lives outside this repo.
