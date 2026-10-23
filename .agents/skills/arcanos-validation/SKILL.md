---
name: arcanos-validation
description: Select and run the smallest relevant local checks for an ARCANOS change, verify its toolchain, and report passed, failed, and skipped validation. Use for backend, worker, protocol, Python, database, scripts/workflows, dependencies, iOS, or Railway configuration validation; this does not authorize deployment or live probes.
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

Use the canonical [Required Local Validation matrix](../../../CONTRIBUTING.md#required-local-validation). Combine affected rows and deduplicate commands; do not maintain a second matrix here. It covers runner ownership, standalone script families omitted by `validate:all`, dependency policy, Gateway drift, and Apple evidence categories as well as backend checks.

Select exact Jest files with `node scripts/run-jest.mjs --runTestsByPath <actual-file> --coverage=false`; preserve the wrapper and inspect selected test setup before integration suites that might use configured services. Direct Jest requires current shared-package builds. `type-check` and `build` already build those packages and run boundary gates; do not repeat successful gates without a diagnostic reason.

For scripts/workflows, identify the affected runner and regression/static/platform checks rather than assuming root Jest or lint covers them. For dependency changes, follow current executable CI audit/license policy and preserve [network-analysis scope](../../../SECURITY.md#run-locally). For iOS changes, inspect [the current workflow](../../../.github/workflows/ios-client.yml) and [client guidance](../../../clients/ios/README.md); unavailable Apple checks remain unverified.

## Keep validation within scope

- Prefer mocked tests and dedicated local fixtures. Database initialization, migration apply/rollback, worker startup, and `worker:jobs:maintenance -- inspect` can mutate configured state or claim jobs. They are not ordinary validation commands. Live provider, memory, dispatcher, production smoke/probe/watchdog, and network/execute modes require the applicable explicit scope and exact target authorization already established in the task.
- A successful `validate:railway` is local configuration evidence, not a deployment or provider health check. Do not deploy, change Railway settings, stage, commit, or push as a side effect of validation.
- Do not use `dev`, `start`, `self-test`, or `daily-summary` as substitutes for tests. Read `AGENTS.md`'s current command traps before using unfamiliar scripts; do not resurrect retired probes, invoke missing targets, run destructive `clean`/`rebuild`, or invent a root format command.
- A failed check calls for diagnosis. Change code only if repair is authorized. Run the affected checks again after a repair; broaden testing when changed scope or an unresolved failure justifies it. Do not rerun successful suites without new evidence to resolve.
- Recheck the working tree after validation. Report unexpected tracked changes and preserve unrelated files; do not automatically reset or delete artifacts.

## Report the evidence

State the checkout/commit and whether local changes were included, actual runtime versions, and each relevant check's result. Keep **passed**, **failed**, and **skipped/blocked** distinct; give a concise reason for each non-pass and identify untested behavior. Separate required dependency-policy results, broader development-dependency findings, and unavailable audit evidence.

Every blocker needs a stated basis: demonstrated defect, applicable required check/review, explicit task acceptance condition, consequential unresolved evidence, or missing authorization for a specific action. Distinguish failed requirements, unverified requirements, optional checks not run, and reported risks/limitations. Optional validation does not automatically become a merge gate; actual required gates cannot be dismissed because implementation appears sound.

A suite with skipped database cases is not PostgreSQL E2E evidence. Keep iOS contract validation, compilation, Simulator execution, distribution/TestFlight, and physical-device acceptance separate. Never imply CI, preview, production, or live-provider verification from local mocked tests.
