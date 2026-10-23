# Contributing to Arcanos

## Overview
This guide covers contribution workflow for:
- TypeScript backend/runtime in `src/`
- Shared protocol, CLI, runtime and OpenAI packages in `packages/`
- TypeScript workers in `workers/`
- Standalone BullMQ/Redis runtime in `arcanos-ai-runtime/`
- Python daemon in `daemon-python/`
- iOS client in `clients/ios/` ([client guidance](clients/ios/README.md))

OpenAI integrations are adapter-first and centralized. New runtime code should not instantiate SDK clients outside the canonical constructor modules.

## Prerequisites
- Git
- Exact Node.js 24.18.1 with its bundled npm 11.16.0.
- Optional: Python 3.10+ for daemon changes

## Quick Start (Full Stack)
```bash
# Clone and install everything
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
cp .env.example .env

# Python daemon (optional — needed for CLI work)
cd daemon-python
python -m venv venv
# Windows PowerShell:  .\venv\Scripts\Activate.ps1
# macOS/Linux:         source venv/bin/activate
python -m pip install -e ".[dev]"
cp .env.example .env
cd ..

# Build and verify
npm run build
npm test
```

If you only work on the TypeScript backend, skip the Python steps above.

Use `npm install` for local development. CI and Railway use reproducible `npm ci` installs. The Docker image uses the install sequence declared in `Dockerfile`, which currently combines `npm ci --omit=dev` with a later development-dependency install for the build stage.

Both npm install paths run `scripts/postinstall.cjs`; local setup may create
missing Git hooks and editor/workspace tooling through `setup-auto-sync.js`.
Inspect those effects before installing into a checkout with existing tooling.
Installation requires package-registry access. Do not overwrite an existing
`.env`; the copy examples are for a new checkout. In PowerShell, use
`Copy-Item .env.example .env` instead of the shell-specific `cp` spelling.

## Setup (Step by Step)
```bash
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
cp .env.example .env
```

Optional daemon setup:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
cp .env.example .env
cd ..
```

## Run locally
Backend:
```bash
npm run build
npm start
```

Daemon (optional):
```bash
cd daemon-python
arcanos
```

## Configuration
- Backend minimum:
  - `PORT=3000`
  - `OPENAI_API_KEY=your-openai-api-key-here` (optional for mock-mode tests)
- Daemon minimum:
  - `OPENAI_API_KEY=your-openai-api-key-here`
- Keep secrets out of git. Use placeholders in all `*.env.example` files.

## Required Local Validation
This is the canonical change-area validation matrix for contributors and repository
agents. Combine the affected rows, deduplicate commands, and expand for
cross-cutting or release-sensitive work. Inspect current command definitions,
selected tests, and their owning workflows before execution.

Run npm workspace commands from the repository root with the pinned Node/npm
toolchain. TypeScript/Jest needs installed development dependencies. Direct Jest
also needs current shared-package builds (`npm run build:packages`); unlike
`npm test`, it does not build them. Select actual files with
`node scripts/run-jest.mjs --runTestsByPath <actual-file> --coverage=false`.
Inspect `scripts/test-env.mjs` and selected suites: the wrapper does not make
every integration test offline.

| Change area | Minimum relevant checks |
| --- | --- |
| Documentation only | `npm run docs:check`, `npm run docs:links -- --local-only`, and `git diff --check -- <changed-documentation-paths>`; verify commands, paths, and policy against source |
| Root TypeScript/backend | `npm run type-check`, `npm run lint`, and focused Jest |
| Broad root behavior | `npm run build` and `npm test` (or the split `npm run test:all`) |
| Protocol/CLI or TypeScript-Python boundary | `npm run type-check`, `npm run lint`, protocol-focused Jest, `npm run validate:backend-cli:contract`, `npm run validate:backend-cli:offline`, and `npm run sync:check` |
| `workers/` | `npm run build:workers`, `npm run lint`, and focused Jest where applicable |
| Root job runner or `src/workers/` | `npm run build`, `npm run lint`, and focused Jest; add applicable PostgreSQL tests for storage/concurrency changes |
| `arcanos-ai-runtime/` | `npm run test:runtime-integration` builds the runtime and runs selected integration/security/lifecycle `node:test` suites; smoke and real-Redis suites are separate. Also run `npm run lint` |
| Python daemon | Relevant `python -m pytest daemon-python/tests/<test_file>.py -q`; add `npm run validate:backend-cli:offline` for contract changes |
| Railway configuration/startup | `npm run build` and the local, non-deploying `npm run validate:railway` |
| Database/schema code | `npm run type-check`, focused database/route Jest, and `npm run validate:railway`; add relevant disposable PostgreSQL integration coverage. Do not apply a migration as routine validation |
| `scripts/` or GitHub workflows | Identify the actual owning runner and affected `node --test` suites or existing npm wrappers, workflow regression tests, syntax/static checks, and platform checks; see below |
| Dependencies, lockfiles, overrides, or `vendor/` | Verify manifest/lockfile consistency and intentional override/vendor changes; follow the executable CI dependency policy and its maintained documentation below |
| Gateway/OpenAPI/device-auth contracts | `node clients/ios/scripts/derive-gateway-contract.mjs --check` with installed TypeScript; affected backend Gateway, OpenAPI, credential/auth tests, and applicable guarded PostgreSQL coverage |
| Swift or iOS client | Applicable Swift tests and unsigned Simulator build from [the iOS workflow](.github/workflows/ios-client.yml); combine with contract checks when relevant and follow [client guidance](clients/ios/README.md) |

- `type-check` runs source boundary checks and shared-package builds before root
  `tsc --noEmit`. `check:boundaries` includes CEF layer access and Madge cycles;
  the separate CEF scan repeats diagnostics. Consult `package.json` for the full
  build/type-check gate sequence; avoid repeating successful gates without reason.
- Root Jest owns `tests/` and `packages/cli/__tests__/`; root lint covers `src`,
  `tests`, `packages`, `workers`, and `arcanos-ai-runtime`. They do not
  comprehensively cover `scripts/` or workflow YAML. Inspect the affected script,
  workflow, and test imports to select its runner; for example, workflow tests may
  use `node --test scripts/stacked-draft-preview-workflow.test.mjs`, while others
  live under root Jest. Add applicable syntax/static checks (such as `node --check`
  for JavaScript) and existing Windows/PowerShell or other platform checks when
  those paths change. Do not run every script suite for every change.
- `npm run validate:all` runs the commit guard, type-check, lint, build, root Jest,
  Railway static checks, and backend/CLI contract/offline checks. It writes
  build/coverage output and omits daemon pytest, standalone runtime tests, and
  many standalone script-test families. `npm run test:all:stacks` adds daemon
  pytest to root Jest but still omits the standalone runtime and script families.
- PostgreSQL/real Redis tests require explicitly disposable targets and can
  create/drop schemas or clear data. Consult `.github/workflows/ci-cd.yml`,
  `jest.phase2e-pg18.config.js`, and `tests/postgres-ci-truth-contract.test.js` for
  suite ownership and execution/skip requirements. `test:postgres-fencing` is not
  the entire PostgreSQL CI set; inspect its current file list.
- `sync:check` is a drift signal whose findings need source confirmation;
  `sync:fix` is not a repair mechanism. The backend/CLI contract validator reads
  manifests/source; its Python offline counterpart mocks network access but can
  create local runtime directories.
- Documentation checks need Node/npm and Git, not application dependencies.
  `docs:check` includes read-only generated-index drift checks; local-only links
  checks avoid network. Omit `--json-report` to avoid report writes. Do not install
  application dependencies, start services, or regenerate indexes for
  instruction-only edits. There is no root format command; the daemon separately
  declares Black as a development dependency. `lint:fix` writes changes.

For dependency material, inspect the affected manifests and lockfiles together;
keep resolutions, integrity, overrides, and vendored source/build provenance
intentional. The current [Security Audit job](.github/workflows/ci-cd.yml) and
[release dependency policy](docs/CI_CD.md#configuration)
own the required checks. Production npm audit uses
`npm audit --omit=dev --json` followed by
`node scripts/check-npm-audit.js <report.json>`: every reported vulnerability is
actionable, and missing, malformed, incomplete, or inconsistent evidence fails
closed. Preserve the current production license check and applicable Python
requirements audit; use their current workflow commands and pins, with no new
exceptions. Report required policy results separately from broader development
dependency findings and unavailable audit evidence. Optional advisory analysis
does not create an additional merge gate. Registry/advisory calls require
[network dependency analysis to be in scope](SECURITY.md#run-locally); do not run
them merely for documentation validation or describe unavailable reports as clean.

For iOS, the workflow runs `xcrun swift test` in `clients/ios/ArcanosKit`,
applicable recovery proofs, and `xcodebuild` with `-sdk iphonesimulator`,
`-destination 'generic/platform=iOS Simulator'`, and `CODE_SIGNING_ALLOWED=NO`.
Follow its current toolchain and full command. Keep contract validation,
compilation, Simulator execution, distribution/TestFlight, and physical-device
acceptance as separate evidence categories. An unsigned Simulator build does not
execute the app or prove distribution/device behavior. Report an unavailable
Apple toolchain as unverified Apple checks. Preserve scoped device credentials
and backend-owned authorization/execution authority; never substitute operator
credentials on a device.

Run `npm run guard:commit` against actual staged changes before an authorized
commit. It inspects staged additions only; an empty-index pass does not verify
unstaged edits. Record passed, failed, skipped, and unexecuted checks with scope
and reasons. Separate pre-existing/environmental failures from introduced
regressions; repair only within scope and never call an inspected or skipped
check passed. For each blocker state its basis: a demonstrated defect, applicable
required check/review, explicit acceptance condition, consequential unresolved
evidence, or missing authorization for a specific action. Distinguish a failed
requirement, an unverified requirement, an optional check not run, and a reported
risk/limitation. Optional checks do not automatically become gates, and an actual
required gate remains required even when source review looks sound. Fixtures do
not establish live-provider, database, preview, or physical-device behavior.

## Deploy (Railway)
Contributors must keep Railway build/start behavior unchanged:
- Build in build phase (`npm ci --include=dev --no-audit --no-fund && npm run build`)
- Start runs the integrity wrapper (`node scripts/start-railway-service-with-integrity.mjs`), which gates the shared role launcher before normal web/worker startup
- Railway services must set `ARCANOS_PROCESS_KIND=web` or `ARCANOS_PROCESS_KIND=worker`

Validate Railway compatibility before merge:
```bash
npm run validate:railway
```

Production deploy process is documented in `docs/RAILWAY_DEPLOYMENT.md`.

## CI Expectations
Workflow definitions and configured branch protection are separate evidence:
- `.github/workflows/ci-cd.yml` defines the main CI checks and aggregate.
- `.github/workflows/doc-audit.yml` defines the documentation audit.
- Consult [CI/CD](docs/CI_CD.md) for other required and specialized workflows;
  repository files alone do not establish current GitHub protection settings.

Required CI behavior:
- Mock-only OpenAI required checks (`OPENAI_API_KEY=mock-api-key`)
- `npm run guard:commit` gate
- Windows Python CLI unit/offline validation job

## OpenAI and Env Rules
- Shared TypeScript OpenAI constructor helper: `packages/arcanos-openai/src/client.ts`
- Backend OpenAI adapter/constructor boundary: `src/core/adapters/openai.adapter.ts`
- Worker OpenAI adapter (which consumes the shared constructor helper): `workers/src/infrastructure/sdk/openai.ts`
- Python OpenAI constructor boundary: `daemon-python/arcanos/openai/unified_client.py`
- TypeScript env access boundary: `src/platform/runtime/env.ts` (`src/config/env.ts` is a compatibility re-export)
- Python env access boundary: `daemon-python/arcanos/env.py`

Escape hatch usage:
- TypeScript runtime may use `getClient()` only where adapter surface does not yet cover the API.
- New chat/image/embed/audio integrations should use adapter methods first.

## Troubleshooting
- Missing npm script errors: run `npm run` and align commands with `package.json`.
- Failing daemon tests: ensure daemon dependencies installed in active venv.
- Route/documentation drift: update `docs/API.md` in the same PR.

## References
- Code of conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Docs standards: `docs/README.md`
- PR templates: `.github/PULL_REQUEST_TEMPLATE.md`
- OpenAI behavior and migration guidance: `docs/OPENAI_RESPONSES_TOOLS.md`
- Shared package boundaries: `docs/WORKSPACE_PACKAGES.md`
