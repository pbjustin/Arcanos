# ARCANOS Resilience Refactor - Violation Report

**Generated:** 2026-01-30  
**Phase:** Audit (Cycle 1)

---

## Backend (TypeScript) Violations

### OpenAI SDK Import Violations (70 files)

**Rule:** OpenAI SDK imports only allowed in `src/adapters/`

**Violations:**
- `src/utils/` (12 files): tokenParameterHelper.ts, requestHandler.ts, requestPayloadUtils.ts, aiLogger.ts, openaiLogger.ts, openaiErrorHandler.ts, messageBuilderUtils.ts, idleManager.ts, workerContext.ts, diagnostics.ts, health/unifiedHealth.ts
- `src/services/` (30+ files): All files in `services/openai/`, plus research.ts, secureReasoningEngine.ts, reusableCodeGeneration.ts, gpt4Shadow.ts, arcanosPipeline.ts, etc.
- `src/routes/` (12 files): api-arcanos.ts, api-transcribe.ts, api-vision.ts, api-sim.ts, openai-arcanos-pipeline.ts, ask.ts, etc.
- `src/logic/` (4 files): arcanos.ts, trinity.ts, trinityStages.ts, assistantSyncCron.ts
- `src/middleware/` (1 file): confirmGate.ts
- `src/modules/` (2 files): hrc.ts, backstage/booker.ts
- `src/controllers/` (1 file): healthController.ts
- `src/config/` (1 file): workerConfig.ts
- `src/init-openai.ts`, `src/startup.ts`, `src/server.ts`, `src/app.ts`, `src/diagnostics.ts`

### process.env Violations (61 files)

**Rule:** `process.env` only allowed in `src/config/`

**Violations:**
- `src/utils/` (10 files): env.ts, environmentValidation.ts, environmentSecurity.ts, structuredLogging.ts, telemetry/unifiedTelemetry.ts, workerBoot.ts, workerPaths.ts, constants.ts, diagnostics.ts, dualModeAudit.ts
- `src/services/` (20+ files): openai/config.ts, openai/credentialProvider.ts, openai/constants.ts, openai/unifiedClient.ts, plus many others
- `src/routes/` (6 files): status.ts, workers.ts, api-vision.ts, api-transcribe.ts, ask.ts, arcanosQuery.ts
- `src/middleware/` (2 files): confirmGate.ts, confirmationChallengeStore.ts
- `src/logic/` (2 files): arcanos.ts, tutor-logic.ts
- `src/modules/` (2 files): hrc.ts, backstage/booker.ts
- `src/db/` (1 file): client.ts
- `src/memory/` (2 files): store.ts, sessionPersistence.ts
- `src/config/` (4 files): unifiedConfig.ts, workerConfig.ts, gptRouterConfig.ts, railway.ts, index.ts
- `src/persistenceManagerHierarchy.ts`, `src/diagnostics.ts`, `src/controllers/openaiController.ts`

### Route/Controller Business Logic Violations

**Rule:** Routes/controllers should only parse input, call services, format output

**Files to review:**
- `src/routes/api-arcanos.ts` - Contains OpenAI calls
- `src/routes/api-transcribe.ts` - Contains model selection logic
- `src/routes/api-vision.ts` - Contains model selection logic
- `src/routes/ask.ts` - Contains OpenAI calls
- `src/routes/openai-arcanos-pipeline.ts` - Contains OpenAI calls
- `src/controllers/openaiController.ts` - Contains business logic

---

## CLI Agent (Python) Violations

### os.getenv/os.environ Violations (9 files)

**Rule:** Env access only allowed in `config.py`

**Violations:**
- `daemon-python/arcanos/openai/unified_client.py` - Multiple `os.getenv` calls
- `daemon-python/arcanos/utils/config.py` - `os.getenv` calls
- `daemon-python/arcanos/utils/telemetry.py` - `os.getenv` calls
- `daemon-python/arcanos/debug_server.py` - `os.getenv` call
- `daemon-python/arcanos/terminal.py` - `os.getenv` calls
- `daemon-python/arcanos/uninstall.py` - `os.getenv` calls (system paths - may be acceptable)
- `daemon-python/arcanos/cli.py` - `os.getenv` calls
- `daemon-python/arcanos/credential_bootstrap.py` - `os.environ` usage
- `daemon-python/arcanos/config.py` - ✅ ALLOWED (canonical config)

### OpenAI Import Violations (3 files)

**Rule:** OpenAI imports only allowed in `openai/` directory

**Violations:**
- `daemon-python/arcanos/gpt_client.py` - Imports `OpenAI` and constructs client directly
- `daemon-python/arcanos/utils/error_handling.py` - Imports exception types (may be acceptable if only exception types)
- `daemon-python/arcanos/openai/unified_client.py` - ✅ ALLOWED (adapter directory)

---

## Summary

- **Backend OpenAI violations:** 70 files
- **Backend process.env violations:** 61 files  
- **CLI os.getenv violations:** 9 files
- **CLI OpenAI violations:** 2 files (gpt_client.py needs refactor, error_handling.py may be acceptable)

**Next Steps:**
1. Phase 2: Centralize config and env validation
2. Phase 3: Create adapter boundaries
3. Phase 4: Refactor violations
