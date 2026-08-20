/**
 * Coverage ownership for the Backstage Notion authority feature.
 *
 * These files contain its protocol, route composition, query, retrieval,
 * immutable-index, synchronization, repository, and worker-loop behavior that
 * can be exercised without live PostgreSQL, Notion, or OpenAI access.
 * Thresholds are deliberately explicit: small policy/security modules remain
 * exhaustive, while large defensive parsers, dispatchers, and SQL repositories
 * retain realistic regression floors measured by the focused offline suites.
 */
export const backstageNotionCoverageThresholds = Object.freeze({
  'packages/protocol/src/backstageBooker.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'packages/protocol/src/index.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'packages/protocol/src/schemaCatalog.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'packages/protocol/src/validation.ts': Object.freeze({
    branches: 80,
    functions: 50,
    lines: 75,
    statements: 75,
  }),
  'src/core/db/repositories/backstageNotionRagRepository.ts': Object.freeze({
    branches: 60,
    functions: 90,
    lines: 90,
    statements: 90,
  }),
  'src/routes/_core/gptDispatch.ts': Object.freeze({
    branches: 80,
    functions: 90,
    lines: 75,
    statements: 75,
  }),
  'src/routes/_core/legacyGptCompat.ts': Object.freeze({
    branches: 75,
    functions: 100,
    lines: 90,
    statements: 90,
  }),
  'src/routes/dispatch.ts': Object.freeze({
    branches: 75,
    functions: 100,
    lines: 90,
    statements: 90,
  }),
  'src/routes/gptRouter.ts': Object.freeze({
    branches: 55,
    functions: 75,
    lines: 50,
    statements: 50,
  }),
  'src/services/backstage-booker.ts': Object.freeze({
    branches: 80,
    functions: 90,
    lines: 90,
    statements: 90,
  }),
  'src/services/backstageBookerContracts.ts': Object.freeze({
    branches: 78,
    functions: 90,
    lines: 85,
    statements: 85,
  }),
  'src/services/backstageContinuityQuery.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/services/backstageNotionEnrichmentAuthorization.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/services/backstageNotionRag.ts': Object.freeze({
    branches: 80,
    functions: 100,
    lines: 92,
    statements: 92,
  }),
  'src/services/backstageNotionSync.ts': Object.freeze({
    branches: 75,
    functions: 100,
    lines: 90,
    statements: 90,
  }),
  'src/shared/backstage/backstageActionPolicy.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/shared/backstage/backstageContinuityQueryCore.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/shared/backstage/backstageGenerationError.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/shared/backstage/backstageNotionRagCore.ts': Object.freeze({
    branches: 75,
    functions: 100,
    lines: 90,
    statements: 90,
  }),
  'src/shared/backstage/backstageNotionScopeIndex.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/workers/backstageNotionSyncLoop.ts': Object.freeze({
    branches: 80,
    functions: 100,
    lines: 95,
    statements: 95,
  }),
});

export const backstageNotionCoverageScopeFiles = Object.freeze(
  Object.keys(backstageNotionCoverageThresholds)
);
