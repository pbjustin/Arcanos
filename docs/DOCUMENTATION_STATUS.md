# Documentation Status Report

> **Generated:** 2025-11-25
> **Project:** Arcanos Backend
> **Version:** 1.0.0

## Overview

The November 2025 audit refreshed the public-facing documentation to match the
current runtime and removed redundant files. The README now reflects the actual
npm scripts and active endpoints, the documentation index records the latest
cleanup, and the configuration guide metadata matches the current release.

## Repository Snapshot

- **TypeScript source files:** 203 (`find src -type f -name "*.ts"`)
- **Markdown docs in `docs/`:** 90 (`find docs -type f -name "*.md"`)
- **Mounted routers:** `/api/assistants`, `/api/afol`, `/api/codebase`,
  `/api/openai`, `/api/pr-analysis`, `/api/commands`, `/api/memory`, `/api/sim`,
  and core conversation routes are registered in
  `src/routes/register.ts`.

## Recent Documentation Updates

- **README:** Quick-start scripts now describe the non-watch `dev` flow and the
  `dev:watch` build helper, and API highlights list assistants, AFOL, codebase,
  and OpenAI passthrough routes.
- **Documentation index:** Metadata updated to November 2025 with an archive
  list that reflects the latest cleanup work.
- **Configuration guide:** Metadata refreshed to the current audit date.
- **Cleanup:** Removed the duplicate `docs/CHANGELOG.md` in favor of the root
  changelog.

## Pending Follow-Ups

- **AFOL documentation:** Add `/api/afol/execute` usage guidance to
  `docs/api/README.md` and cross-link from architecture guides so the Adaptive
  Failover Orchestration Layer is discoverable alongside other `api/*` routes.
- **Devops endpoints:** Capture `/api/test` and `/api/fallback/test` behaviour in
  the diagnostics documentation to mirror the health surfaces registered in
  `src/routes/register.ts`.
- **Examples & samples:** Extend the API guides with request/response snippets
  for assistants, codebase diffing, and OpenAI passthrough routes so they align
  with the mounted routers listed above.
