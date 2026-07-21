# ARCANOS reusable-code audit baseline

This directory preserves Phase 0 and the evidence used by Phase 1 characterization tests. It is tied to source commit `462e279f264372d42be4c9781a98fe72b6f498a5` on branch `codex/fix-gaming-action-resilience`.

The audit is observational. No production route, loader, queue, converter, persistence, worker, client, logging, metric, database, Redis, OpenAI, or Railway behavior is intentionally changed.

## Executive result

- The original repository counts reproduce: 1,870 tracked files, 721 tracked entries under `src/`, and 717 applicable non-declaration TypeScript source files.
- The configured Jest coverage scope contains 94 files, representing 13.1102% of the 717-file root-backend `src/` denominator and 11.7061% of the separately labeled 803-file monorepo production-root denominator. Neither percentage is repository-wide test coverage.
- Madge reproduces 63 circular dependency paths.
- A TypeScript AST runtime graph, excluding explicit type-only import/export edges, reproduces two strongly connected components spanning 75 modules: one 67-module SCC and one 8-module SCC.
- `src/services/moduleLoader.ts` evaluates 134 source service files and statically predicts 13 accepted action modules. The machine-local ignored `dist/services` directory evaluates 138 files and contains four compiled-only JavaScript files; that observation is not source-reproducible.
- The three audit-safe implementations are independent mutable states. Their allowed modes, failure handling, persistence, reset, and override semantics differ.
- Ask and GPT queue waiters share a loop shape but intentionally or accidentally differ for `cancelled` and `expired`; neither consumes an abort signal.
- Three Responses-to-ChatCompletion converters exist. Core and service outputs currently match; the worker converter drops Responses metadata and hardcodes `finish_reason: "stop"`.
- Five source-level HTTP method/path collision groups are present. Both `/api/reusables` routes are mounted through `apiRouter` and directly.
- Seven timing-safe credential-comparison implementations exist, with materially different trimming, parsing, length, and hashing behavior.
- Railway role selection explicitly separates the web server from the PostgreSQL job runner, but the job runner's dispatch import chain also evaluates `workerControlService.ts` and starts the distinct in-process EventEmitter worker runtime when worker mode is enabled.

## Audit corrections

| Earlier hypothesis | Repository evidence |
|---|---|
| Loader dynamically imports approximately 135 top-level services | `src/services` has 135 top-level `.ts` files, but the loader excludes itself and evaluates 134. |
| Configured scope branch denominator was 212 | One untouched run reported 213; two identical JSON-summary runs reported 212. The inconsistency is preserved as a baseline observation. |
| Scoped coverage could be read as repository-wide | The 94 configured files are 13.1102% of the 717-file root-backend `src/` denominator and 11.7061% of 803 files in explicitly configured monorepo production roots. |
| Boundary command covers dependency cycles | `npm run check:boundaries` invokes the CEF scanner only. It does not run Madge or `scripts/check-boundaries.ts`. |
| Production loader inventory equals source inventory | The machine-local ignored `dist/services` observation has four compiled-only files. The build does not clean `dist`, but the artifact does not claim those files can be reproduced from the source commit. |

## Artifact index

| Artifact | Purpose |
|---|---|
| `baseline.json` | Root, source commit, branch, environment, non-secret flags, and tool versions. |
| `source-inventory.json` | Verified tracked/source/package counts. |
| `test-inventory.json` | Source-commit-filtered 365-file Jest baseline, separate Phase 1 test catalog, Python, runtime, worker, and package test ownership. |
| `validation-results.json` | Untouched pre-change commands classified as passing, failing, inconsistent, unavailable, or not run. |
| `post-change-validation.json` | Post-change comparison, focused characterization, broad validation, expected baseline failures, and prohibited commands. |
| `coverage-scope.txt` | Sorted configured coverage file list. |
| `coverage-report.json` | Configured-scope metrics and repository file representation, separately labeled. |
| `dynamic-module-inventory.json` | Deterministic evaluated/accepted/rejected source and compiled module inventories. |
| `circular-paths.json` | Deterministic Madge circular-path report. |
| `runtime-scc.json` | Runtime-only SCC membership with explicit type-only edges excluded. |
| `runtime-edges.json` | All 2,310 sorted source/target edges with source commit, scope, command, and tool versions. |
| `architecture-edges.csv` | Cross-area runtime import-edge counts. |
| `unused-declarations.txt` | Pre-existing unused declaration/import diagnostics. |
| `characterization-report.md` | Human-readable Phase 1 behavior matrices. |
| `findings.json` | Evidence, confidence, risk, prerequisites, phase, rollback, and deployment labels. |
| `dependency-boundary-proposals.md` | Later-phase boundary-cut proposals; not implementation authorization. |

## Reproduction

From the audit branch descended from the source commit, with dependencies already installed and no network access:

```powershell
$env:NODE_ENV='test'
$env:FORCE_MOCK='true'
node scripts/run-jest.mjs --coverage --coverageReporters=json-summary --coverageReporters=lcov --coverageReporters=text-summary --maxWorkers=50% --silent
node scripts/reusable-code-audit-baseline.mjs --source-commit 462e279f264372d42be4c9781a98fe72b6f498a5 --source-branch codex/fix-gaming-action-resilience --baseline-at 2026-07-16T16:37:54.4989251-04:00 --output docs/audits/reusable-code/2026-07-16 --verify-determinism
```

The generator verifies that the source branch resolves to the recorded commit, that `HEAD` descends from it, and that committed or uncommitted differences are confined to the scoped Phase 0/1 audit files. It filters the pre-change Jest inventory through the source commit and catalogs audit-branch tests separately. An ignored `.env.test` is present locally; only its variable names, never values, are recorded.

The compiled loader section is intentionally different: `dist/` is ignored generated state. Its 138-file observation preserves the machine-local baseline but cannot be regenerated from a clean source checkout; the artifact separately records the 134-file clean-source expectation.

The generator:

- sorts paths and identifiers;
- writes repository-relative forward-slash paths where practical;
- excludes volatile generation timestamps;
- records expected nonzero exits for Madge and unused-declaration diagnostics;
- performs the full analysis twice and compares serialized artifacts;
- verifies the coverage-summary file set exactly matches the configured scope;
- emits the complete sorted runtime edge list as well as SCC and area summaries;
- does not import all real service modules in the long-lived process;
- does not make network, database, Redis, OpenAI, or Railway calls.

## Safety constraints retained

- No deployment occurred.
- No Railway variables were queried or changed.
- No credential values are stored in this directory.
- Real dynamic service imports were not executed solely for coverage because rejected modules can mutate filesystem, metric, listener, native-monitor, and singleton state.
- Live Railway state was not queried; worker ownership conclusions distinguish repository-declared wiring from externally unverified deployment state.
- Coverage scope was documented, not expanded.
- Dependency cycles, duplicate routes, converter differences, queue differences, and audit-safe disagreements were characterized, not corrected.
