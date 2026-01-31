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

## User-level rule (workspace = home)

If you sometimes open the user home folder instead of Arcanos, a Cursor rule at `.cursor/rules/arcanos-context.mdc` (in your user config) tells the AI that the primary codebase is Arcanos under `Arcanos/`. That rule is optional and lives outside this repo.
