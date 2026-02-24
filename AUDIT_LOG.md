# AUDIT LOG — Arcanos Refactor & Optimization

> All entries follow the format: **Change · Reason · Verification**

---

## Pass 0 — Inventory & Dead-Code Flagging

**Date:** 2026-02-24  
**Scope:** Full repository (TypeScript backend, Python daemon, workers, deployment config)

### Findings

| Area | Status | Notes |
|------|--------|-------|
| TypeScript OpenAI SDK | ✅ Current (v6.16.0) | `src/core/adapters/openai.adapter.ts` is the canonical boundary; v6 `chat.completions.create` pattern used throughout |
| Python OpenAI SDK | ✅ Current (v1.x) | `daemon-python/arcanos/openai/openai_adapter.py` uses `client.chat.completions.create`; no v0-style `openai.ChatCompletion.create` calls found |
| Workers OpenAI SDK | ✅ Current (v6.x) | `workers/src/infrastructure/sdk/openai.ts` wraps v6 client with proper adapter pattern |
| Railway deployment | ⚠️ Misaligned start command | `railway.json` deploy `startCommand` omitted `dist:repair-aliases` and `esm-alias-loader.mjs`; `npm start` includes both |
| `collected-ts/` directory | ❌ Dead artifact | Archive directory with 2 files; not imported by any build, test, or runtime script; only referenced in `backend-index.json` index |
| `cli_v2/live_test_v2.py` | ❌ Dev-only test file | Local development harness; not part of production runtime; explicitly documented as experimental |
| `workers/package.json` openai | ⚠️ Minor version drift | Listed `^6.15.0` while root specifies `^6.16.0` |

---

## Pass 1 — Remove Unused Files & Modules

### Action 1.1 — Remove `collected-ts/` directory

- **Change:** Deleted `collected-ts/src/config/prompts.ts` and `collected-ts/tests/prompts-system.test.ts` and their parent directories.
- **Reason:** `collected-ts/` is a refactoring artifact directory (collected/archived TypeScript files). It is not referenced by any build system, test runner, ESLint config, or import statement. Keeping it creates confusion about authoritative sources.
- **Verification:** `grep -r "collected-ts" . --include="*.ts" --include="*.js"` returns no results outside `backend-index.json` (which was also updated).

### Action 1.2 — Remove `cli_v2/live_test_v2.py`

- **Change:** Deleted `cli_v2/live_test_v2.py`.
- **Reason:** A development-only test harness explicitly marked experimental in `README.md` and `docs/CLI_CONSOLIDATION.md`. It is not imported from any production module. The `cli_v2/` directory itself is kept as it contains the experimental CLI v2 architecture.
- **Verification:** `grep -r "live_test_v2" daemon-python/ src/` returns no results.

### Action 1.3 — Update `backend-index.json`

- **Change:** Removed `collected-ts` scope entry from `backend-index.json`.
- **Reason:** `collected-ts/` was deleted (Action 1.1); the index entry pointed to files that no longer exist.
- **Verification:** `backend-index.json` no longer contains `"scope": "collected-ts"`.

---

## Pass 2 — OpenAI SDK Alignment

### Action 2.1 — Align workers OpenAI SDK version

- **Change:** Updated `workers/package.json` `openai` from `^6.15.0` → `^6.16.0`.
- **Reason:** Root `package.json` specifies `^6.16.0`. Workers run in the same runtime environment. Consistent pinning reduces ambiguity and ensures both stacks resolve the same patch release.
- **Verification:** Both `package.json` and `workers/package.json` now specify `openai: "^6.16.0"`.

### SDK Compliance Summary

| Stack | SDK Version | Pattern Used | Status |
|-------|------------|--------------|--------|
| TypeScript (src/) | openai v6.16.0 | `client.chat.completions.create()` via `OpenAIAdapter` | ✅ Compliant |
| Python (daemon-python/) | openai v1.x | `client.chat.completions.create()` via `openai_adapter.py` | ✅ Compliant |
| Workers | openai v6.16.0 | `client.chat.completions.create()` via `WorkerOpenAIAdapter` | ✅ Compliant |

No legacy patterns (`openai.ChatCompletion.create`, `openai.Completion.create`, `new Configuration()`, `OpenAIApi`) were found in any active code path.

---

## Pass 3 — Railway Deployment Hardening

### Action 3.1 — Align `railway.json` start command with `npm start`

- **Change:** Updated `railway.json` `deploy.startCommand` from:
  ```
  node --max-old-space-size=7168 dist/start-server.js
  ```
  to:
  ```
  npm run dist:repair-aliases && node --loader ./scripts/esm-alias-loader.mjs --max-old-space-size=7168 dist/start-server.js
  ```
- **Reason:** The `npm start` script includes both `dist:repair-aliases` (which rewrites any unresolved TypeScript path aliases in `dist/`) and the ESM alias loader (runtime alias resolution fallback). The previous `railway.json` start command lacked these, creating a divergence between local `npm start` behavior and Railway production. If `tsc-alias` misses any alias during build, the Railway deploy would crash with module-not-found errors while `npm start` would succeed.
- **Verification:** `railway.json` `deploy.startCommand` now matches the alias repair + loader pattern used by `npm start`.

### Railway Config Summary

| Setting | Value | Notes |
|---------|-------|-------|
| Builder | NIXPACKS | ✅ Correct for Railway |
| Build command | `npm ci --include=dev --no-audit --no-fund && npm run build` | ✅ Includes workers build + tsc-alias |
| Start command | `npm run dist:repair-aliases && node --loader ... dist/start-server.js` | ✅ Now aligned with npm start |
| Health check | `/health` (300s timeout) | ✅ Configured |
| Port | `$PORT` (Railway-injected) | ✅ Correct |
| Memory | `--max-old-space-size=7168` (deploy), `2048` (build) | ✅ Production-appropriate |
| Restart policy | `ON_FAILURE` (max 10 retries) | ✅ Resilient |

---

## Pass 4 — Structure & Modularization Review

### Findings

| Module | Status | Notes |
|--------|--------|-------|
| `src/core/adapters/openai.adapter.ts` | ✅ Canonical boundary | All route/service OpenAI calls should route here |
| `src/services/openai/unifiedClient.ts` | ✅ Clean singleton | Credential resolution + circuit breaker + health checks |
| `daemon-python/arcanos/openai/` | ✅ Modular | `unified_client.py` + `openai_adapter.py` + `request_builders.py` |
| `workers/src/infrastructure/sdk/openai.ts` | ✅ Worker-isolated | Separate adapter for worker runtime |
| `src/platform/runtime/env.ts` | ✅ Centralized env access | Only module accessing `process.env` directly |
| `daemon-python/arcanos/env.py` | ✅ Centralized env access | Python equivalent |
| `railway/` directory | ✅ Present | Railway-specific overrides |
| `.railwayignore` | ✅ Present | Excludes node_modules, dist, .env, logs |

No further structural refactoring was required — the codebase already follows the adapter-first, centralized-config, Railway-native patterns specified in the problem statement.

---

## Summary of All Changes

| File | Action | Pass |
|------|--------|------|
| `collected-ts/` (directory) | Deleted | 1 |
| `cli_v2/live_test_v2.py` | Deleted | 1 |
| `backend-index.json` | Removed `collected-ts` scope | 1 |
| `workers/package.json` | `openai` `^6.15.0` → `^6.16.0` | 2 |
| `railway.json` | Start command aligned with `npm start` | 3 |
| `AUDIT_LOG.md` | Created (this file) | 4 |

---

## Features Preserved

All supported features were preserved. No route handlers, service modules, database interactions, worker logic, or CLI commands were removed or modified.

**Removed items were confirmed dead by:**
- No imports from the deleted paths in any active source file
- No reference in build scripts (tsconfig, jest.config, eslint.config)
- No runtime usage in production code paths
- Explicit documentation marking them as experimental/artifact
