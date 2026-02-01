# ARCANOS Resilience Refactor - Progress Report

**Date:** 2026-01-30  
**Cycle:** 1  
**Status:** In Progress

---

## Completed

### Backend (TypeScript)

#### Phase 1 - Audit ✅
- Created violation report: `.eng/optimization/audit-log/resilience-refactor-violations.md`
- Identified 70 files with OpenAI imports
- Identified 61 files with process.env usage
- Documented route/controller violations

#### Phase 2 - Config and Env (Partial) ✅
- ✅ Created `src/config/env.ts` with fail-fast validation
- ✅ Updated `src/start-server.ts` to validate env before startup
- ✅ Updated `src/config/index.ts` to use validated PORT
- ⏳ **Remaining:** Remove process.env from 61 non-config files (in progress)

#### Phase 3 - OpenAI Adapter Boundary (Partial) ✅
- ✅ Created `src/adapters/openai.adapter.ts` - single adapter factory
- ✅ Extended adapter to support chat, embeddings, and audio transcriptions
- ✅ Updated `src/init-openai.ts` to initialize adapter with config
- ✅ Updated `src/routes/api-transcribe.ts` to use adapter (example migration)
- ⏳ **Remaining:** Migrate 70 files from direct OpenAI imports to adapter (in progress)

### CLI Agent (Python)

#### Phase 1 - Audit ✅
- Identified 9 files with os.getenv/os.environ usage
- Identified 3 files with OpenAI imports (gpt_client.py needs refactor)

#### Phase 2 - Config and Env (Partial) ✅
- ✅ Added `validate_required_config()` function to `config.py` with fail-fast
- ✅ Updated `cli.py` main() to call validation after bootstrap
- ⏳ **Remaining:** Remove os.getenv from 8 files (unified_client.py, utils/config.py, debug_server.py, terminal.py, cli.py, etc.)

#### Phase 3 - OpenAI Adapter Boundary (Not Started)
- ⏳ Refactor `gpt_client.py` to use unified_client instead of direct OpenAI construction
- ⏳ Update `unified_client.py` to accept config via arguments (no os.getenv)

---

## Next Steps (Priority Order)

### Immediate (Cycle 1 continuation)

1. **Backend - Remove process.env from critical files:**
   - `src/server.ts` - Remove process.env usage
   - `src/utils/env.ts` - This file IS the env abstraction, but should delegate to config/env.ts
   - `src/services/openai/credentialProvider.ts` - Remove process.env, use config
   - `src/services/openai/unifiedClient.ts` - Remove process.env, use config

2. **Backend - Migrate more routes to adapter:**
   - `src/routes/api-arcanos.ts`
   - `src/routes/api-vision.ts`
   - `src/routes/ask.ts`

3. **CLI - Remove os.getenv from critical files:**
   - `daemon-python/arcanos/openai/unified_client.py` - Accept config via arguments
   - `daemon-python/arcanos/utils/config.py` - Use Config class instead of os.getenv
   - `daemon-python/arcanos/gpt_client.py` - Use unified_client instead of direct OpenAI

### Medium Priority (Cycle 2)

4. **Backend - Complete adapter migration:**
   - Migrate all routes (12 files)
   - Migrate all services (30+ files)
   - Migrate all logic files (4 files)
   - Migrate utils files (12 files)

5. **Backend - Complete env cleanup:**
   - Remove process.env from all services
   - Remove process.env from all routes
   - Remove process.env from all middleware
   - Remove process.env from all utils (except config/)

6. **CLI - Complete env cleanup:**
   - Remove os.getenv from debug_server.py
   - Remove os.getenv from terminal.py
   - Remove os.getenv from cli.py

### Low Priority (Cycle 3+)

7. **Phase 4 - Layout and boundaries:**
   - Introduce `core/` directory for domain logic
   - Introduce `guards/` directory for failsafe logic
   - Ensure routes are thin (no business logic)

8. **Phase 5 - Resilience layer:**
   - Implement/refactor fallback_handler
   - Implement/refactor rollback_isolation
   - Implement/refactor failsafe_guard
   - Add request-scoped counters (retryCount, fallbackCount)

9. **Phase 6 - Error taxonomy:**
   - Define error types in core/errors/
   - Map errors to HTTP status codes
   - Ensure services throw domain errors

10. **Phase 7 - Verify and converge:**
    - Run contract tests
    - Run full test suite
    - Run audit again
    - Two consecutive cycles with no changes

---

## Metrics

- **Backend OpenAI violations:** 70 files → 69 files (1 migrated: api-transcribe.ts)
- **Backend process.env violations:** 61 files → ~60 files (config/index.ts updated)
- **CLI os.getenv violations:** 9 files → 9 files (validation added, cleanup pending)
- **CLI OpenAI violations:** 2 files → 2 files (pending)

---

## Notes

- Adapter pattern is established and working
- Fail-fast validation is in place for both Backend and CLI
- Example migration (api-transcribe.ts) demonstrates the pattern
- Remaining work is systematic application of the pattern across all files
