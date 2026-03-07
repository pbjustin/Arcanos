# MIGRATION_NOTES

Generated at: 2026-03-07T20:16:46.125Z

- Scope: Analysis plus low-risk helper consolidation
- Compatibility: Runtime behavior preserved; imports now route through shared sleep, error, and type-guard helper utilities.

## Affected Files

- scripts/ast-refactor-audit.mjs
- scripts/python_ast_catalog.py
- src/shared/sleep.ts
- src/shared/typeGuards.ts
- src/shared/logPath.ts
- src/jobs/jobQueue.ts
- src/routes/_core/gptDispatch.ts
- src/services/arcanosDagRunService.ts
- src/services/git.ts
- src/services/routeMemorySnapshotStore.ts
- src/workers/jobRunner.ts
- src/core/db/repositories/dagRunRepository.ts
- src/core/db/repositories/selfReflectionRepository.ts
- src/core/db/repositories/workerRuntimeRepository.ts
- src/services/judgedResponseFeedback.ts
- src/services/safety/memoryEnvelope.ts
- src/services/safety/runtimeState/defaults.ts
- src/services/safety/runtimeState/index.ts
- architecture_graph.json
- duplicate_report.json
- refactor_log.json
- ARCHITECTURE_STATE.md
- REFRACTOR_LOG.md
- MIGRATION_NOTES.md

## Rollback

- Delete scripts/ast-refactor-audit.mjs and scripts/python_ast_catalog.py to remove the analysis tooling.
- Revert src/shared/sleep.ts, src/shared/typeGuards.ts, and the touched service/repository/runtime-state files to restore the previous inline helpers.
- Delete architecture_graph.json, duplicate_report.json, refactor_log.json, ARCHITECTURE_STATE.md, REFRACTOR_LOG.md, and MIGRATION_NOTES.md to revert the generated artifacts.
