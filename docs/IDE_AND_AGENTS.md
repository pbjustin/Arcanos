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

A project-level `.cursorignore` in the repo root keeps the index focused on source (excludes `node_modules/`, venvs, `__pycache__/`, `dist/`, logs, secrets). If `.cursorignore` is missing, create it in the repo root with the contents from the “.cursorignore template” section below so Cursor and agents index only relevant files.

### .cursorignore template

Copy into `Arcanos/.cursorignore` if the file does not exist:

```
# Dependencies and build (keep index focused on source)
node_modules/
.npm
dist/
build/
*.tsbuildinfo
coverage/
*.lcov
.eslintcache

# Python env and caches
daemon-python/venv/
daemon-python/.venv/
**/__pycache__/
**/.pytest_cache/
*.py[cod]
*.pyo
*.pyd
.pytest_cache/
.tox/
.coverage
htmlcov/

# Logs and runtime artifacts (not useful for codebase understanding)
logs/
*.log
pids
*.pid
*.seed
*.pid.lock
tmp/
temp/
daemon-python/temp/
daemon-python/cache/
daemon-python/crash_reports/
daemon-python/telemetry/
daemon-python/backups/
daemon-python/screenshots/
*.db

# Secrets and env (never index)
.env
.env.*
!.env.example
**/secrets/
**/private_keys/
**/*.pem
**/*.key
**/*.pfx
**/*.p12

# Large/generated or third-party content
daemon-python/build_pyi/
daemon-python/dist_new/
installer/dist_new/
build_pyi/
dist_new/
/src/generated/prisma
```

## User-level rule (workspace = home)

If you sometimes open the user home folder instead of Arcanos, a Cursor rule at `.cursor/rules/arcanos-context.mdc` (in your user config) tells the AI that the primary codebase is Arcanos under `Arcanos/`. That rule is optional and lives outside this repo.
