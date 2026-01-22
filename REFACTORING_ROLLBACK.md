# Refactoring Rollback Plan

## Quick Rollback Commands

### Rollback All Changes
```bash
git reset --hard HEAD~N  # Where N is number of commits
```

### Rollback Specific Phase
```bash
# Find commit hash
git log --oneline

# Rollback specific commit
git revert <commit-hash>
```

## Phase-by-Phase Rollback

### Phase 1: Type Safety (Eliminate Legacy Debt)
**Files Affected:**
- `src/services/openai/types.ts`
- `src/services/openai.ts`
- `src/utils/errorResponse.ts`
- `src/utils/security.ts`
- `src/utils/idleManager.ts`
- `src/utils/structuredLogging.ts`
- `src/utils/dualModeAudit.ts`
- `src/services/sessionResolver.ts`
- `src/routes/sdk.ts`
- `src/modules/backstage/booker.ts`
- `src/logic/arcanos.ts`
- `src/server.ts`

**Rollback Impact:** Low - Type-only changes, no runtime behavior changes

### Phase 2: Type Modernization
**Files Affected:** Same as Phase 1 (continued improvements)

**Rollback Impact:** Low - Type-only changes

### Phase 3: Resilience Utilities
**Files Affected:**
- `src/utils/resilience.ts` (NEW FILE)

**Rollback Impact:** None - New utility file, not yet integrated

### Phase 6: Resilience Patches
**Files Affected:**
- `src/utils/resilience.ts` (same as Phase 3)

**Rollback Impact:** None - New utility file, not yet integrated

## Verification After Rollback

1. **Type Check**: `npm run type-check`
2. **Lint**: `npm run lint`
3. **Tests**: `npm run test`
4. **Build**: `npm run build`

## Emergency Rollback

If critical issues arise:

```bash
# 1. Stash current changes
git stash

# 2. Reset to last known good commit
git reset --hard <last-known-good-commit>

# 3. Force push (if needed, coordinate with team)
git push --force
```

## Partial Rollback

To rollback specific files:

```bash
# Checkout specific file from previous commit
git checkout <commit-hash> -- <file-path>

# Example: Rollback only openai.ts
git checkout HEAD~1 -- src/services/openai.ts
```

## Testing After Rollback

1. Run full test suite
2. Verify API endpoints respond correctly
3. Check error responses match expected format
4. Verify OpenAI integration works
5. Check logging output format
