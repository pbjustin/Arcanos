---
name: arcanos-validation
description: Select and run the smallest relevant local checks for an ARCANOS change, verify its toolchain, and report passed, failed, and skipped validation. Use when asked to validate a change or decide which tests cover backend, worker, protocol, Python, database, or Railway configuration work; this does not authorize deployment or live probes.
---

# ARCANOS validation

Produce validation evidence tied to the actual checkout and change. Use the active ARCANOS repository or worktree; do not assume a fixed path or that the main checkout is clean.

## Establish the target

1. Read the current root `AGENTS.md`. Inspect `git rev-parse --show-toplevel`, `git rev-parse HEAD`, `git status --short --branch`, and the task's intended diff/base. Include staged, unstaged, and relevant untracked files when the request concerns local changes; do not select an arbitrary PR base.
2. Read root `package.json`, `.nvmrc`, affected workspace manifests, and relevant test configuration. Current executable configuration and source take precedence over examples below. Resolve a disagreement with current tracked evidence instead of silently changing the runtime or pin.
3. Check `node --version` and `npm --version` and dependency availability without printing environment values. The verified baseline when this skill was created was exact Node `24.18.1` with bundled npm `11.16.0`; re-read it each use. Check Python requirements in `daemon-python/pyproject.toml` for daemon work.
4. If dependencies or the pinned toolchain are missing, look for an already installed compatible runtime. Do not present checks on another runtime as canonical validation. Install only within existing task authorization; npm install hooks can create Git hooks and local tooling. Continue source review and report blocked checks if setup is unavailable.

Preserve existing local work and other worktrees. Check-building can create package output, `dist/`, and coverage; use the agreed isolated worktree when those effects matter. A request for a validation plan alone calls for a plan. An implementation or test request already authorizes its ordinary local checks; do not ask again for approved work.

## Choose the checks

Use the relevant rows together, deduplicate identical commands, and run npm workspace commands from the repository root. Replace `<pattern>` with a focused suite or carefully quoted regex. Inspect the selected test setup before running integration suites that might use configured services.

| Changed area | Minimum relevant checks, subject to current `AGENTS.md` |
| --- | --- |
| Root TypeScript/backend | `npm run type-check`; `npm run lint`; `node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false` |
| Broad root behavior | `npm run build`; `npm test` or the split `npm run test:all` |
| Protocol, CLI, or TypeScript/Python contract | `npm run type-check`; `npm run lint`; `node scripts/run-jest.mjs --testPathPatterns=protocol --coverage=false`; `npm run validate:backend-cli:contract`; `npm run validate:backend-cli:offline`; `npm run sync:check`; add focused changed-contract tests |
| Separate `workers/` workspace | `npm run build:workers`; `npm run lint`; focused root Jest where applicable |
| `src/workers/`, including the root job runner | `npm run build`; `npm run lint`; focused root Jest |
| `arcanos-ai-runtime/` | `npm run test:runtime-integration`; `npm run lint` |
| `daemon-python/` | `python -m pytest daemon-python/tests/<test_file>.py -q`, or its full test directory for broad changes; add `npm run validate:backend-cli:offline` for contracts |
| Railway configuration/startup | `npm run build`; local, non-deploying `npm run validate:railway` |
| Database/schema | `npm run type-check`; focused database or route Jest; `npm run validate:railway`; add lint when backend code changes |
| Maintained documentation or source layout | `npm run docs:check`, including its generated-index drift check; combine with the relevant code row |

Run package builds before consumer checks. Currently `type-check` and `build` already build shared packages and run boundary gates, so do not repeat those gates without a focused diagnostic reason. Follow current `AGENTS.md` if it separately requires both commands. Preserve the repository's `scripts/run-jest.mjs` wrapper and its ESM/test-environment setup.

Root Jest excludes `arcanos-ai-runtime/tests/`. `test:all:stacks` covers root Jest and daemon pytest, not runtime tests; `validate:all` does not cover daemon pytest or runtime tests. Use the separate row when those surfaces change. `sync:check` is a drift signal whose findings need source confirmation; `sync:fix` is not a repair mechanism.

## Keep validation within scope

- Prefer mocked tests and dedicated local fixtures. Database initialization, migration apply/rollback, worker startup, and `worker:jobs:maintenance -- inspect` can mutate configured state or claim jobs. They are not ordinary validation commands. Live provider, memory, dispatcher, production smoke/probe/watchdog, and network/execute modes require the applicable explicit scope and exact target authorization already established in the task.
- A successful `validate:railway` is local configuration evidence, not a deployment or provider health check. Do not deploy, change Railway settings, stage, commit, or push as a side effect of validation.
- Do not use `dev`, `start`, `self-test`, or `daily-summary` as substitutes for tests. Read `AGENTS.md`'s current command traps before using unfamiliar scripts; do not resurrect retired probes, invoke missing targets, run destructive `clean`/`rebuild`, or invent a root format command.
- A failed check calls for diagnosis. Change code only if repair is authorized. Run the affected checks again after a repair; broaden testing when changed scope or an unresolved failure justifies it. Do not rerun successful suites without new evidence to resolve.
- Recheck the working tree after validation. Report unexpected tracked changes and preserve unrelated files; do not automatically reset or delete artifacts.

## Report the evidence

State the checkout/commit and whether local changes were included, actual runtime versions, and each relevant check's result. Keep **passed**, **failed**, and **skipped/blocked** distinct; give a concise reason for each non-pass and identify untested behavior. A suite with skipped database cases is not PostgreSQL E2E evidence. Never imply CI, preview, production, or live-provider verification from local mocked tests.
