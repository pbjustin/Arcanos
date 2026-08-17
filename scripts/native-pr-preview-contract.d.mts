export interface NativePrPreviewE2eContract {
  readonly schemaVersion: 1;
  readonly mode: 'native-pr-application-e2e-v1';
  readonly trustScope: 'trusted-pr-accidental-effects';
  readonly syntheticResponseHeader: Readonly<{
    name: 'x-arcanos-preview-fixture';
    value: 'sealed-synthetic';
  }>;
  readonly invalidJobId: 'not-a-uuid';
  readonly unlistedJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  readonly research: Readonly<{
    path: '/research/contract';
    fixtures: Readonly<{
      topicExact: 'topic-exact';
      topicOver: 'topic-over';
      urlCountExact: 'url-count-exact';
      urlCountOver: 'url-count-over';
      urlItemExact: 'url-item-exact';
      urlItemOver: 'url-item-over';
      urlAggregateExact: 'url-aggregate-exact';
      urlAggregateOver: 'url-aggregate-over';
      urlSnapshot: 'url-snapshot';
      storageComponent: 'storage-component';
      workflowCancellationDrain: 'workflow-cancellation-drain';
    }>;
  }>;
  readonly backstageStoryline: Readonly<{
    path: '/backstage/storyline-contract';
    fixtures: Readonly<{
      lifecycleExact: 'lifecycle-exact';
      phaseOneUniverseBinding: 'phase-one-universe-binding';
      payloadOver: 'payload-over';
      savedStorylineProjection: 'saved-storyline-projection';
    }>;
  }>;
  readonly backstageGeneration: Readonly<{
    path: '/backstage/generation-contract';
    fixtures: Readonly<{
      routeBudget: 'route-budget-provider-delay';
      hrcRetryCache: 'hrc-timeout-retry-cache';
      reviewCompletion: 'review-completion-contract';
    }>;
  }>;
  readonly mcpBodyCap: Readonly<{
    path: '/mcp/body-cap-contract';
    fixtures: Readonly<{
      effectiveLimits: 'effective-limits';
    }>;
  }>;
  readonly selfHealApproval: Readonly<{
    path: '/self-heal/approval-contract';
    fixtures: Readonly<{
      deniedOutcomes: 'denied-outcomes';
      validCompleted: 'valid-completed';
      incoherentCompleted: 'incoherent-completed';
      disabledLegacy: 'disabled-legacy';
      manualIndependence: 'manual-independence';
      productionDebugDenial: 'production-debug-denial';
    }>;
  }>;
  readonly gaming: Readonly<{
    canaryPath: '/gpt/arcanos-gaming/canary';
    queryPath: '/gpt/arcanos-gaming';
    game: 'Palworld';
    fixtures: Readonly<{
      guide: 'sealed-preview-guide';
      build: 'sealed-preview-build';
      meta: 'sealed-preview-meta';
      operational: 'Is the ARCANOS Action working?';
    }>;
  }>;
  readonly gamingSources: Readonly<{
    ingestionPath: '/gpt-access/gaming/sources/ingestions';
    refreshPath: '/gpt-access/gaming/sources/refreshes';
    statusPathPrefix: '/gpt-access/gaming/sources/ingestions/';
    fixtureHeader: 'x-native-preview-fixture';
    fixtures: Readonly<{
      validation: 'source-validation';
      unsafe: 'source-unsafe';
      outage: 'source-outage';
      created: 'source-created';
      replay: 'source-replay';
      conflict: 'source-conflict';
      refreshValidation: 'refresh-validation';
      refreshUnsafe: 'refresh-unsafe';
      refreshOutage: 'refresh-outage';
      refreshCreated: 'refresh-created';
      statusQueued: 'status-queued';
      statusRunning: 'status-running';
      statusCompleted: 'status-completed';
      statusValidation: 'status-validation';
      statusMissing: 'status-missing';
      statusOutage: 'status-outage';
    }>;
    idempotencyKeys: Readonly<{
      unauthorized: 'preview-source-unauthorized-v1';
      validation: 'preview-source-validation-v1';
      unsafe: 'preview-source-unsafe-v1';
      outage: 'preview-source-outage-v1';
      created: 'preview-source-created-v1';
      replay: 'preview-source-replay-v1';
      conflict: 'preview-source-conflict-v1';
      refreshUnauthorized: 'preview-refresh-unauthorized-v1';
      refreshValidation: 'preview-refresh-validation-v1';
      refreshUnsafe: 'preview-refresh-unsafe-v1';
      refreshOutage: 'preview-refresh-outage-v1';
      refreshCreated: 'preview-refresh-created-v1';
    }>;
    ingestionIds: Readonly<{
      created: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      refresh: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
      running: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
      completed: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
      unauthorized: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
      outage: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
      missing: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7';
    }>;
    validationPaddingChars: 5000;
    sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  }>;
  readonly fixtures: Readonly<{
    completed: '11111111-1111-4111-8111-111111111111';
    failed: '22222222-2222-4222-8222-222222222222';
    cancellable: '33333333-3333-4333-8333-333333333333';
    terminal: '44444444-4444-4444-8444-444444444444';
    repositoryUnavailable: '55555555-5555-4555-8555-555555555555';
    missing: '66666666-6666-4666-8666-666666666666';
    authUnavailable: '77777777-7777-4777-8777-777777777777';
    unauthorized: '88888888-8888-4888-8888-888888888888';
    cancellationUnavailable: '99999999-9999-4999-8999-999999999999';
  }>;
}

export const NATIVE_PR_PREVIEW_E2E_CONTRACT:
  NativePrPreviewE2eContract;
