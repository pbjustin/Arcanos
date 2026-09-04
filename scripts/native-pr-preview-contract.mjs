import backstageBookerOpenApiDocument from
  '../contracts/backstage_booker.openapi.v1.json' with { type: 'json' };

export const NATIVE_PR_PREVIEW_E2E_CONTRACT = Object.freeze({
  schemaVersion: 1,
  mode: 'native-pr-application-e2e-v1',
  trustScope: 'trusted-pr-accidental-effects',
  syntheticResponseHeader: Object.freeze({
    name: 'x-arcanos-preview-fixture',
    value: 'sealed-synthetic',
  }),
  workerBudgetReadiness: Object.freeze({
    proofHeader:
      'x-arcanos-preview-worker-budget-readiness-version',
    proofVersion: 'worker-budget-readiness/v1',
  }),
  invalidJobId: 'not-a-uuid',
  unlistedJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
  research: Object.freeze({
    path: '/research/contract',
    fixtures: Object.freeze({
      topicExact: 'topic-exact',
      topicOver: 'topic-over',
      urlCountExact: 'url-count-exact',
      urlCountOver: 'url-count-over',
      urlItemExact: 'url-item-exact',
      urlItemOver: 'url-item-over',
      urlAggregateExact: 'url-aggregate-exact',
      urlAggregateOver: 'url-aggregate-over',
      urlSnapshot: 'url-snapshot',
      storageComponent: 'storage-component',
      workflowCancellationDrain: 'workflow-cancellation-drain',
    }),
  }),
  backstageStoryline: Object.freeze({
    path: '/backstage/storyline-contract',
    fixtures: Object.freeze({
      lifecycleExact: 'lifecycle-exact',
      phaseOneUniverseBinding: 'phase-one-universe-binding',
      payloadOver: 'payload-over',
      savedStorylineProjection: 'saved-storyline-projection',
      summaryPagination: 'summary-pagination',
    }),
  }),
  backstageGeneration: Object.freeze({
    path: '/backstage/generation-contract',
    maxResponseBytes: 4_096,
    clearPolicyVersion: 'backstage-booker-clear-generation/v1',
    partitionedAuthorityProofVersion:
      'backstage-notion-partitioned-authority/v1',
    partitionCutoverRepairProofVersion:
      'backstage-notion-partition-cutover-repair/v1',
    notionReadDiagnosticsProofVersion:
      'backstage-notion-read-diagnostics/v1',
    notionDatabaseAuthorityProofVersion:
      'backstage-notion-database-authority/v1',
    partitionFailureTelemetryProofVersion:
      'backstage-notion-partition-failure-telemetry/v1',
    queueWaitPolicyProofVersion:
      'backstage-booker-queue-wait-policy/v2',
    trinityReasoningPolicyProofVersion:
      'trinity-reasoning-provider-policy/v1',
    managedAsyncContinuationProofVersion:
      'backstage-booker-managed-async-continuation/v2',
    protectedFailureNoFallbackProofVersion:
      'backstage-protected-failure-no-fallback/v1',
    gptClientIdentityProofVersion:
      'backstage-booker-gpt-client-identity/v1',
    outputCapacityPresentationProofVersion:
      'backstage-booker-output-capacity-presentation/v1',
    outputAdmissionProofVersion:
      'backstage-booker-output-admission/v1',
    notionSyncPhaseAProofVersion:
      'backstage-notion-sync-phase-a/v1',
    notionWriterCapacityReleaseProofVersion:
      'backstage-notion-writer-capacity-release/v1',
    fixtures: Object.freeze({
      routeBudget: 'route-budget-provider-delay',
      hrcRetryCache: 'hrc-timeout-retry-cache',
      reviewCompletion: 'review-completion-contract',
      compactRetry: 'compact-retry-contract',
      notionAuthorityRag: 'notion-authority-rag-contract',
      partitionFailureTelemetry: 'partition-failure-telemetry-contract',
      continuityQuery: 'continuity-query-contract',
      continuitySubtree: 'continuity-subtree-contract',
      managedAsyncContinuation: 'managed-async-continuation-contract',
      protectedFailureNoFallback: 'protected-failure-no-fallback-contract',
      gptClientIdentity: 'gpt-client-identity-contract',
      productionOutputContracts: 'production-output-contracts',
      outputAdmission: 'output-classification-first-success-contract',
      notionSyncPhaseA: 'notion-sync-phase-a-contract',
    }),
    proofHeaders: Object.freeze({
      clearPolicyVersion:
        'x-arcanos-preview-backstage-clear-policy-version',
      partitionedAuthorityVersion:
        'x-arcanos-preview-backstage-partition-contract-version',
      partitionCutoverRepairVersion:
        'x-arcanos-preview-backstage-partition-cutover-repair-version',
      notionReadDiagnosticsVersion:
        'x-arcanos-preview-backstage-notion-read-diagnostics-version',
      notionDatabaseAuthorityVersion:
        'x-arcanos-preview-backstage-notion-database-authority-version',
      partitionFailureTelemetryVersion:
        'x-arcanos-preview-backstage-partition-failure-telemetry-version',
      queueWaitPolicyVersion:
        'x-arcanos-preview-backstage-queue-wait-policy-version',
      trinityReasoningPolicyVersion:
        'x-arcanos-preview-trinity-reasoning-policy-version',
      managedAsyncContinuationVersion:
        'x-arcanos-preview-backstage-managed-async-version',
      protectedFailureNoFallbackVersion:
        'x-arcanos-preview-backstage-protected-failure-no-fallback-version',
      gptClientIdentityVersion:
        'x-arcanos-preview-backstage-gpt-client-identity-version',
      outputCapacityPresentationVersion:
        'x-arcanos-preview-backstage-output-capacity-presentation-version',
      outputAdmissionVersion:
        'x-arcanos-preview-backstage-output-admission-version',
      notionSyncPhaseAVersion:
        'x-arcanos-preview-backstage-notion-sync-phase-a-version',
      notionWriterCapacityReleaseVersion:
        'x-arcanos-preview-backstage-notion-writer-capacity-release-version',
    }),
  }),
  backstageBookerOpenApi: Object.freeze({
    document: backstageBookerOpenApiDocument,
    path: '/contracts/backstage_booker.openapi.v1.json',
  }),
  mcpBodyCap: Object.freeze({
    path: '/mcp/body-cap-contract',
    fixtures: Object.freeze({
      effectiveLimits: 'effective-limits',
    }),
  }),
  dispatchGptIdentifier: Object.freeze({
    path: '/dispatch/gpt-identifier-contract',
    fixtures: Object.freeze({
      maximumLength: 'maximum-length-large-action',
      oversized: 'oversized-large-action',
    }),
    actionLength: 40_000,
    actionMarker: 'sealed-dispatch-oversized-action',
    gptIdLengths: Object.freeze({
      maximum: 256,
      oversized: 257,
    }),
    proofHeaders: Object.freeze({
      actionLength: 'x-arcanos-preview-dispatch-action-length',
      gptIdLength: 'x-arcanos-preview-dispatch-gpt-id-length',
      nextCalls: 'x-arcanos-preview-dispatch-next-calls',
    }),
  }),
  statusAuthBoundary: Object.freeze({
    path: '/status/auth-before-parser-contract',
    fixtures: Object.freeze({
      authBeforeParser: 'auth-before-parser',
    }),
    requiredScope: 'mcp:invoke',
    bodyLimitBytes: 65_536,
    proofHeaders: Object.freeze({
      authBeforeParser: 'x-arcanos-preview-status-auth-before-parser',
      bodyLimitBytes: 'x-arcanos-preview-status-body-limit-bytes',
      downstreamCalls: 'x-arcanos-preview-status-downstream-calls',
    }),
  }),
  selfHealApproval: Object.freeze({
    path: '/self-heal/approval-contract',
    fixtures: Object.freeze({
      deniedOutcomes: 'denied-outcomes',
      validCompleted: 'valid-completed',
      incoherentCompleted: 'incoherent-completed',
      disabledLegacy: 'disabled-legacy',
      manualIndependence: 'manual-independence',
      productionDebugDenial: 'production-debug-denial',
    }),
  }),
  gaming: Object.freeze({
    canaryPath: '/gpt/arcanos-gaming/canary',
    queryPath: '/gpt/arcanos-gaming',
    game: 'Palworld',
    fixtures: Object.freeze({
      guide: 'sealed-preview-guide',
      build: 'sealed-preview-build',
      meta: 'sealed-preview-meta',
      operational: 'Is the ARCANOS Action working?',
    }),
  }),
  gamingSources: Object.freeze({
    ingestionPath: '/gpt-access/gaming/sources/ingestions',
    refreshPath: '/gpt-access/gaming/sources/refreshes',
    statusPathPrefix: '/gpt-access/gaming/sources/ingestions/',
    fixtureHeader: 'x-native-preview-fixture',
    fixtures: Object.freeze({
      validation: 'source-validation',
      unsafe: 'source-unsafe',
      outage: 'source-outage',
      created: 'source-created',
      replay: 'source-replay',
      conflict: 'source-conflict',
      refreshValidation: 'refresh-validation',
      refreshUnsafe: 'refresh-unsafe',
      refreshOutage: 'refresh-outage',
      refreshCreated: 'refresh-created',
      statusQueued: 'status-queued',
      statusRunning: 'status-running',
      statusCompleted: 'status-completed',
      statusValidation: 'status-validation',
      statusMissing: 'status-missing',
      statusOutage: 'status-outage',
    }),
    idempotencyKeys: Object.freeze({
      unauthorized: 'preview-source-unauthorized-v1',
      validation: 'preview-source-validation-v1',
      unsafe: 'preview-source-unsafe-v1',
      outage: 'preview-source-outage-v1',
      created: 'preview-source-created-v1',
      replay: 'preview-source-replay-v1',
      conflict: 'preview-source-conflict-v1',
      refreshUnauthorized: 'preview-refresh-unauthorized-v1',
      refreshValidation: 'preview-refresh-validation-v1',
      refreshUnsafe: 'preview-refresh-unsafe-v1',
      refreshOutage: 'preview-refresh-outage-v1',
      refreshCreated: 'preview-refresh-created-v1',
    }),
    ingestionIds: Object.freeze({
      created: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      refresh: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      running: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      completed: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      unauthorized: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      outage: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
      missing: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
    }),
    validationPaddingChars: 5_000,
    sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  }),
  fixtures: Object.freeze({
    completed: '11111111-1111-4111-8111-111111111111',
    failed: '22222222-2222-4222-8222-222222222222',
    cancellable: '33333333-3333-4333-8333-333333333333',
    terminal: '44444444-4444-4444-8444-444444444444',
    repositoryUnavailable: '55555555-5555-4555-8555-555555555555',
    missing: '66666666-6666-4666-8666-666666666666',
    authUnavailable: '77777777-7777-4777-8777-777777777777',
    unauthorized: '88888888-8888-4888-8888-888888888888',
    cancellationUnavailable: '99999999-9999-4999-8999-999999999999',
  }),
});
