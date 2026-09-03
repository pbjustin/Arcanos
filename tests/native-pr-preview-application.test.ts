import { describe, expect, it } from '@jest/globals';
import request from 'supertest';

import {
  createNativePrPreviewApplication,
  createNativePrPreviewReadinessState,
} from '../src/nativePrPreviewApplication.js';
import {
  NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_CONTRACT,
  NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT,
  NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT,
  NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_CONTRACT,
  NATIVE_PR_PREVIEW_FIXTURE_IDS,
  NATIVE_PR_PREVIEW_GAMING_CONTRACT,
  NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT,
  NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT,
  NATIVE_PR_PREVIEW_MODE,
  NATIVE_PR_PREVIEW_RESEARCH_CONTRACT,
  NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT,
  NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_CONTRACT,
  NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER,
} from '../src/nativePrPreviewContract.js';
import {
  resolveNativePrPreviewChildEnvironment,
} from '../src/start-native-pr-preview.js';

const identity = {
  prNumber: 1413,
  sourceCommit: 'a'.repeat(40),
};
const FIXTURE_CREATED_AT = '2026-07-30T00:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-07-30T00:00:01.000Z';

function expectedJobLinks(jobId: string) {
  return {
    poll: `/jobs/${jobId}/result`,
    stream: `/jobs/${jobId}/stream`,
  };
}

function expectedStatusBody(
  jobId: string,
  status: 'cancelled' | 'completed' | 'failed' | 'pending',
  options: {
    answer?: string;
    cancelReason?: string;
    errorMessage?: string;
  } = {}
) {
  const terminal = status !== 'pending';
  const result = options.answer === undefined
    ? null
    : { ok: true, result: { answer: options.answer } };
  return {
    id: jobId,
    jobId,
    job_type: 'gpt',
    status,
    lifecycle_status: status === 'pending' ? 'queued' : status,
    created_at: FIXTURE_CREATED_AT,
    updated_at: terminal ? FIXTURE_COMPLETED_AT : FIXTURE_CREATED_AT,
    completed_at: terminal ? FIXTURE_COMPLETED_AT : null,
    cancel_requested_at:
      status === 'cancelled' ? FIXTURE_COMPLETED_AT : null,
    cancel_reason: options.cancelReason ?? null,
    retention_until: null,
    idempotency_until: null,
    expires_at: null,
    ...expectedJobLinks(jobId),
    error_message: options.errorMessage ?? null,
    output: result,
    result,
  };
}

function expectedResultBody(
  jobId: string,
  status: 'completed' | 'failed' | 'pending',
  options: {
    answer?: string;
    error?: object;
  } = {}
) {
  const terminal = status !== 'pending';
  return {
    jobId,
    status,
    jobStatus: status,
    lifecycleStatus: status === 'pending' ? 'queued' : status,
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: terminal ? FIXTURE_COMPLETED_AT : FIXTURE_CREATED_AT,
    completedAt: terminal ? FIXTURE_COMPLETED_AT : null,
    retentionUntil: null,
    idempotencyUntil: null,
    expiresAt: null,
    ...expectedJobLinks(jobId),
    result: options.answer === undefined
      ? null
      : { ok: true, result: { answer: options.answer } },
    error: options.error ?? null,
  };
}

function buildApplication() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({
    identity,
    readinessState,
    notionConnectivityProbe: async () => ({
      apiReached: true,
      authenticationRejected: true,
    }),
  });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;
  readinessState.ready = true;
  return { app, readinessState };
}

function expectNoStore(response: { headers: Record<string, string | undefined> }): void {
  expect(response.headers['cache-control']).toContain('no-store');
}

function expectContainedResponseHeaders(
  response: { headers: Record<string, string | undefined> },
  requestId: string,
  traceId: string,
  synthetic = false,
): void {
  expectNoStore(response);
  expect(response.headers['x-request-id']).toBe(requestId);
  expect(response.headers['x-trace-id']).toBe(traceId);
  expect(response.headers['content-security-policy']).toBe(
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
  expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(response.headers['permissions-policy']).toBe(
    'camera=(), geolocation=(), microphone=()'
  );
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['strict-transport-security']).toBe(
    'max-age=31536000; includeSubDomains'
  );
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-frame-options']).toBe('DENY');
  if (synthetic) {
    expect(
      response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]
    ).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
  }
}

function gamingSourceIngestionBody(
  idempotencyKey: string,
  extraPayload: Record<string, unknown> = {},
) {
  return {
    action: 'ingest',
    payload: {
      game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
      sourceUrls: ['https://example.invalid/palworld/guide'],
      origin: 'user_supplied',
      idempotencyKey,
      ...extraPayload,
    },
  };
}

function gamingSourceRefreshBody(
  idempotencyKey: string,
  extraPayload: Record<string, unknown> = {},
) {
  return {
    action: 'refresh',
    payload: {
      sourceIds: [NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.sourceId],
      idempotencyKey,
      reason: 'user_requested',
      ...extraPayload,
    },
  };
}

function percentEncodeEveryAsciiCharacter(value: string): string {
  return [...value].map((character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  )).join('');
}

function expectedResearchAccepted(
  fixture: string,
  normalized: {
    topicLength: number;
    urlAggregateLength: number;
    urlCount: number;
    urlItemMaxLength: number;
  },
  extra: Record<string, unknown> = {}
) {
  return {
    accepted: true,
    confirmationAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    fixture,
    normalized,
    postValidationBoundaryReached: true,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    ...extra,
    validationCompleted: true,
    validationCode: 'VALID',
  };
}

function expectedResearchInvalid(fixture: string) {
  return {
    accepted: false,
    confirmationAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: false,
    fixture,
    postValidationBoundaryReached: false,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    validationCompleted: true,
    validationCode: 'RESEARCH_REQUEST_INVALID',
  };
}

function expectedResearchCancellationDrain(fixture: string) {
  const scenario = (
    name: string,
    trigger: 'parent-abort' | 'timeout',
    abortStage: string,
    startedStages: string[],
  ) => ({
    abortObserved: true,
    abortReasonName: 'AbortError',
    abortStage,
    activeWorkAtAbortObservation: 1,
    activeWorkAtOutwardSettlement: 0,
    callbackSettledAtOutwardSettlement: true,
    drainCompletedAtOutwardSettlement: true,
    laterStageStarts: 0,
    name,
    noPostOutwardSettlementMutation: true,
    sameWorkflowDeadlineAcrossStages: true,
    sameWorkflowSignalAcrossStages: true,
    settledStages: [...startedStages],
    startedStages,
    trigger,
  });
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: false,
    fixture,
    memoryBoundaryReached: false,
    networkBoundaryReached: false,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    cancellation: {
      componentExecuted: true,
      noDetachedWorkAtOutwardSettlement: true,
      scenarioCount: 4,
      scenarios: [
        scenario('timeout-dns', 'timeout', 'dns', ['dns']),
        scenario(
          'parent-abort-fetch',
          'parent-abort',
          'fetch',
          ['dns', 'fetch'],
        ),
        scenario(
          'parent-abort-model',
          'parent-abort',
          'model',
          ['dns', 'fetch', 'model'],
        ),
        scenario(
          'parent-abort-persistence',
          'parent-abort',
          'persistence',
          ['dns', 'fetch', 'model', 'persistence'],
        ),
      ],
      syntheticSeams: ['dns', 'fetch', 'model', 'persistence'],
    },
  };
}

function expectedStorylineLifecycle(fixture: string) {
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    fixture,
    durablePersistenceAttempted: false,
    postValidationBoundaryReached: true,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    transactionComponentExecuted: true,
    validationCompleted: true,
    validationCode: 'VALID',
    lifecycle: {
      exactBytes: 16_384,
      finalResponseSequences: Array.from(
        { length: 25 },
        (_, index) => 78 + index
      ),
      firstAcceptedBeatIncluded: true,
      firstAncientBeatRetained: true,
      firstNewestSequence: 101,
      firstOldestSequence: 2,
      firstResponseFirstSequence: 77,
      firstResponseLastSequence: 101,
      freshReadObservedPriorAcceptedBeat: true,
      mutationCount: 2,
      queryPhaseCount: 20,
      responseCount: 25,
      responseLimit: 25,
      retainedCount: 100,
      retentionLimit: 100,
      secondAcceptedBeatIncluded: true,
      secondNewestSequence: 102,
      secondOldestSequence: 3,
      transactionPhaseOrderVerified: true,
    },
  };
}

function expectedStorylinePayloadOver(fixture: string) {
  return {
    accepted: false,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: false,
    fixture,
    durablePersistenceAttempted: false,
    postValidationBoundaryReached: false,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    transactionComponentExecuted: false,
    validationCompleted: true,
    validationCode: 'BACKSTAGE_STORYLINE_INVALID',
  };
}

function expectedSavedStorylineProjection(fixture: string) {
  return {
    accepted: true,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    externalNetworkAttempted: false,
    fixture,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    sqlProjectionExecuted: false,
    universeReadProjection: {
      componentExecuted: true,
      excerptCodePoints: 1_500,
      excerptLimitCodePoints: 1_500,
      leadingWhitespaceCodePoints: 2_500,
      leadingWhitespaceTrimmed: true,
      meaningfulInputCodePoints: 1_501,
      repositoryTransferLimitCodePoints: 1_501,
      storylineExcerpt: 'N'.repeat(1_500),
      truncated: true,
    },
  };
}

function expectedStorylineSummaryPagination(fixture: string) {
  return {
    accepted: true,
    authenticationBoundaryReached: false,
    canonicalRouteReached: false,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    externalNetworkAttempted: false,
    fixture,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    sqlProjectionExecuted: false,
    storylineSummaryPagination: {
      componentExecuted: true,
      emptySummaryPreserved: true,
      exactMaximumCodePoints: 10_000,
      exactReconstructionVerified: true,
      notFoundRejected: true,
      nullSummaryPreserved: true,
      outOfRangeRejected: true,
      pageCodePointLimit: 4_000,
      pages: [
        {
          endCodePointExclusive: 4_000,
          hasMore: true,
          nextOffset: 4_000,
          startCodePoint: 0,
          textCodePoints: 4_000,
          textCodeUnits: 6_000,
        },
        {
          endCodePointExclusive: 8_000,
          hasMore: true,
          nextOffset: 8_000,
          startCodePoint: 4_000,
          textCodePoints: 4_000,
          textCodeUnits: 6_000,
        },
        {
          endCodePointExclusive: 10_000,
          hasMore: false,
          nextOffset: null,
          startCodePoint: 8_000,
          textCodePoints: 2_000,
          textCodeUnits: 3_000,
        },
      ],
      scopeMismatchRejected: true,
      unicodeCodePointPagingVerified: true,
      versionFenceVerified: true,
    },
  };
}

function expectedPhaseOneUniverseBinding(fixture: string) {
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    fixture,
    durablePersistenceAttempted: false,
    postValidationBoundaryReached: true,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    transactionComponentExecuted: true,
    validationCompleted: true,
    validationCode: 'VALID',
    phaseOne: {
      action: 'trackStoryline',
      canonicalRoute: '/gpt/backstage-booker',
      confirmationFingerprintInputUniverseBound: true,
      confirmationTokenIssued: false,
      crossUniverseLeakageObserved: false,
      queryPhaseCount: 20,
      queryUniverseRoutingVerified: true,
      universes: [
        { universeId: 'preview-alpha', retainedSequences: [1, 101] },
        { universeId: 'preview-beta', retainedSequences: [2, 202] },
      ],
    },
  };
}

function expectedMcpBodyCap(fixture: string) {
  const profiles = [
    {
      configuredMcpLimit: '8mb',
      effectiveLimitBytes: 1024 * 1024,
      globalJsonLimit: '10mb',
      name: 'hard-maximum',
    },
    {
      configuredMcpLimit: '512kb',
      effectiveLimitBytes: 512 * 1024,
      globalJsonLimit: '10mb',
      name: 'mcp-configured',
    },
    {
      configuredMcpLimit: '1mb',
      effectiveLimitBytes: 256 * 1024,
      globalJsonLimit: '256kb',
      name: 'global-json',
    },
  ];
  const cases = profiles.flatMap(profile => [0, 1].map(delta => {
    const accepted = delta === 0;
    const bodyBytes = profile.effectiveLimitBytes + delta;
    return {
      accepted,
      bodyBytes,
      cacheControl: 'no-store',
      configuredMcpLimit: profile.configuredMcpLimit,
      effectiveLimitBytes: profile.effectiveLimitBytes,
      globalJsonLimit: profile.globalJsonLimit,
      name: `${profile.name}-${accepted ? 'exact' : 'over'}`,
      nextCalls: accepted ? 1 : 0,
      parsedPaddingLength: accepted ? bodyBytes - 14 : null,
      pragma: 'no-cache',
      rejection: accepted
        ? null
        : {
            error: 'MCP_REQUEST_TOO_LARGE',
            message: 'MCP request body is too large.',
          },
      statusCode: accepted ? 200 : 413,
      streamedWithoutContentLength: true,
    };
  }));
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: false,
    fixture,
    memoryBoundaryReached: false,
    networkBoundaryReached: false,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    bodyCap: {
      callerBodyControlsProbe: false,
      caseCount: 6,
      cases,
      componentExecuted: true,
      hardMaximumBytes: 1024 * 1024,
      profileCount: 3,
      serverOwnedBodies: true,
    },
  };
}

describe('native PR contained application', () => {
  it('accepts only the exact credential-empty child environment', () => {
    const childEnvironment = {
      ARCANOS_NATIVE_PR_APPLICATION_PREVIEW: 'v1',
      ARCANOS_PREVIEW_PR_NUMBER: '1413',
      ARCANOS_PREVIEW_SOURCE_COMMIT: 'a'.repeat(40),
      ARCANOS_PROCESS_KIND: 'web',
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      PORT: '8080',
      RUN_WORKERS: 'false',
      TZ: 'UTC',
    };

    expect(resolveNativePrPreviewChildEnvironment(childEnvironment)).toEqual({
      host: '0.0.0.0',
      port: 8080,
      prNumber: 1413,
      sourceCommit: 'a'.repeat(40),
    });
    expect(() => resolveNativePrPreviewChildEnvironment({
      ...childEnvironment,
      DATABASE_URL: 'postgresql://sensitive-sentinel.invalid/database',
    })).toThrow('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
    expect(() => resolveNativePrPreviewChildEnvironment({
      ...childEnvironment,
      NODE_OPTIONS: '--import=./sensitive-sentinel.mjs',
    })).toThrow('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
    expect(() => resolveNativePrPreviewChildEnvironment({
      ...childEnvironment,
      CUSTOM_SECRET: 'sensitive-sentinel',
    })).toThrow('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
  });

  it('advertises an explicit trusted-PR containment scope and exact source identity', async () => {
    const { app } = buildApplication();

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.body).toEqual({
      applicationImported: true,
      fixturesSealed: true,
      mode: NATIVE_PR_PREVIEW_MODE,
      prNumber: 1413,
      processKind: 'web',
      protectedEffectsEnabled: false,
      protectsMaliciousPr: false,
      ready: true,
      requiresPlatformSecretIsolationForUntrustedCode: true,
      sourceCommit: 'a'.repeat(40),
      trustScope: 'trusted-pr-accidental-effects',
    });
  });

  it('serves the canonical Backstage Booker Builder contract without synthetic provenance', async () => {
    const { app } = buildApplication();

    const response = await request(app)
      .get(NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_CONTRACT.path);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8'
    );
    expect(response.headers[
      NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name
    ]).toBeUndefined();
    expect(response.body).toEqual(
      NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_CONTRACT.document
    );
    expect(response.body.info.version).toBe('1.7.0');
    expect(response.body.paths[
      '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result'
    ].get).toMatchObject({
      operationId: 'getBackstageBookerJobResult',
      security: [{ bearerAuth: [] }],
    });

    const [query, credential] = await Promise.all([
      request(app).get(
        `${NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_CONTRACT.path}?cache=true`
      ),
      request(app)
        .get(NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_CONTRACT.path)
        .set('authorization', 'Bearer sensitive-sentinel'),
    ]);
    for (const rejected of [query, credential]) {
      expect(rejected.status).toBe(404);
      expect(rejected.text).toBe('not found');
      expect(JSON.stringify(rejected.headers)).not.toContain(
        'sensitive-sentinel'
      );
    }
  });

  it('returns 503 readiness until import and fixture sealing are complete and while draining', async () => {
    const readinessState = createNativePrPreviewReadinessState();
    const app = createNativePrPreviewApplication({ identity, readinessState });

    const pending = await request(app).get('/readyz');
    expect(pending.status).toBe(503);
    expectNoStore(pending);

    readinessState.applicationImported = true;
    readinessState.fixturesSealed = true;
    readinessState.ready = true;
    expect((await request(app).get('/readyz')).status).toBe(200);

    readinessState.draining = true;
    readinessState.ready = false;
    const draining = await request(app).get('/readyz');
    expect(draining.status).toBe(503);
    expectNoStore(draining);
  });

  it('executes the real generic job handlers against immutable synthetic fixtures', async () => {
    const { app } = buildApplication();
    const completedStatus = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.completed}`);
    const completedResult = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.completed}/result`);
    const failedResult = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.failed}/result`);
    const invalid = await request(app).get('/jobs/not-a-uuid');
    const invalidResult = await request(app).get('/jobs/not-a-uuid/result');
    const invalidCancellation = await request(app)
      .post('/jobs/not-a-uuid/cancel')
      .send({ reason: 'bounded preview check' });
    const missing = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.missing}`);
    const unavailable = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable}`);
    const authUnavailable = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.authUnavailable}`);
    const unauthorized = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.unauthorized}`);

    expect(completedStatus.status).toBe(200);
    expect(completedStatus.body).toEqual(expectedStatusBody(
      NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
      'completed',
      { answer: 'synthetic preview result' }
    ));
    expect(completedResult.status).toBe(200);
    expect(completedResult.body).toEqual(expectedResultBody(
      NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
      'completed',
      { answer: 'synthetic preview result' }
    ));
    expect(failedResult.status).toBe(200);
    expect(failedResult.body).toEqual(expectedResultBody(
      NATIVE_PR_PREVIEW_FIXTURE_IDS.failed,
      'failed',
      {
        error: {
          code: 'JOB_FAILED',
          message: 'Synthetic preview failure.',
          details: {
            lifecycleStatus: 'failed',
            jobStatus: 'failed',
            resultRetained: false,
          },
        },
      }
    ));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'JOB_ID_INVALID' });
    expect(invalidResult.status).toBe(400);
    expect(invalidResult.body).toEqual({ error: 'JOB_ID_INVALID' });
    expect(invalidCancellation.status).toBe(400);
    expect(invalidCancellation.body).toEqual({ error: 'JOB_ID_INVALID' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: 'JOB_REPOSITORY_UNAVAILABLE' });
    expect(authUnavailable.status).toBe(503);
    expect(authUnavailable.body).toEqual({
      error: 'JOB_READ_AUTH_UNAVAILABLE',
      message: 'Async job reads are temporarily unavailable.',
    });
    expect(unauthorized.status).toBe(404);
    expect(unauthorized.body).toEqual({ error: 'JOB_NOT_FOUND' });
    [
      completedStatus,
      completedResult,
      failedResult,
      invalid,
      invalidResult,
      invalidCancellation,
      missing,
      unavailable,
      authUnavailable,
      unauthorized,
    ].forEach(expectNoStore);
  });

  it('executes the real Research validator and storage-key helper against sealed boundary fixtures', async () => {
    const { app } = buildApplication();
    const fixtures = NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures;
    const cases = [
      {
        fixture: fixtures.topicExact,
        status: 200,
        body: expectedResearchAccepted(fixtures.topicExact, {
          topicLength: 500,
          urlAggregateLength: 0,
          urlCount: 0,
          urlItemMaxLength: 0,
        }),
      },
      {
        fixture: fixtures.topicOver,
        status: 400,
        body: expectedResearchInvalid(fixtures.topicOver),
      },
      {
        fixture: fixtures.urlCountExact,
        status: 200,
        body: expectedResearchAccepted(fixtures.urlCountExact, {
          topicLength: 18,
          urlAggregateLength: 0,
          urlCount: 0,
          urlItemMaxLength: 0,
        }),
      },
      {
        fixture: fixtures.urlCountOver,
        status: 400,
        body: expectedResearchInvalid(fixtures.urlCountOver),
      },
      {
        fixture: fixtures.urlItemExact,
        status: 200,
        body: expectedResearchAccepted(fixtures.urlItemExact, {
          topicLength: 17,
          urlAggregateLength: 2_048,
          urlCount: 1,
          urlItemMaxLength: 2_048,
        }),
      },
      {
        fixture: fixtures.urlItemOver,
        status: 400,
        body: expectedResearchInvalid(fixtures.urlItemOver),
      },
      {
        fixture: fixtures.urlAggregateExact,
        status: 200,
        body: expectedResearchAccepted(fixtures.urlAggregateExact, {
          topicLength: 22,
          urlAggregateLength: 16_384,
          urlCount: 8,
          urlItemMaxLength: 2_048,
        }),
      },
      {
        fixture: fixtures.urlAggregateOver,
        status: 400,
        body: expectedResearchInvalid(fixtures.urlAggregateOver),
      },
      {
        fixture: fixtures.urlSnapshot,
        status: 200,
        body: expectedResearchAccepted(
          fixtures.urlSnapshot,
          {
            topicLength: 12,
            urlAggregateLength: 38,
            urlCount: 1,
            urlItemMaxLength: 38,
          },
          {
            snapshot: {
              descriptorReads: 1,
              normalizedUrl: 'https://example.invalid/first-snapshot',
              sourceMutationIsolated: true,
            },
          }
        ),
      },
      {
        fixture: fixtures.storageComponent,
        status: 200,
        body: expectedResearchAccepted(
          fixtures.storageComponent,
          {
            topicLength: 36,
            urlAggregateLength: 0,
            urlCount: 0,
            urlItemMaxLength: 0,
          },
          {
            storage: {
              ascii: true,
              bytes: 97,
              component:
                'abcdefghijklmnopqrstuvwxyz012345-cc4166d770c11a66f226530d5a8d6c2d2b79bae729cf6f4c9350bb4635b8500d',
              deterministic: true,
              maxBytes: 97,
              portablePattern: true,
              withinLimit: true,
            },
          }
        ),
      },
      {
        fixture: fixtures.workflowCancellationDrain,
        status: 200,
        body: expectedResearchCancellationDrain(
          fixtures.workflowCancellationDrain,
        ),
      },
    ];

    for (const requestCase of cases) {
      const response = await request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .send({ fixture: requestCase.fixture });

      expect(response.status).toBe(requestCase.status);
      expect(response.body).toEqual(requestCase.body);
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('rejects unsealed Research fixture requests before contract evaluation', async () => {
    const { app } = buildApplication();
    const responses = await Promise.all([
      request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .send({ fixture: 'unlisted' }),
      request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .send({
          fixture:
            NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures.topicExact,
          extra: true,
        }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'PREVIEW_RESEARCH_FIXTURE_INVALID',
      });
      expectNoStore(response);
    }
  });

  it('keeps the Research cancellation-drain proof isolated across requests', async () => {
    const { app } = buildApplication();
    const fixture =
      NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures.workflowCancellationDrain;
    const [first, second] = await Promise.all([
      request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .send({ fixture }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual(expectedResearchCancellationDrain(fixture));
    expect(second.body).toEqual(first.body);
    expect(first.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(first.text, 'utf8'))
    );
    expect(second.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(second.text, 'utf8'))
    );
    expectNoStore(first);
    expectNoStore(second);
  });

  it('keeps the Research fixture selector behind transport and credential boundaries', async () => {
    const { app } = buildApplication();
    const fixture =
      NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures.topicExact;
    const credentialCarrierHeaders = [
      'authorization',
      'proxy-authorization',
      'x-api-key',
      'x-debug-key',
      'x-metrics-token',
      'x-preview-credential',
      'x-preview-secret',
      'x-preview-session',
      'x-preview-token',
    ];
    const responses = await Promise.all([
      request(app)
        .post(`${NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path}?fixture=${fixture}`)
        .send({ fixture }),
      request(app)
        .post('/research%2fcontract')
        .send({ fixture }),
      ...credentialCarrierHeaders.map((headerName) =>
        request(app)
          .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
          .set(headerName, 'sensitive-sentinel')
          .send({ fixture })
      ),
      request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .set('content-encoding', 'gzip')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path)
        .send({ fixture: 'x'.repeat(4_097) }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('executes the real Backstage storyline lifecycle components against sealed fixtures', async () => {
    const { app } = buildApplication();
    const fixtures = NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.fixtures;
    const cases = [
      {
        fixture: fixtures.lifecycleExact,
        status: 200,
        body: expectedStorylineLifecycle(fixtures.lifecycleExact),
      },
      {
        fixture: fixtures.phaseOneUniverseBinding,
        status: 200,
        body: expectedPhaseOneUniverseBinding(fixtures.phaseOneUniverseBinding),
      },
      {
        fixture: fixtures.payloadOver,
        status: 400,
        body: expectedStorylinePayloadOver(fixtures.payloadOver),
      },
      {
        fixture: fixtures.savedStorylineProjection,
        status: 200,
        body: expectedSavedStorylineProjection(
          fixtures.savedStorylineProjection
        ),
      },
      {
        fixture: fixtures.summaryPagination,
        status: 200,
        body: expectedStorylineSummaryPagination(
          fixtures.summaryPagination
        ),
      },
    ];

    for (const requestCase of cases) {
      const response = await request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .send({ fixture: requestCase.fixture });

      expect(response.status).toBe(requestCase.status);
      expect(response.body).toEqual(requestCase.body);
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
      expectContainedResponseHeaders(
        response,
        'native-pr-preview',
        'native-pr-preview',
        true
      );
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }

    const repeatedLifecycleResponses = await Promise.all([
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .send({ fixture: fixtures.lifecycleExact }),
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .send({ fixture: fixtures.lifecycleExact }),
    ]);
    expect(repeatedLifecycleResponses[0]?.status).toBe(200);
    expect(repeatedLifecycleResponses[1]?.status).toBe(200);
    expect(repeatedLifecycleResponses[0]?.text).toBe(
      repeatedLifecycleResponses[1]?.text
    );
  });

  it('keeps Backstage storyline fixtures sealed and transport-contained', async () => {
    const { app } = buildApplication();
    const fixture =
      NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.fixtures.lifecycleExact;
    const responses = await Promise.all([
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .send({ fixture: 'unlisted' }),
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .send({ fixture, extra: true }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'PREVIEW_BACKSTAGE_STORYLINE_FIXTURE_INVALID',
      });
      expectNoStore(response);
    }

    const deniedResponses = await Promise.all([
      request(app)
        .post(
          `${NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path}?fixture=${fixture}`
        )
        .send({ fixture }),
      request(app)
        .post('/backstage%2fstoryline-contract')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .set('authorization', 'Bearer sensitive-sentinel')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .set('content-encoding', 'gzip')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path)
        .send({ fixture: 'x'.repeat(4_097) }),
      request(app)
        .post('/backstage/track-storyline')
        .send({ sequence: 1 }),
    ]);

    for (const response of deniedResponses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('executes sealed Backstage generation, HRC cache, review, Notion authority, and continuity contracts', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT;
    const routeBudget = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.routeBudget });
    const hrcRetryCache = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.hrcRetryCache });
    const reviewCompletion = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.reviewCompletion });
    const compactRetry = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.compactRetry });
    const productionOutputContracts = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.productionOutputContracts });
    const notionAuthorityRag = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.notionAuthorityRag });
    const partitionFailureTelemetry = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.partitionFailureTelemetry });
    const continuityQuery = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.continuityQuery });
    const continuitySubtree = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.continuitySubtree });

    expect(routeBudget.status).toBe(200);
    expect(routeBudget.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      canonicalRouteRecognized: true,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.routeBudget,
      generationStageTimeoutMs: 40_000,
      genericRouteBoundaryMs: 6_000,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      routeTimeoutMs: 60_000,
      schemaVersion: 1,
      syntheticProviderCompleted: true,
      syntheticProviderDelayMs: 13_250,
      trinityRunOptions: {
        answerMode: 'direct',
        modelStageTimeoutMs: 40_000,
        strictUserVisibleOutput: true,
      },
    });
    expect(hrcRetryCache.status).toBe(200);
    expect(hrcRetryCache.body).toEqual({
      accepted: true,
      cacheBoundaryReached: true,
      cacheWrites: 1,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      evaluationCalls: 2,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.hrcRetryCache,
      first: {
        cacheable: false,
        verdict: 'Synthetic HRC timeout fallback',
      },
      hrcEvaluationTimeoutMs: 10_000,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      second: {
        cacheable: true,
        verdict: 'Synthetic HRC retry succeeded',
      },
      syntheticTimeoutMs: 25,
      thirdServedFromCache: true,
    });
    expect(reviewCompletion.status).toBe(200);
    expect(reviewCompletion.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      classification: {
        astralQuotedDirectiveParity: true,
        balancedPostQuoteRebookOrdinary: true,
        balancedQuotedDirectiveIgnored: true,
        explicitRebookDirectiveOrdinary: true,
        fullReviewBounded: true,
        mixedCreativeOrdinary: true,
        namedEventReviewsBounded: true,
        narrowAnalysisOrdinary: true,
        narrowNamedEventReviewsOrdinary: true,
        politeReviewBounded: true,
        quotedContractionsIgnored: true,
        stateFieldsIgnored: true,
        unmatchedQuoteRebookOrdinary: true,
      },
      contracts: {
        authoritativeSixBulletOverride: true,
        backstageCaveatReview: true,
        backstageCollapsedCaveatReview: true,
        backstageInitialsReview: true,
        backstageMarkdownReview: true,
        backstageSingleInitialReview: true,
        quotedContractionWorkBound: true,
        reviewStyleInstruction: true,
        reviewTokenLimit: true,
        trinityCollapsedDirectAnswer: true,
        trinityDirectAnswer: true,
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.reviewCompletion,
      normalization: {
        authoritativeReviewBulletCount: 6,
        caveatReview: [
          "1. I can't verify current external state here without live access. Overall verdict: the card delivered a disciplined escalation.",
          '2. Match results: Alpha winner preserved the planned hierarchy.',
          '3. Promos and segments: Bravo segment sharpened the central conflict.',
          '4. Rivalry continuity: Charlie thread honored the established canon.',
          '5. Pacing and structure: Delta transition kept the second hour moving.',
          '6. Remaining matches: Echo finish should determine the next branch.',
        ].join('\n'),
        collapsedCaveatReview: [
          "1. I can't verify current external state here without live access.",
          '2. Match results: Alpha winner preserved the planned hierarchy.',
          '3. Promos and segments: Bravo segment sharpened the central conflict.',
          '4. Rivalry continuity: Charlie thread honored the established canon.',
          '5. Pacing and structure: Delta transition kept the second hour moving.',
          '6. Remaining matches: Echo finish should determine the next branch.',
        ].join('\n'),
        initialsReview:
          '1. J. J. Dillon backed A.J. Styles after the U.S. title match. His decision clarified the feud.',
        markdownReview: [
          '1. The card has a coherent through-line.',
          '2. The results preserve the planned hierarchy.',
          '3. The promos sharpen the central conflict.',
          '4. The rivalries honor established continuity.',
          '5. The pacing builds toward the closing stretch.',
          '6. The unfinished matches should determine the next branch.',
        ].join('\n'),
        numberedBulletCount: 6,
        quoteLookaheadScans: 4,
        quotedContractionCount: 256,
        singleInitialReview:
          '1. Bret J. Hart won cleanly. His follow-up promo advanced the feud.',
      },
      policy: {
        authoritativeBulletCount: 6,
        namedEventTokenLimit: 1_600,
        responseStyleInstruction: [
          'Return exactly 6 top-level numbered bullets:',
          '1. Overall verdict and the show\'s strongest through-line.',
          '2. Match results and ratings that most affected the show.',
          '3. Promos, headcanon, and non-match segments that mattered most.',
          '4. Rivalry development and continuity strengths or problems.',
          '5. Pacing, booking logic, and the highest-value correction.',
          '6. The remaining matches and the best next step.',
          'Use no more than two concise sentences per bullet.',
          'No preamble, headings, sub-bullets, alternative full card, conclusion, or production-notes appendix.',
          'Synthesize instead of recapping: do not re-list the supplied show state, results, ratings, or segments.',
          'Treat matches identified as still to come as unresolved; never invent their results.',
        ].join('\n'),
        tokenLimit: 1_600,
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
    });

    expect(compactRetry.status).toBe(200);
    expect(compactRetry.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      compactRetry: {
        contracts: {
          atMostOverflowRejected: true,
          atMostWithinBoundAccepted: true,
          exactRetryAccepted: true,
          firstPartialDiscarded: true,
          malformedShapeRejected: true,
          noThirdAttempt: true,
          nonLengthFailureNotRetried: true,
          overCountRejected: true,
          retryMarkerOnlyOnSecondCall: true,
          sameRequestStateReused: true,
          secondLengthCollapsed: true,
          underCountRejected: true,
          validNumberedParagraphCount: true,
          wordOverflowRejected: true,
        },
        productionSharedCoordinator: true,
        productionSharedValidator: true,
        syntheticAttemptCount: 2,
        validOutput: [
          '1. Cody challenges Gunther after a tense opening confrontation.',
          '2. Gunther accepts, then closes the segment with a decisive warning.',
        ].join('\n'),
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.compactRetry,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
    });

    const productionScenario = (overrides: Record<string, unknown>) => ({
      budgetClass: 'queued_extended',
      budgetReason: 'queued_structured_generation',
      capacityFormat: 'structured_booking',
      directAnswerMode: true,
      recoveryInstructionVerified: true,
      tokenCap: 6_000,
      tokenLimit: 6_000,
      ...overrides,
    });
    expect(productionOutputContracts.status).toBe(200);
    expect(productionOutputContracts.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.productionOutputContracts,
      outputContracts: {
        contracts: {
          atMostPresentationPreserved: true,
          completeCardHierarchyPreserved: true,
          exactPresentationPreserved: true,
          productionCapacitySelected: true,
        },
        productionSharedBudgetCore: true,
        productionSharedCompactContractCore: true,
        productionSharedPresentationCore: true,
        productionSharedRecoveryCore: true,
        scenarios: {
          atMostCompact: productionScenario({
            completeBookingContainerComponentCount: false,
            enforceParsedItemContract: true,
            explicitCompactOutputRequest: false,
            itemCount: 3,
            itemPolicyMode: 'atMost',
            recoveryMode: 'compact',
            requestedOutputShapeInstructionBound: true,
            responseFormat: 'compact_direct',
          }),
          completeCard: productionScenario({
            completeBookingContainerComponentCount: true,
            enforceParsedItemContract: false,
            explicitCompactOutputRequest: false,
            itemCount: null,
            itemPolicyMode: 'preserve',
            recoveryMode: 'structured',
            requestedOutputShapeInstructionBound: false,
            responseFormat: 'structured_booking',
          }),
          exactCompact: productionScenario({
            completeBookingContainerComponentCount: false,
            enforceParsedItemContract: true,
            explicitCompactOutputRequest: false,
            itemCount: 2,
            itemPolicyMode: 'exact',
            recoveryMode: 'compact',
            requestedOutputShapeInstructionBound: true,
            responseFormat: 'compact_direct',
          }),
        },
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      workerBoundaryReached: false,
    });

    expect(notionAuthorityRag.status).toBe(200);
    expect(notionAuthorityRag.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: true,
      fixture: contract.fixtures.notionAuthorityRag,
      notionAuthority: {
        citationProvenanceVerified: true,
        deterministicContentFixture: true,
        instructionBoundaryPreserved: true,
        liveCredentialUsed: false,
        liveNotionApiReached: true,
        liveNotionAuthenticationRejected: true,
        markdownRequests: 1,
        metadataRequests: 1,
        mutationActionsRecognized: 6,
        productionSharedPageCore: true,
        productionSharedPromptCore: true,
        sanitizationApplied: true,
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      rag: {
        category: 'kayfabe',
        chunkCount: 1,
        citationCount: 1,
        promptTruncated: false,
      },
      schemaVersion: 1,
    });

    expect(partitionFailureTelemetry.status).toBe(200);
    expect(partitionFailureTelemetry.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.partitionFailureTelemetry,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      failureTelemetry: {
        componentExecuted: true,
        deterministicOrderingVerified: true,
        duplicateShardKeyDistinct: true,
        fallbackReasonCodeVerified: true,
        identityFormat:
          'backstage-notion-partition-shard-telemetry-v1',
        maximum: {
          boundedBelowBytes: 65_536,
          failedShardProjectionBytes: 55_314,
          failedShardCount: 512,
          firstShardIdentity:
            'opaque-ISvHkzlJWy0soyLp5CWbKsaJ1QURpKE7gItiNz8POMo',
          lastShardIdentity:
            'opaque-SXtGgR72kUvUwjonh2eKOP24P_CII2IS3pn0aeCaims',
          projectionSha256:
            '967a181c24119cfea50de0371f0a2dd4aa8df28759ea1878546dfbdbf49ce509',
          uniqueIdentityCount: 512,
        },
        loggerSinkExecuted: false,
        productionSharedProjection: true,
        rawIdentifiersAbsent: true,
        rootPageIdAliasProtected: true,
        sampleFailedShards: [
          {
            shardIdentity:
              'opaque-70vMMJ4Z_2lvnrnjSsWlsnORGAg8hXBlhWt8xhTuX68',
            safeReasonCode: 'SHARD_SOURCE_DRIFT',
          },
          {
            shardIdentity:
              'opaque-eVPQRBtG90baOJNEneYPq2OFyWVTFq5HYiTVW5P1NzA',
            safeReasonCode: 'SHARD_SYNC_FAILED',
          },
          {
            shardIdentity:
              'opaque-n07d5-jiZBvYTRnB0U7j1T_7FkWsdYa6sowmW2zV-hM',
            safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
          },
        ],
        validAliasConfigurationParsed: true,
      },
    });
    expect(JSON.stringify(partitionFailureTelemetry.body)).not.toContain(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    );
    expect(JSON.stringify(partitionFailureTelemetry.body)).not.toContain(
      'shared-failure'
    );

    expect(continuityQuery.status).toBe(200);
    expect(continuityQuery.body).toEqual({
      accepted: true,
      actionPolicy: {
        canonicalRouteRecognized: true,
        publicReadOnlyAction: true,
        queryContinuityRecognized: true,
        tokenLimit: 900,
        trinityRunOptionsBound: true,
      },
      cacheBoundaryReached: false,
      continuity: {
        compactRetryBound: true,
        cursorPreflight: {
          completeScopeAccepted: true,
          malformedRejected: true,
          wrongModeRejected: true,
        },
        exhaustiveCoverageInstruction: true,
        instructionBoundaryPreserved: true,
        publicResponse: {
          universeId: 'native-preview-continuity-query',
          authority: 'notion',
          answer:
            "1. Rhea Ripley holds the Women's World Championship on Raw.",
          resolvedScope: {
            pageTitle: 'Monday Night Raw',
            pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
            sectionPath: ['Championships', "Women's World Championship"],
          },
          coverage: {
            status: 'sampled',
            scopeChunks: 1,
            selectedChunks: 1,
            omittedChunks: 0,
            promptTruncated: false,
            exhaustive: false,
            hasMore: false,
          },
          sources: [{
            sourceId:
              '0907207c11757e22e61b23a2d600ecb5813564e6de792700c8629f0cf51a9456',
            pageTitle: 'Monday Night Raw',
            pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
            headingPath: ['Championships', "Women's World Championship"],
            category: 'kayfabe',
            contentHash:
              '9ac466a759d89a5d1db68cb463399d363a17195ab54efe7e04b14aed39df1b91',
          }],
        },
        sampledCoverageInstruction: true,
        sourceProjectionVerified: true,
        syntheticAnswerNormalized: true,
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.continuityQuery,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      rag: {
        category: 'kayfabe',
        chunkCount: 1,
        citationCount: 1,
        promptTruncated: false,
        sanitizationApplied: true,
        sourcePageChunkCount: 2,
      },
      schemaVersion: 1,
    });

    const subtreePagePath = [
      'WWE Universe Mode',
      'Brands',
      'Monday Night Raw',
    ];
    const subtreeResolvedScope = {
      pageTitle: 'Monday Night Raw',
      pagePath: subtreePagePath,
      scopeKind: 'subtree',
    };
    const rootSource = {
      sourceId:
        '1111111111111111111111111111111111111111111111111111111111111111',
      pageTitle: 'Monday Night Raw',
      pagePath: subtreePagePath,
      headingPath: ['Overview'],
      category: 'kayfabe',
      contentHash:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const rosterSource = {
      sourceId:
        '2222222222222222222222222222222222222222222222222222222222222222',
      pageTitle: 'Raw Roster',
      pagePath: [...subtreePagePath, 'Raw Roster'],
      headingPath: ['Champions'],
      category: 'kayfabe',
      contentHash:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const subtreeResponse = (
      coverage: Record<string, unknown>,
      sources: Array<Record<string, unknown>>
    ) => ({
      universeId: 'native-preview-continuity-subtree',
      authority: 'notion',
      answer: '1. The Raw subtree contains root and descendant continuity.',
      resolvedScope: subtreeResolvedScope,
      coverage,
      sources,
    });
    expect(continuitySubtree.status).toBe(200);
    expect(continuitySubtree.body).toEqual({
      accepted: true,
      cacheBoundaryReached: false,
      continuity: {
        contracts: {
          completeScopeAllFixtureSourcesObserved: true,
          incompleteSubtreeCoverageRejected: true,
          pageCoverageTotalsTruthful: true,
          scopeSourcePathsBound: true,
          subtreeFieldsCoupled: true,
          subtreePageCoveragePromptBound: true,
        },
        cursorCodecBoundaryReached: false,
        cursorPreflight: {
          completeScopeShapeAccepted: true,
          malformedRejected: true,
          wrongModeRejected: true,
        },
        completeScopeProjections: {
          first: {
            coverage: {
              status: 'sampled',
              scopeChunks: 3,
              selectedChunks: 2,
              omittedChunks: 1,
              promptTruncated: false,
              exhaustive: false,
              hasMore: true,
              nextCursor:
                'eyJ2IjozLCJmaXh0dXJlIjoic2VhbGVkLXN1YnRyZWUtcHJldmlldyJ9',
              scopePages: 3,
              selectedPages: 2,
              omittedPages: 1,
            },
            sourceIds: [
              '1111111111111111111111111111111111111111111111111111111111111111',
              '2222222222222222222222222222222222222222222222222222222222222222',
            ],
          },
          final: {
            coverage: {
              status: 'sampled',
              scopeChunks: 3,
              selectedChunks: 1,
              omittedChunks: 2,
              promptTruncated: false,
              exhaustive: false,
              hasMore: false,
              scopePages: 3,
              selectedPages: 1,
              omittedPages: 2,
            },
            sourceIds: [
              '3333333333333333333333333333333333333333333333333333333333333333',
            ],
          },
        },
        productionSharedPolicyCore: true,
        productionSharedResponseCore: true,
        publicResponse: subtreeResponse(
          {
            status: 'sampled',
            scopeChunks: 3,
            selectedChunks: 2,
            omittedChunks: 1,
            promptTruncated: false,
            exhaustive: false,
            hasMore: false,
            scopePages: 3,
            selectedPages: 2,
            omittedPages: 1,
          },
          [rootSource, rosterSource]
        ),
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.continuitySubtree,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
    });

    for (const response of [
      routeBudget,
      hrcRetryCache,
      reviewCompletion,
      compactRetry,
      productionOutputContracts,
      notionAuthorityRag,
      partitionFailureTelemetry,
      continuityQuery,
      continuitySubtree,
    ]) {
      expectContainedResponseHeaders(
        response,
        'native-pr-preview',
        'native-pr-preview',
        true
      );
      expect(
        response.headers[contract.proofHeaders.clearPolicyVersion]
      ).toBe(contract.clearPolicyVersion);
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
    }
    expect(
      routeBudget.headers[
        contract.proofHeaders.queueWaitPolicyVersion
      ]
    ).toBe(contract.queueWaitPolicyProofVersion);
    expect(
      routeBudget.headers[
        contract.proofHeaders.trinityReasoningPolicyVersion
      ]
    ).toBe(contract.trinityReasoningPolicyProofVersion);
    expect(
      notionAuthorityRag.headers[
        contract.proofHeaders.partitionedAuthorityVersion
      ]
    ).toBe(contract.partitionedAuthorityProofVersion);
    expect(
      notionAuthorityRag.headers[
        contract.proofHeaders.partitionCutoverRepairVersion
      ]
    ).toBe(contract.partitionCutoverRepairProofVersion);
    expect(
      notionAuthorityRag.headers[
        contract.proofHeaders.notionReadDiagnosticsVersion
      ]
    ).toBe(contract.notionReadDiagnosticsProofVersion);
    const notionDiagnosticsPublicProjection = [
      notionAuthorityRag.text,
      JSON.stringify(notionAuthorityRag.headers),
    ].join('\n');
    expect(notionDiagnosticsPublicProjection).not.toMatch(
      /PRIVATE-NOTION-DIAGNOSTICS|preview-notion-diagnostics|cccccccc-cccc-4ccc-8ccc-cccccccccccc|a0{31}/u
    );
    expect(notionDiagnosticsPublicProjection).not.toContain(
      'BackstageNotionReadError'
    );
    expect(notionDiagnosticsPublicProjection).not.toContain(
      'Backstage Notion reference is unavailable.'
    );
    expect(
      partitionFailureTelemetry.headers[
        contract.proofHeaders.partitionFailureTelemetryVersion
      ]
    ).toBe(contract.partitionFailureTelemetryProofVersion);
    for (const response of [compactRetry, productionOutputContracts]) {
      expect(
        response.headers[
          contract.proofHeaders.outputCapacityPresentationVersion
        ]
      ).toBe(contract.outputCapacityPresentationProofVersion);
    }
    for (const response of [
      hrcRetryCache,
      reviewCompletion,
      compactRetry,
      productionOutputContracts,
      notionAuthorityRag,
      partitionFailureTelemetry,
      continuityQuery,
      continuitySubtree,
    ]) {
      expect(
        response.headers[
          contract.proofHeaders.queueWaitPolicyVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.trinityReasoningPolicyVersion
        ]
      ).toBeUndefined();
    }
    for (const response of [
      routeBudget,
      hrcRetryCache,
      reviewCompletion,
      compactRetry,
      productionOutputContracts,
      partitionFailureTelemetry,
      continuityQuery,
      continuitySubtree,
    ]) {
      expect(
        response.headers[
          contract.proofHeaders.partitionedAuthorityVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.partitionCutoverRepairVersion
        ]
      ).toBeUndefined();
    }
    for (const response of [
      routeBudget,
      hrcRetryCache,
      reviewCompletion,
      compactRetry,
      productionOutputContracts,
      partitionFailureTelemetry,
      continuityQuery,
      continuitySubtree,
    ]) {
      expect(
        response.headers[
          contract.proofHeaders.notionReadDiagnosticsVersion
        ]
      ).toBeUndefined();
    }
    for (const response of [
      routeBudget,
      hrcRetryCache,
      reviewCompletion,
      compactRetry,
      productionOutputContracts,
      notionAuthorityRag,
      continuityQuery,
      continuitySubtree,
    ]) {
      expect(
        response.headers[
          contract.proofHeaders.partitionFailureTelemetryVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.managedAsyncContinuationVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[contract.proofHeaders.gptClientIdentityVersion]
      ).toBeUndefined();
    }
  }, 25_000);

  it('executes sealed output-admission and Notion Phase-A repair contracts', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT;
    const outputAdmission = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.outputAdmission });
    const notionSyncPhaseA = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.notionSyncPhaseA });

    expect(outputAdmission.status).toBe(200);
    expect(outputAdmission.body).toMatchObject({
      accepted: true,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.outputAdmission,
      outputAdmission: {
        contracts: {
          alternativeClassificationVerified: true,
          malformedFirstSuccessRejected: true,
          noFirstSuccessRetry: true,
          validFirstSuccessAccepted: true,
        },
        productionSharedFinalGate: true,
        productionSharedModeCore: true,
        productionSharedOutputContractCore: true,
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      workerBoundaryReached: false,
    });
    expect(outputAdmission.body.outputAdmission.alternativeCases).toHaveLength(8);
    expect(
      outputAdmission.body.outputAdmission.alternativeCases.map(
        (entry: { id: string; responseFormat: string }) => ({
          id: entry.id,
          responseFormat: entry.responseFormat,
        })
      )
    ).toEqual([
      { id: 'detailed-alternatives', responseFormat: 'structured_booking' },
      { id: 'nested-short-alternatives', responseFormat: 'structured_booking' },
      { id: 'slash-delimited-alternatives', responseFormat: 'structured_booking' },
      { id: 'two-dozen-alternatives', responseFormat: 'structured_booking' },
      { id: 'explicit-short-alternatives', responseFormat: 'compact_direct' },
      { id: 'ignore-supersession', responseFormat: 'compact_direct' },
      { id: 'attribution-supersession', responseFormat: 'compact_direct' },
      { id: 'considered-supersession', responseFormat: 'compact_direct' },
    ]);
    expect(outputAdmission.text).not.toContain('Rivalry matrix output');
    expect(
      outputAdmission.headers[contract.proofHeaders.outputAdmissionVersion]
    ).toBe(contract.outputAdmissionProofVersion);

    expect(notionSyncPhaseA.status).toBe(200);
    expect(notionSyncPhaseA.body).toMatchObject({
      accepted: true,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      embeddingBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.notionSyncPhaseA,
      notionApiBoundaryReached: false,
      notionSyncPhaseA: {
        capacity: {
          cases: [
            { chunkCount: 2_048, readable: true, writable: true },
            { chunkCount: 2_117, readable: true, writable: false },
            { chunkCount: 4_096, readable: true, writable: false },
            { chunkCount: 4_097, readable: false, writable: false },
          ],
          readerCeiling: 4_096,
          writerCeiling: 2_048,
          writerRejectionMessage: 'chunks must contain 1-2048 records.',
        },
        contracts: {
          capacitySplitVerified: true,
          lateLeaseReleasedExactlyOnce: true,
          lateNullNotReleased: true,
          preAbortedAcquisitionSkipped: true,
          readableUnchangedSnapshotVerified: true,
          writerFenceRejectedBeforeEffects: true,
        },
        leaseFence: {
          acquireCalls: 1,
          alreadyAbortedAcquireCalls: 0,
          nullReleaseCalls: 0,
          outwardAbortName: 'AbortError',
          releaseCalls: 1,
          releaseCallsBeforeLateSettlement: 0,
          released: [
            {
              universeId: 'native-preview-notion-phase-a',
              holderId: 'native-preview-holder',
              leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad',
            },
          ],
        },
        unchangedDecision: {
          chunkCount: 2_117,
          disposition: 'verify_unchanged',
        },
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      workerBoundaryReached: false,
    });
    expect(
      notionSyncPhaseA.headers[contract.proofHeaders.notionSyncPhaseAVersion]
    ).toBe(contract.notionSyncPhaseAProofVersion);
    expect(
      notionSyncPhaseA.headers[
        contract.proofHeaders.notionWriterCapacityReleaseVersion
      ]
    ).toBe(contract.notionWriterCapacityReleaseProofVersion);

    for (const response of [outputAdmission, notionSyncPhaseA]) {
      expectContainedResponseHeaders(
        response,
        'native-pr-preview',
        'native-pr-preview',
        true
      );
      expect(response.headers[contract.proofHeaders.clearPolicyVersion]).toBe(
        contract.clearPolicyVersion
      );
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
      expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(4_096);
    }
  });

  it('executes the managed Backstage async continuation contract without exposing credentials', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT;
    const response = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.managedAsyncContinuation });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      authentication: {
        currentAccepted: true,
        rotatedAccepted: true,
        missingRejected: true,
        malformedRejected: true,
        wrongRejected: true,
        duplicateRejected: true,
        emptyRejected: true,
        unavailableRejected: true,
        collisionRejected: true,
        stablePrincipalAcrossRotation: true,
        legacyIdentityChangesAcrossRotation: true,
      },
      cacheBoundaryReached: false,
      continuation: {
        allManagedPolls: true,
        managedCreationCapabilitiesRemoved: true,
        managedPoll:
          '/gpt-access/capabilities/v1/backstage-booker/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac/result',
        repositoryReads: 2,
        stateProjectionVerified: true,
        terminalMaterializationVerified: true,
        waiterCalls: 1,
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.managedAsyncContinuation,
      ownership: {
        stableJobReadableAfterRotation: true,
        legacyJobReadableDuringCutover: true,
        rotatedLegacyJobHidden: true,
        wrongScopeHidden: true,
        nonPublicJobHidden: true,
        nonGptJobHidden: true,
        malformedJobHidden: true,
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      sensitiveValuesAbsent: true,
      workerBoundaryReached: false,
    });
    expectContainedResponseHeaders(
      response,
      'native-pr-preview',
      'native-pr-preview',
      true
    );
    expect(response.headers[contract.proofHeaders.clearPolicyVersion]).toBe(
      contract.clearPolicyVersion
    );
    expect(
      response.headers[
        contract.proofHeaders.managedAsyncContinuationVersion
      ]
    ).toBe(contract.managedAsyncContinuationProofVersion);
    expect(
      response.headers[
        contract.proofHeaders.protectedFailureNoFallbackVersion
      ]
    ).toBeUndefined();
    expect(response.headers[contract.proofHeaders.queueWaitPolicyVersion])
      .toBeUndefined();
    expect(
      response.headers[contract.proofHeaders.trinityReasoningPolicyVersion]
    ).toBeUndefined();
    expect(response.headers[contract.proofHeaders.partitionedAuthorityVersion])
      .toBeUndefined();
    expect(response.headers[contract.proofHeaders.partitionCutoverRepairVersion])
      .toBeUndefined();
    expect(
      response.headers[
        contract.proofHeaders.partitionFailureTelemetryVersion
      ]
    ).toBeUndefined();
    expect(response.headers[contract.proofHeaders.gptClientIdentityVersion])
      .toBeUndefined();
    expect(response.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(response.text, 'utf8'))
    );
    expect(response.text).not.toContain('native-preview-backstage-');
    expect(response.text).not.toContain('jobReadToken');
    expect(response.text).not.toContain('ciphertext');
    expect(response.text).not.toContain('/stream');
  });

  it('executes the protected continuity failure policy without process fallback or draft output', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT;
    const response = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.protectedFailureNoFallback });
    const projectedFailure = (
      action: 'generateBooking' | 'generateBookingWithHRC',
      errorCode:
        | 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE'
        | 'BACKSTAGE_ASYNC_EXECUTION_FAILED'
    ) => ({
      action,
      authority: 'none',
      continuityVerified: false,
      errorCode,
      errorMessage: 'Protected Backstage generation did not complete.',
      fallbackPermitted: false,
      fallbackUsed: false,
      noDraftMaterial: true,
      official: false,
      protected: true,
      protectedGenerationCompleted: false,
      resultIsNull: true,
      snapshotStatus: 'not_applicable',
      status: 'failed',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      continuityPolicy: {
        protectedGeneration: {
          processFallbackReads: 0,
          reason: 'protected_generation',
          state: 'unavailable',
        },
        quarantinedLegacy: {
          processFallbackReads: 0,
          reason: 'legacy_read_quarantined',
          state: 'unavailable',
        },
        protectedAndQuarantined: {
          processFallbackReads: 0,
          reason: 'legacy_read_quarantined',
          state: 'unavailable',
        },
        unprotectedControl: {
          processFallbackReads: 1,
          source: 'process-fallback-control',
          state: 'process_fallback',
        },
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      failureProjection: {
        bothProtectedActionsVerified: true,
        failureOnly: true,
        projections: [
          projectedFailure(
            'generateBooking',
            'BACKSTAGE_NOTION_INDEX_UNAVAILABLE'
          ),
          projectedFailure(
            'generateBookingWithHRC',
            'BACKSTAGE_ASYNC_EXECUTION_FAILED'
          ),
        ],
      },
      fixture: contract.fixtures.protectedFailureNoFallback,
      hrcBoundaryReached: false,
      inMemoryJobReads: 2,
      processFallbackReads: 1,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      queueBoundaryReached: false,
      repositoryBoundaryReached: false,
      schemaVersion: 1,
      workerBoundaryReached: false,
    });
    expectContainedResponseHeaders(
      response,
      'native-pr-preview',
      'native-pr-preview',
      true
    );
    expect(response.headers[contract.proofHeaders.clearPolicyVersion]).toBe(
      contract.clearPolicyVersion
    );
    expect(
      response.headers[
        contract.proofHeaders.protectedFailureNoFallbackVersion
      ]
    ).toBe(contract.protectedFailureNoFallbackProofVersion);
    expect(
      response.headers[contract.proofHeaders.managedAsyncContinuationVersion]
    ).toBeUndefined();
    expect(response.headers[contract.proofHeaders.queueWaitPolicyVersion])
      .toBeUndefined();
    expect(response.headers[contract.proofHeaders.gptClientIdentityVersion])
      .toBeUndefined();
    expect(response.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(response.text, 'utf8'))
    );
    expect(response.text).not.toContain('PRIVATE_NO_FALLBACK_');
    expect(response.text).not.toContain('ciphertext');
    expect(response.text).not.toContain('jobReadToken');
    expect(response.text).not.toContain('"storyline"');
    expect(response.text).not.toContain('"answer"');
    expect(response.text).not.toContain('"draft"');
    expect(response.text).not.toContain('"partial"');
    expect(response.text).not.toContain('"preview"');
  });

  it('executes the sealed GPT client identity and durable provenance contract', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT;
    const response = await request(app)
      .post(contract.path)
      .send({ fixture: contract.fixtures.gptClientIdentity });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      authentication: {
        currentAccepted: true,
        missingRejected: true,
        registryResolutionCount: 2,
        rotatedAccepted: true,
        unauthenticatedResolutionSkipped: true,
        wrongRejected: true,
      },
      cacheBoundaryReached: false,
      canonicalRouteReached: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: contract.fixtures.gptClientIdentity,
      identity: {
        authenticationType: 'managed-api-key',
        clientId: 'backstage-booker',
        frozen: true,
        gptId: 'backstage-booker',
        modelIdentityAssurance: 'unknown',
        registeredModelProfile: null,
        runtimeModel: null,
        stableAcrossRotation: true,
        telemetry: {
          clientId: 'backstage-booker',
          gptId: 'backstage-booker',
          authenticationType: 'managed-api-key',
          registeredModelProfile: null,
          modelIdentityAssurance: 'unknown',
        },
        telemetryAllowlisted: true,
        typeConfusionRejected: true,
        unknownClientRejected: true,
      },
      protectedEffectsEnabled: false,
      provenance: {
        emptyFallbackValid: true,
        legacyAbsencePreserved: true,
        plannerStatePreserved: true,
        rotationStable: true,
        serializationRoundTripValid: true,
        spoofedSnapshotOverwritten: true,
        tamperedSnapshotRejected: true,
      },
      providerBoundaryReached: false,
      queueBoundaryReached: false,
      repositoryBoundaryReached: false,
      schemaVersion: 1,
      sensitiveValuesAbsent: true,
      workerBoundaryReached: false,
    });
    expectContainedResponseHeaders(
      response,
      'native-pr-preview',
      'native-pr-preview',
      true
    );
    expect(response.headers[contract.proofHeaders.clearPolicyVersion]).toBe(
      contract.clearPolicyVersion
    );
    expect(response.headers[contract.proofHeaders.gptClientIdentityVersion])
      .toBe(contract.gptClientIdentityProofVersion);
    expect(
      response.headers[contract.proofHeaders.managedAsyncContinuationVersion]
    ).toBeUndefined();
    expect(response.headers[contract.proofHeaders.queueWaitPolicyVersion])
      .toBeUndefined();
    expect(response.headers[contract.proofHeaders.partitionedAuthorityVersion])
      .toBeUndefined();
    expect(
      response.headers[
        contract.proofHeaders.partitionFailureTelemetryVersion
      ]
    ).toBeUndefined();
    expect(response.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(response.text, 'utf8'))
    );
    expect(response.text).not.toMatch(
      /native-preview-gpt-client-|caller-controlled-|openai-attested|credentialFingerprint|principalActorKey/u
    );
  });

  it('keeps Backstage generation fixtures sealed', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT;
    const responses = await Promise.all([
      request(app).post(contract.path).send({ fixture: 'unlisted' }),
      request(app)
        .post(contract.path)
        .send({ fixture: contract.fixtures.hrcRetryCache, extra: true }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(
        response.headers[contract.proofHeaders.clearPolicyVersion]
      ).toBeUndefined();
      expect(
        response.headers[contract.proofHeaders.queueWaitPolicyVersion]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.trinityReasoningPolicyVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[contract.proofHeaders.partitionedAuthorityVersion]
      ).toBeUndefined();
      expect(
        response.headers[contract.proofHeaders.partitionCutoverRepairVersion]
      ).toBeUndefined();
      expect(
        response.headers[contract.proofHeaders.notionReadDiagnosticsVersion]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.partitionFailureTelemetryVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.managedAsyncContinuationVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[
          contract.proofHeaders.protectedFailureNoFallbackVersion
        ]
      ).toBeUndefined();
      expect(
        response.headers[contract.proofHeaders.gptClientIdentityVersion]
      ).toBeUndefined();
      expect(response.body).toEqual({
        error: 'PREVIEW_BACKSTAGE_GENERATION_FIXTURE_INVALID',
      });
      expectContainedResponseHeaders(
        response,
        'native-pr-preview',
        'native-pr-preview',
        true
      );
    }
  });

  it('executes the production MCP pre-parser core against sealed streamed body boundaries', async () => {
    const { app } = buildApplication();
    const fixture =
      NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.fixtures.effectiveLimits;
    const response = await request(app)
      .post(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path)
      .send({ fixture });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expectedMcpBodyCap(fixture));
    expect(response.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(response.text, 'utf8'))
    );
    expectNoStore(response);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('executes the production status auth boundary before its streamed body parser', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_CONTRACT;
    const response = await request(app)
      .post(contract.path)
      .set('x-request-id', 'req-status-auth-boundary')
      .set('x-trace-id', 'trace-status-auth-boundary')
      .send({ fixture: contract.fixtures.authBeforeParser });
    const expectedCase = (
      name: string,
      bodyBytes: number,
      bodyBytesRead: number,
      boundaryNextCalls: number,
      parserCalls: number,
      parserNextCalls: number,
      downstreamCalls: number,
      statusCode: number,
      errorCode: string | null,
      parsedPaddingLength: number | null,
    ) => ({
      bodyBytes,
      bodyBytesRead,
      boundaryNextCalls,
      cacheControl: 'no-store',
      downstreamCalls,
      errorCode,
      name,
      parsedPaddingLength,
      parserCalls,
      parserNextCalls,
      pragma: 'no-cache',
      statusCode,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      fixture: contract.fixtures.authBeforeParser,
      filesystemBoundaryReached: false,
      identity,
      memoryBoundaryReached: false,
      networkBoundaryReached: false,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      statusAuthBoundary: {
        authBeforeParser: true,
        bodyLimitBytes: contract.bodyLimitBytes,
        callerBodyControlsProbe: false,
        caseCount: 6,
        cases: [
          expectedCase(
            'auth-unavailable-over', 65_537, 0, 0, 0, 0, 0, 503,
            'CONTROL_PLANE_AUTH_UNAVAILABLE', null
          ),
          expectedCase(
            'missing-auth-over', 65_537, 0, 0, 0, 0, 0, 401,
            'CONTROL_PLANE_AUTH_REQUIRED', null
          ),
          expectedCase(
            'invalid-auth-over', 65_537, 0, 0, 0, 0, 0, 401,
            'CONTROL_PLANE_AUTH_REQUIRED', null
          ),
          expectedCase(
            'read-scope-over', 65_537, 0, 0, 0, 0, 0, 403,
            'CONTROL_PLANE_SCOPE_DENIED', null
          ),
          expectedCase(
            'mcp-scope-exact', 65_536, 65_536, 1, 1, 1, 1, 204,
            null, 65_522
          ),
          expectedCase(
            'mcp-scope-over', 65_537, 65_537, 1, 1, 0, 0, 413,
            'SYSTEM_STATE_REQUEST_INVALID', null
          ),
        ],
        componentExecuted: true,
        downstreamCalls: 1,
        requiredScope: 'mcp:invoke',
        serverOwnedBodies: true,
      },
    });
    expectContainedResponseHeaders(
      response,
      'req-status-auth-boundary',
      'trace-status-auth-boundary',
      true
    );
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers[contract.proofHeaders.authBeforeParser]).toBe(
      'true'
    );
    expect(response.headers[contract.proofHeaders.bodyLimitBytes]).toBe(
      String(contract.bodyLimitBytes)
    );
    expect(response.headers[contract.proofHeaders.downstreamCalls]).toBe('1');
    expect(response.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(response.text, 'utf8'))
    );
    expect(response.text).not.toContain('native-pr-preview-status-boundary');
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('keeps the status auth-boundary fixture sealed before outer parsing', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_CONTRACT;
    const fixture = contract.fixtures.authBeforeParser;
    const invalidResponses = await Promise.all([
      request(app).post(contract.path).send({ fixture: 'unlisted' }),
      request(app).post(contract.path).send({ fixture, extra: true }),
    ]);
    for (const response of invalidResponses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'PREVIEW_STATUS_AUTH_BOUNDARY_FIXTURE_INVALID',
      });
      expectContainedResponseHeaders(
        response,
        'native-pr-preview',
        'native-pr-preview',
        true
      );
    }

    const deniedResponses = await Promise.all([
      request(app).post(`${contract.path}?fixture=${fixture}`).send({ fixture }),
      request(app).post('/status%2fauth-before-parser-contract').send({ fixture }),
      request(app)
        .post(contract.path)
        .set('authorization', 'Bearer sensitive-sentinel')
        .send({ fixture }),
      request(app)
        .post(contract.path)
        .set('content-encoding', 'gzip')
        .send({ fixture }),
      request(app).post(contract.path).send({ fixture: 'x'.repeat(4_097) }),
      request(app).post('/status').send({ fixture }),
      request(app).get(contract.path),
    ]);
    for (const response of deniedResponses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('keeps the MCP body-cap fixture sealed behind the preview transport boundary', async () => {
    const { app } = buildApplication();
    const fixture =
      NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.fixtures.effectiveLimits;
    const invalidResponses = await Promise.all([
      request(app)
        .post(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path)
        .send({ fixture: 'unlisted' }),
      request(app)
        .post(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path)
        .send({ fixture, extra: true }),
    ]);
    for (const response of invalidResponses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'PREVIEW_MCP_BODY_CAP_FIXTURE_INVALID',
      });
      expectNoStore(response);
    }

    const deniedResponses = await Promise.all([
      request(app)
        .post(`${NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path}?fixture=${fixture}`)
        .send({ fixture }),
      request(app)
        .post('/mcp%2fbody-cap-contract')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path)
        .set('authorization', 'Bearer sensitive-sentinel')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path)
        .set('content-encoding', 'gzip')
        .send({ fixture }),
      request(app)
        .post(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path)
        .send({ fixture: 'x'.repeat(4_097) }),
      request(app)
        .post('/mcp')
        .send({ fixture }),
    ]);
    for (const response of deniedResponses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('executes the exact production GPT identifier boundary at 256 and 257 code units', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_CONTRACT;
    const maximum = await request(app)
      .post(contract.path)
      .set('x-request-id', 'req-dispatch-maximum')
      .set('x-trace-id', 'trace-dispatch-maximum')
      .send({ fixture: contract.fixtures.maximumLength });
    const oversized = await request(app)
      .post(contract.path)
      .set('x-request-id', 'req-dispatch-oversized')
      .set('x-trace-id', 'trace-dispatch-oversized')
      .send({ fixture: contract.fixtures.oversized });

    expect(maximum.status).toBe(200);
    expect(maximum.body).toEqual({
      accepted: true,
      actionCodeUnits: 40_000,
      boundaryContinued: true,
      fixture: contract.fixtures.maximumLength,
      gptIdCodeUnits: 256,
      nextCalls: 1,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      quotaBoundaryReached: false,
      schemaVersion: 1,
    });
    expectContainedResponseHeaders(
      maximum,
      'req-dispatch-maximum',
      'trace-dispatch-maximum',
      true
    );

    expect(oversized.status).toBe(400);
    expect(Object.keys(oversized.body).sort()).toEqual([
      '_dispatch',
      '_route',
      'error',
      'executionMode',
      'gptId',
      'ok',
      'routeFamily',
      'target',
    ]);
    expect(oversized.body).toEqual({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'gptId too long',
      },
      _route: {
        requestId: 'req-dispatch-oversized',
        traceId: 'trace-dispatch-oversized',
        gptId: 'invalid',
        timestamp: expect.any(String),
      },
      target: 'gpt',
      routeFamily: 'dispatch',
      gptId: 'invalid',
      executionMode: 'gpt',
      _dispatch: {
        target: 'gpt',
        executionMode: 'gpt',
        reason: 'explicit_target_gpt',
      },
    });
    expect(new Date(oversized.body._route.timestamp).toISOString()).toBe(
      oversized.body._route.timestamp
    );
    expectContainedResponseHeaders(
      oversized,
      'req-dispatch-oversized',
      'trace-dispatch-oversized',
      true
    );

    for (const [response, gptIdLength, nextCalls] of [
      [maximum, 256, 1],
      [oversized, 257, 0],
    ] as const) {
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.headers[contract.proofHeaders.actionLength]).toBe(
        String(contract.actionLength)
      );
      expect(response.headers[contract.proofHeaders.gptIdLength]).toBe(
        String(gptIdLength)
      );
      expect(response.headers[contract.proofHeaders.nextCalls]).toBe(
        String(nextCalls)
      );
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
      expect(response.headers['x-response-truncated']).toBeUndefined();
      expect(response.text).not.toContain(contract.actionMarker);
      expect(response.text).not.toContain('x'.repeat(257));
      expect(response.body.action).toBeUndefined();
      expect(response.body.result).toBeUndefined();
    }
  });

  it('keeps the dispatch identifier fixtures sealed before production parsing', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_CONTRACT;
    const invalidResponses = await Promise.all([
      request(app).post(contract.path).send({ fixture: 'unlisted' }),
      request(app)
        .post(contract.path)
        .send({ fixture: contract.fixtures.oversized, gptId: 'caller-owned' }),
    ]);
    for (const response of invalidResponses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'PREVIEW_DISPATCH_GPT_IDENTIFIER_FIXTURE_INVALID',
      });
      expectContainedResponseHeaders(
        response,
        'native-pr-preview',
        'native-pr-preview',
        true
      );
    }

    const deniedResponses = await Promise.all([
      request(app)
        .post(`${contract.path}?fixture=${contract.fixtures.oversized}`)
        .send({ fixture: contract.fixtures.oversized }),
      request(app)
        .post('/dispatch%2fgpt-identifier-contract')
        .send({ fixture: contract.fixtures.oversized }),
      request(app)
        .post(contract.path)
        .set('authorization', 'Bearer sensitive-sentinel')
        .send({ fixture: contract.fixtures.oversized }),
      request(app)
        .post(contract.path)
        .set('content-encoding', 'gzip')
        .send({ fixture: contract.fixtures.oversized }),
      request(app)
        .post(contract.path)
        .send({ fixture: 'x'.repeat(4_097) }),
      request(app)
        .post('/dispatch')
        .send({ fixture: contract.fixtures.oversized }),
    ]);
    for (const response of deniedResponses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('executes the real effect-free self-heal approval policy through sealed fixtures', async () => {
    const { app } = buildApplication();
    const fixtures = NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.fixtures;
    const responses = await Promise.all(
      Object.values(fixtures).map((fixture) => request(app)
        .post(NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.path)
        .set('x-request-id', `req-${fixture}`)
        .set('x-trace-id', `trace-${fixture}`)
        .send({ fixture }))
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        componentExecuted: true,
        databaseBoundaryReached: false,
        effectsBoundaryReached: false,
        kind: 'predictive_reactive_self_heal_approval_contract',
        memoryBoundaryReached: false,
        outboundNetworkBoundaryReached: false,
        protectedEffectsEnabled: false,
        providerBoundaryReached: false,
        schemaVersion: 1,
        workerBoundaryReached: false,
      }));
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
      expectContainedResponseHeaders(
        response,
        `req-${response.body.fixture}`,
        `trace-${response.body.fixture}`,
        true
      );
    }

    const byFixture = new Map(
      responses.map((response) => [response.body.fixture, response.body.policy])
    );
    expect(byFixture.get(fixtures.deniedOutcomes)).toEqual(expect.objectContaining({
      allReactiveEffectsDenied: true,
      caseCount: 6,
      outcomes: expect.arrayContaining([
        expect.objectContaining({
          name: 'authoritative-refusal',
          approvalSource: 'authoritative_predictive_result',
          allowAutomaticController: false,
          allowReactiveAction: false,
        }),
        expect.objectContaining({
          name: 'deterministic-fallback',
          approvalSource: 'deterministic_fallback',
          allowAutomaticController: false,
          allowReactiveAction: false,
        }),
        expect.objectContaining({
          name: 'attempted-failure',
          approvalSource: 'predictive_execution_uncertain',
          allowAutomaticController: false,
          allowReactiveAction: false,
        }),
      ]),
    }));
    expect(byFixture.get(fixtures.validCompleted)).toEqual({
      confirmedPredictiveExecution: true,
      outcome: {
        name: 'valid-completed',
        approvalSource: 'predictive_already_executed',
        allowLegacyReactiveEffects: false,
        allowReactiveAction: false,
        allowAutomaticController: false,
      },
    });
    expect(byFixture.get(fixtures.incoherentCompleted)).toEqual(
      expect.objectContaining({
        allCompletedStatesRejected: true,
        caseCount: 7,
        outcomes: expect.arrayContaining([
          expect.objectContaining({
            name: 'disabled-completed',
            approvalSource: 'predictive_state_invalid',
            allowAutomaticController: false,
            allowReactiveAction: false,
          }),
        ]),
      })
    );
    expect(byFixture.get(fixtures.disabledLegacy)).toEqual({
      legacyReactivePolicyPreserved: true,
      outcome: {
        name: 'disabled-legacy',
        approvalSource: 'predictive_disabled',
        allowLegacyReactiveEffects: true,
        allowReactiveAction: true,
        allowAutomaticController: true,
      },
    });
    expect(byFixture.get(fixtures.manualIndependence)).toEqual({
      automaticControllerRunAllowed: false,
      manualAuthorityIndependent: true,
      manualControllerRunAllowed: true,
    });
    expect(byFixture.get(fixtures.productionDebugDenial)).toEqual({
      developmentDebugOverrideEligible: true,
      productionDebugDenied: true,
      productionDebugOverrideEligible: false,
    });
  });

  it('keeps the self-heal approval contract sealed and credential-free', async () => {
    const { app } = buildApplication();
    const contract = NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT;
    const fixture = contract.fixtures.validCompleted;
    const invalidResponses = await Promise.all([
      request(app).post(contract.path).send({ fixture: 'unlisted' }),
      request(app).post(contract.path).send({ fixture, extra: true }),
    ]);
    for (const response of invalidResponses) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'PREVIEW_SELF_HEAL_APPROVAL_FIXTURE_INVALID',
      });
      expectNoStore(response);
    }

    const deniedResponses = await Promise.all([
      request(app).post(`${contract.path}?fixture=${fixture}`).send({ fixture }),
      request(app).post('/self-heal%2fapproval-contract').send({ fixture }),
      request(app)
        .post(contract.path)
        .set('authorization', 'Bearer sensitive-sentinel')
        .send({ fixture }),
      request(app)
        .post(contract.path)
        .set('content-encoding', 'gzip')
        .send({ fixture }),
      request(app).post(contract.path).send({ fixture: 'x'.repeat(4_097) }),
      request(app).post('/api/self-improve/run').send({ fixture }),
      request(app).post('/api/self-heal/decide').send({ fixture }),
    ]);
    for (const response of deniedResponses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('serves closed, correlated, bounded public Gaming fixtures without provider execution', async () => {
    const { app } = buildApplication();
    const canaryRequestId = 'req-preview-gaming-canary';
    const canaryTraceId = 'trace-preview-gaming-canary';
    const canary = await request(app)
      .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.canaryPath)
      .set('x-request-id', canaryRequestId)
      .set('x-trace-id', canaryTraceId)
      .send({ action: 'canary', payload: { scope: 'public_pipeline' } });

    expect(canary.status).toBe(200);
    expect(canary.body).toEqual({
      ok: true,
      action: 'canary',
      scope: 'public_pipeline',
      schemaVersion: '1.5.0',
      intent: 'public_canary',
      route: 'public_canary',
      requestId: canaryRequestId,
      traceId: canaryTraceId,
      checks: {
        requestValidation: 'passed',
        dispatcher: 'passed',
        publicRoute: 'passed',
        fixtureValidation: 'passed',
        grounding: 'passed',
        networkRetrieval: 'skipped',
        providerExecution: 'skipped',
        responseConstruction: 'passed',
        responseGuard: 'passed',
      },
      usedFallback: false,
      acceptedSources: 1,
      durationMs: 0,
      message: 'Public ARCANOS Gaming Action pipeline canary passed.',
      fixture: {
        source: 'bundled',
        marker: 'ARCANOS_PUBLIC_CANARY_7F31',
        markerVerified: true,
      },
    });
    expectContainedResponseHeaders(
      canary,
      canaryRequestId,
      canaryTraceId,
      true
    );
    expect(canary.headers['x-response-bytes']).toBe(
      String(Buffer.byteLength(canary.text, 'utf8'))
    );

    for (const mode of ['guide', 'build', 'meta'] as const) {
      const requestId = `req-preview-gaming-${mode}`;
      const traceId = `trace-preview-gaming-${mode}`;
      const response = await request(app)
        .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath)
        .set('x-request-id', requestId)
        .set('x-trace-id', traceId)
        .send({
          action: 'query',
          payload: {
            mode,
            game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
            prompt: NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures[mode],
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        requestId,
        traceId,
        result: {
          ok: true,
          route: 'gaming',
          mode,
          data: {
            response: `Sealed preview ${mode} response.`,
            sources: [],
          },
        },
        _route: {
          gptId: 'arcanos-gaming',
          module: 'ARCANOS:GAMING',
          route: 'gaming',
        },
      });
      expectContainedResponseHeaders(response, requestId, traceId, true);
    }

    const invalidCanary = await request(app)
      .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.canaryPath)
      .set('x-request-id', 'req-preview-canary-invalid')
      .set('x-trace-id', 'trace-preview-canary-invalid')
      .send({
        action: 'canary',
        payload: { scope: 'public_pipeline', unexpected: true },
      });
    const missingMode = await request(app)
      .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath)
      .set('x-request-id', 'req-preview-mode-invalid')
      .set('x-trace-id', 'trace-preview-mode-invalid')
      .send({
        action: 'query',
        payload: {
          game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
          prompt: NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures.guide,
        },
      });
    const operational = await request(app)
      .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath)
      .set('x-request-id', 'req-preview-operational')
      .set('x-trace-id', 'trace-preview-operational')
      .send({
        action: 'query',
        payload: {
          mode: 'guide',
          game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
          prompt: NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures.operational,
        },
      });

    expect(invalidCanary.status).toBe(400);
    expect(invalidCanary.body).toMatchObject({
      ok: false,
      action: 'canary',
      code: 'BAD_REQUEST',
    });
    expect(missingMode.status).toBe(400);
    expect(missingMode.body.error).toEqual({
      code: 'GAMEPLAY_MODE_REQUIRED',
      message:
        "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
    });
    expect(operational.status).toBe(400);
    expect(operational.body).toMatchObject({
      error: { code: 'OPERATIONAL_REQUEST_NOT_GAMEPLAY' },
      _route: { route: 'gaming_operational_guard' },
    });
    expectContainedResponseHeaders(
      invalidCanary,
      'req-preview-canary-invalid',
      'trace-preview-canary-invalid',
      true
    );
    expectContainedResponseHeaders(
      missingMode,
      'req-preview-mode-invalid',
      'trace-preview-mode-invalid',
      true
    );
    expectContainedResponseHeaders(
      operational,
      'req-preview-operational',
      'trace-preview-operational',
      true
    );
  });

  it('keeps exact Gaming-source paths closed with production-shaped unauthenticated responses', async () => {
    const { app } = buildApplication();
    const sources = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT;
    const cases = [
      request(app)
        .post(sources.ingestionPath)
        .set('x-request-id', 'req-source-unauth-ingest')
        .set('x-trace-id', 'trace-source-unauth-ingest')
        .send(gamingSourceIngestionBody(sources.idempotencyKeys.unauthorized)),
      request(app)
        .post(sources.refreshPath)
        .set('x-request-id', 'req-source-unauth-refresh')
        .set('x-trace-id', 'trace-source-unauth-refresh')
        .send(gamingSourceRefreshBody(
          sources.idempotencyKeys.refreshUnauthorized
        )),
      request(app)
        .get(`${sources.statusPathPrefix}${sources.ingestionIds.unauthorized}`)
        .set('x-request-id', 'req-source-unauth-status')
        .set('x-trace-id', 'trace-source-unauth-status'),
      request(app)
        .post(sources.ingestionPath)
        .set('content-type', 'application/json')
        .set('x-request-id', 'req-source-unauth-malformed')
        .set('x-trace-id', 'trace-source-unauth-malformed')
        .send('{"action":'),
      request(app)
        .post(sources.ingestionPath)
        .set('content-type', 'application/json')
        .set('x-request-id', 'req-source-unauth-oversized')
        .set('x-trace-id', 'trace-source-unauth-oversized')
        .send('x'.repeat(16_385)),
      request(app)
        .get(
          `${sources.statusPathPrefix}${percentEncodeEveryAsciiCharacter(sources.ingestionIds.created)}`
        )
        .set('x-request-id', 'req-source-unauth-encoded')
        .set('x-trace-id', 'trace-source-unauth-encoded'),
      request(app)
        .get(
          `${sources.statusPathPrefix}${sources.ingestionIds.created}%2Fextra`
        )
        .set('x-request-id', 'req-source-unauth-noncanonical')
        .set('x-trace-id', 'trace-source-unauth-noncanonical'),
      request(app)
        .options(sources.ingestionPath)
        .set('origin', 'https://example.com')
        .set('access-control-request-method', 'POST')
        .set('x-request-id', 'req-source-unauth-options')
        .set('x-trace-id', 'trace-source-unauth-options'),
    ];
    const responses = await Promise.all(cases);
    const correlations = [
      ['req-source-unauth-ingest', 'trace-source-unauth-ingest'],
      ['req-source-unauth-refresh', 'trace-source-unauth-refresh'],
      ['req-source-unauth-status', 'trace-source-unauth-status'],
      ['req-source-unauth-malformed', 'trace-source-unauth-malformed'],
      ['req-source-unauth-oversized', 'trace-source-unauth-oversized'],
      ['req-source-unauth-encoded', 'trace-source-unauth-encoded'],
      [
        'req-source-unauth-noncanonical',
        'trace-source-unauth-noncanonical',
      ],
      ['req-source-unauth-options', 'trace-source-unauth-options'],
    ];
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'UNAUTHORIZED_GPT_ACCESS',
          message: 'Missing GPT access bearer token.',
        },
      });
      expectContainedResponseHeaders(
        response,
        correlations[index]![0]!,
        correlations[index]![1]!,
        true
      );
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.headers.pragma).toBe('no-cache');
    }
    expect(responses.at(-1)?.headers['access-control-allow-origin'])
      .toBeUndefined();
  });

  it('admits one canonical status decode and closes non-canonical encodings after the simulated selector', async () => {
    const { app } = buildApplication();
    const sources = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT;
    const encodedId = percentEncodeEveryAsciiCharacter(
      sources.ingestionIds.created
    );
    const unauthenticatedEncodedBody = await request(app)
      .get(`${sources.statusPathPrefix}${encodedId}`)
      .set('content-type', 'application/json')
      .set('x-request-id', 'req-source-encoded-body-unauth')
      .set('x-trace-id', 'trace-source-encoded-body-unauth')
      .send('x'.repeat(16_385));
    expect(unauthenticatedEncodedBody.status).toBe(401);
    expect(unauthenticatedEncodedBody.body).toEqual({
      ok: false,
      error: {
        code: 'UNAUTHORIZED_GPT_ACCESS',
        message: 'Missing GPT access bearer token.',
      },
    });
    expectContainedResponseHeaders(
      unauthenticatedEncodedBody,
      'req-source-encoded-body-unauth',
      'trace-source-encoded-body-unauth',
      true
    );
    const canonical = await request(app)
      .get(`${sources.statusPathPrefix}${encodedId}`)
      .set(sources.fixtureHeader, sources.fixtures.statusQueued)
      .set('x-request-id', 'req-source-encoded-queued')
      .set('x-trace-id', 'trace-source-encoded-queued');

    expect(canonical.status).toBe(200);
    expect(canonical.body).toMatchObject({
      ok: true,
      action: 'status',
      ingestionId: sources.ingestionIds.created,
      status: 'queued',
      requestId: 'req-source-encoded-queued',
      traceId: 'trace-source-encoded-queued',
    });
    expectContainedResponseHeaders(
      canonical,
      'req-source-encoded-queued',
      'trace-source-encoded-queued',
      true
    );

    const nonCanonicalPaths = [
      `${sources.statusPathPrefix}${sources.ingestionIds.created}%2Fextra`,
      `${sources.statusPathPrefix}${sources.ingestionIds.created}%5Cextra`,
      `${sources.statusPathPrefix}${sources.ingestionIds.created}%00`,
      `${sources.statusPathPrefix}${sources.ingestionIds.created}%7F`,
      `${sources.statusPathPrefix}${sources.ingestionIds.created}%252Dextra`,
      `${sources.statusPathPrefix}${sources.ingestionIds.created}%GG`,
    ];
    for (const [index, path] of nonCanonicalPaths.entries()) {
      const requestId = `req-source-noncanonical-${index}`;
      const traceId = `trace-source-noncanonical-${index}`;
      const response = await request(app)
        .get(path)
        .set(sources.fixtureHeader, sources.fixtures.statusValidation)
        .set('x-request-id', requestId)
        .set('x-trace-id', traceId);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'GAMING_SOURCE_VALIDATION_ERROR',
          message: 'The Gaming source request is invalid.',
        },
        requestId,
        traceId,
      });
      expectContainedResponseHeaders(response, requestId, traceId, true);
      expect(response.headers.pragma).toBe('no-cache');
    }

    const readWithBody = await request(app)
      .get(`${sources.statusPathPrefix}${encodedId}`)
      .set(sources.fixtureHeader, sources.fixtures.statusQueued)
      .set('content-type', 'application/json')
      .set('x-request-id', 'req-source-encoded-body')
      .set('x-trace-id', 'trace-source-encoded-body')
      .send('{"sentinel":');
    expect(readWithBody.status).toBe(400);
    expect(readWithBody.body).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_VALIDATION_ERROR',
        message: 'The Gaming source request is invalid.',
      },
      requestId: 'req-source-encoded-body',
      traceId: 'trace-source-encoded-body',
    });
    expect(JSON.stringify(readWithBody.body)).not.toContain('sentinel');

    const readWithOversizedBody = await request(app)
      .get(`${sources.statusPathPrefix}${encodedId}`)
      .set(sources.fixtureHeader, sources.fixtures.statusQueued)
      .set('content-type', 'application/json')
      .set('x-request-id', 'req-source-encoded-body-oversized')
      .set('x-trace-id', 'trace-source-encoded-body-oversized')
      .send('x'.repeat(16_385));
    expect(readWithOversizedBody.status).toBe(400);
    expect(readWithOversizedBody.body).toMatchObject({
      error: { code: 'GAMING_SOURCE_VALIDATION_ERROR' },
      requestId: 'req-source-encoded-body-oversized',
      traceId: 'trace-source-encoded-body-oversized',
    });
  });

  it('uses the closed 16 KiB Gaming-source parser boundary after the simulated selector', async () => {
    const { app } = buildApplication();
    const sources = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT;
    const sendParserCase = (
      caseId: string,
      contentType: string,
      body: string
    ) => request(app)
      .post(sources.ingestionPath)
      .set(sources.fixtureHeader, sources.fixtures.validation)
      .set('content-type', contentType)
      .set('x-request-id', `req-${caseId}`)
      .set('x-trace-id', `trace-${caseId}`)
      .send(body);

    const malformed = await sendParserCase(
      'source-parser-malformed',
      'application/json',
      '{"sentinel":'
    );
    const oversized = await sendParserCase(
      'source-parser-oversized',
      'text/plain',
      'x'.repeat(16_385)
    );
    const mediaType = await sendParserCase(
      'source-parser-media-type',
      'text/plain',
      'sealed-preview-media-sentinel'
    );

    for (const [response, caseId, status] of [
      [malformed, 'source-parser-malformed', 400],
      [oversized, 'source-parser-oversized', 413],
      [mediaType, 'source-parser-media-type', 415],
    ] as const) {
      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'GAMING_SOURCE_VALIDATION_ERROR',
          message: 'The Gaming source request is invalid.',
        },
        requestId: `req-${caseId}`,
        traceId: `trace-${caseId}`,
      });
      expectContainedResponseHeaders(
        response,
        `req-${caseId}`,
        `trace-${caseId}`,
        true
      );
      expect(response.headers.pragma).toBe('no-cache');
    }
    expect(JSON.stringify(malformed.body)).not.toContain('sentinel');
    expect(JSON.stringify(mediaType.body)).not.toContain(
      'sealed-preview-media-sentinel'
    );
  });

  it('serves labeled, side-effect-free source admission and idempotency simulations', async () => {
    const { app } = buildApplication();
    const sources = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT;
    const postFixture = (
      path: string,
      fixture: string,
      body: Record<string, unknown>,
      caseId: string,
    ) => request(app)
      .post(path)
      .set(sources.fixtureHeader, fixture)
      .set('x-request-id', `req-${caseId}`)
      .set('x-trace-id', `trace-${caseId}`)
      .send(body);

    const validationBody = gamingSourceIngestionBody(
      sources.idempotencyKeys.validation,
      {
        unexpected: 'x'.repeat(sources.validationPaddingChars),
      }
    );
    const validation = await postFixture(
      sources.ingestionPath,
      sources.fixtures.validation,
      validationBody,
      'source-validation'
    );
    const unsafe = await postFixture(
      sources.ingestionPath,
      sources.fixtures.unsafe,
      gamingSourceIngestionBody(sources.idempotencyKeys.unsafe),
      'source-unsafe'
    );
    const outage = await postFixture(
      sources.ingestionPath,
      sources.fixtures.outage,
      gamingSourceIngestionBody(sources.idempotencyKeys.outage),
      'source-outage'
    );
    const created = await postFixture(
      sources.ingestionPath,
      sources.fixtures.created,
      gamingSourceIngestionBody(sources.idempotencyKeys.created),
      'source-created'
    );
    const replay = await postFixture(
      sources.ingestionPath,
      sources.fixtures.replay,
      gamingSourceIngestionBody(sources.idempotencyKeys.replay),
      'source-replay'
    );
    const conflict = await postFixture(
      sources.ingestionPath,
      sources.fixtures.conflict,
      gamingSourceIngestionBody(sources.idempotencyKeys.conflict),
      'source-conflict'
    );
    const refreshValidation = await postFixture(
      sources.refreshPath,
      sources.fixtures.refreshValidation,
      gamingSourceRefreshBody(
        sources.idempotencyKeys.refreshValidation,
        { unexpected: true }
      ),
      'refresh-validation'
    );
    const refreshUnsafe = await postFixture(
      sources.refreshPath,
      sources.fixtures.refreshUnsafe,
      gamingSourceRefreshBody(sources.idempotencyKeys.refreshUnsafe),
      'refresh-unsafe'
    );
    const refreshOutage = await postFixture(
      sources.refreshPath,
      sources.fixtures.refreshOutage,
      gamingSourceRefreshBody(sources.idempotencyKeys.refreshOutage),
      'refresh-outage'
    );
    const refreshCreated = await postFixture(
      sources.refreshPath,
      sources.fixtures.refreshCreated,
      gamingSourceRefreshBody(sources.idempotencyKeys.refreshCreated),
      'refresh-created'
    );

    expect(Buffer.byteLength(JSON.stringify(validationBody), 'utf8')).toBeGreaterThan(
      4 * 1024
    );
    expect(validation.status).toBe(400);
    expect(validation.body.error.code).toBe('GAMING_SOURCE_VALIDATION_ERROR');
    expect(unsafe.status).toBe(503);
    expect(unsafe.body).toMatchObject({
      error: { code: 'UNSAFE_EXECUTION_DISABLED' },
      requestId: 'req-source-unsafe',
      traceId: 'trace-source-unsafe',
    });
    expect(outage.status).toBe(503);
    expect(outage.body.error.code).toBe('GAMING_SOURCE_JOBS_UNAVAILABLE');
    expect(created.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(created.body).toMatchObject({
      ok: true,
      action: 'ingest',
      ingestionId: sources.ingestionIds.created,
      status: 'queued',
      deduplicated: false,
      sources: [{
        canonicalUrl: 'https://example.invalid/palworld/guide',
        status: 'queued',
      }],
    });
    expect(replay.body).toMatchObject({
      ingestionId: sources.ingestionIds.created,
      deduplicated: true,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe(
      'GAMING_SOURCE_IDEMPOTENCY_CONFLICT'
    );
    expect(refreshValidation.status).toBe(400);
    expect(refreshUnsafe.status).toBe(503);
    expect(refreshUnsafe.body.error.code).toBe('UNSAFE_EXECUTION_DISABLED');
    expect(refreshOutage.status).toBe(503);
    expect(refreshOutage.body).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_STORAGE_UNAVAILABLE',
        message: 'Gaming-source refresh storage is unavailable.',
      },
    });
    expect(refreshCreated.status).toBe(202);
    expect(refreshCreated.body).toMatchObject({
      action: 'refresh',
      ingestionId: sources.ingestionIds.refresh,
      deduplicated: false,
      sources: [{ sourceId: sources.sourceId }],
    });

    for (const [response, caseId] of [
      [validation, 'source-validation'],
      [unsafe, 'source-unsafe'],
      [outage, 'source-outage'],
      [created, 'source-created'],
      [replay, 'source-replay'],
      [conflict, 'source-conflict'],
      [refreshValidation, 'refresh-validation'],
      [refreshUnsafe, 'refresh-unsafe'],
      [refreshOutage, 'refresh-outage'],
      [refreshCreated, 'refresh-created'],
    ] as const) {
      expectContainedResponseHeaders(
        response,
        `req-${caseId}`,
        `trace-${caseId}`,
        true
      );
      expect(response.headers['x-response-bytes']).toBe(
        String(Buffer.byteLength(response.text, 'utf8'))
      );
      expect(response.headers.pragma).toBe('no-cache');
    }
  });

  it('serves a deterministic source status lifecycle plus typed validation, absence, and outage', async () => {
    const { app } = buildApplication();
    const sources = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT;
    const getFixture = (
      ingestionId: string,
      fixture: string,
      caseId: string,
    ) => request(app)
      .get(`${sources.statusPathPrefix}${ingestionId}`)
      .set(sources.fixtureHeader, fixture)
      .set('x-request-id', `req-${caseId}`)
      .set('x-trace-id', `trace-${caseId}`);

    const validation = await getFixture(
      'not-a-uuid',
      sources.fixtures.statusValidation,
      'status-validation'
    );
    const queued = await getFixture(
      sources.ingestionIds.created,
      sources.fixtures.statusQueued,
      'status-queued'
    );
    const running = await getFixture(
      sources.ingestionIds.running,
      sources.fixtures.statusRunning,
      'status-running'
    );
    const completed = await getFixture(
      sources.ingestionIds.completed,
      sources.fixtures.statusCompleted,
      'status-completed'
    );
    const missing = await getFixture(
      sources.ingestionIds.missing,
      sources.fixtures.statusMissing,
      'status-missing'
    );
    const outage = await getFixture(
      sources.ingestionIds.outage,
      sources.fixtures.statusOutage,
      'status-outage'
    );

    expect(validation.status).toBe(400);
    expect(validation.body.error).toEqual({
      code: 'GAMING_SOURCE_VALIDATION_ERROR',
      message: 'ingestionId must be a UUID.',
    });
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({
      action: 'status',
      ingestionId: sources.ingestionIds.created,
      status: 'queued',
      counts: { total: 1, queued: 1, succeeded: 0 },
      sources: [{ status: 'queued' }],
    });
    expect(running.status).toBe(200);
    expect(running.body).toMatchObject({
      ingestionId: sources.ingestionIds.running,
      status: 'running',
      counts: { queued: 0, succeeded: 0 },
      sources: [{ status: 'running' }],
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      ingestionId: sources.ingestionIds.completed,
      status: 'completed',
      counts: { queued: 0, succeeded: 1, recordsCreated: 1 },
      sources: [{
        status: 'stored',
        sourceId: sources.sourceId,
        sourceType: 'wiki',
      }],
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(
      'GAMING_SOURCE_INGESTION_NOT_FOUND'
    );
    expect(outage.status).toBe(503);
    expect(outage.body.error.code).toBe('GAMING_SOURCE_JOBS_UNAVAILABLE');

    for (const [response, caseId] of [
      [validation, 'status-validation'],
      [queued, 'status-queued'],
      [running, 'status-running'],
      [completed, 'status-completed'],
      [missing, 'status-missing'],
      [outage, 'status-outage'],
    ] as const) {
      expectContainedResponseHeaders(
        response,
        `req-${caseId}`,
        `trace-${caseId}`,
        true
      );
      expect(response.headers.pragma).toBe('no-cache');
    }
  });

  it('preserves blanket credential rejection and seals the preview-only selector', async () => {
    const { app } = buildApplication();
    const sources = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT;
    const responses = await Promise.all([
      request(app)
        .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.canaryPath)
        .set('authorization', 'Bearer sensitive-sentinel')
        .send({ action: 'canary', payload: { scope: 'public_pipeline' } }),
      request(app)
        .post(sources.ingestionPath)
        .set('authorization', 'Bearer sensitive-sentinel')
        .set(sources.fixtureHeader, sources.fixtures.created)
        .send(gamingSourceIngestionBody(sources.idempotencyKeys.created)),
      request(app)
        .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath)
        .set(sources.fixtureHeader, sources.fixtures.created)
        .send({
          action: 'query',
          payload: {
            mode: 'guide',
            game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
            prompt: NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures.guide,
          },
        }),
      request(app)
        .post(sources.ingestionPath)
        .set(sources.fixtureHeader, 'unlisted')
        .send(gamingSourceIngestionBody(sources.idempotencyKeys.created)),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expect(response.text).not.toContain('sensitive-sentinel');
      expectNoStore(response);
      expect(
        response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]
      ).toBeUndefined();
    }

    const unsealedValidationResponses = await Promise.all([
      request(app)
        .post(sources.ingestionPath)
        .set(sources.fixtureHeader, sources.fixtures.validation)
        .send(gamingSourceIngestionBody(
          sources.idempotencyKeys.validation,
          {
            sourceUrls: ['https://unsealed.invalid/source'],
            unexpected: 'x'.repeat(sources.validationPaddingChars),
          }
        )),
      request(app)
        .post(sources.refreshPath)
        .set(sources.fixtureHeader, sources.fixtures.refreshValidation)
        .send(gamingSourceRefreshBody(
          sources.idempotencyKeys.refreshValidation,
          {
            sourceIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
            unexpected: true,
          }
        )),
    ]);
    for (const response of unsealedValidationResponses) {
      expect(response.status).toBe(404);
      expect(response.text).toBe('not found');
      expectNoStore(response);
      expect(response.headers.pragma).toBe('no-cache');
      expect(
        response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]
      ).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    }
  });

  it('keeps synthetic cancellation deterministic across repeated runs', async () => {
    const { app } = buildApplication();
    const cancellationPath =
      `/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable}/cancel`;
    const first = await request(app)
      .post(cancellationPath)
      .send({ reason: 'bounded preview check' });
    const second = await request(app)
      .post(cancellationPath)
      .send({ reason: 'bounded preview check' });
    const terminal = await request(app)
      .post(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal}/cancel`)
      .send({ reason: 'bounded preview check' });
    const unavailable = await request(app)
      .post(
        `/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable}/cancel`
      )
      .send({ reason: 'bounded preview check' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({
      ok: true,
      cancellationRequested: false,
      ...expectedStatusBody(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable,
        'cancelled',
        { cancelReason: 'Synthetic preview cancellation.' }
      ),
    });
    expect(second.body).toEqual(first.body);
    expect(terminal.status).toBe(409);
    expect(terminal.body).toEqual({
      ok: false,
      error: {
        code: 'JOB_ALREADY_TERMINAL',
        message: 'Terminal jobs cannot be cancelled.',
      },
      job: expectedStatusBody(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
        'completed',
        { answer: 'synthetic terminal result' }
      ),
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      error: 'JOB_REPOSITORY_UNAVAILABLE',
    });
    [first, second, terminal, unavailable].forEach(expectNoStore);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/gpt/arcanos-core'],
    ['POST', '/memory/save'],
    ['GET', '/metrics'],
    ['GET', '/jobs/11111111-1111-4111-8111-111111111111/stream'],
    ['OPTIONS', '/readyz'],
    ['GET', '/readyz?verbose=true'],
    ['GET', '/health%2fextra'],
  ])('denies every unlisted method/path before application routing: %s %s', async (method, path) => {
    const { app } = buildApplication();
    const response = await request(app)[method.toLowerCase() as 'get'](path);

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expectNoStore(response);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['authorization', 'Bearer sensitive-sentinel'],
    ['cookie', 'session=sensitive-sentinel'],
    ['x-session-id', 'sensitive-sentinel'],
    ['x-arcanos-job-read-token', 'sensitive-sentinel'],
    ['x-openai-action-secret', 'sensitive-sentinel'],
  ])('rejects external credential carrier %s without reflecting it', async (headerName, headerValue) => {
    const { app } = buildApplication();
    const response = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.completed}`)
      .set(headerName, headerValue);

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expect(response.text).not.toContain(headerValue);
    expectNoStore(response);
  });

  it.each([
    ['text/plain', 'non-json cancellation body'],
    ['application/octet-stream', 'opaque cancellation body'],
  ])('rejects non-JSON cancellation bodies before routing: %s', async (
    contentType,
    body
  ) => {
    const { app } = buildApplication();
    const response = await request(app)
      .post(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable}/cancel`)
      .set('content-type', contentType)
      .send(body);

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expectNoStore(response);
  });

  it('rejects bodies on read-only routes before routing', async () => {
    const { app } = buildApplication();
    const response = await request(app)
      .get('/readyz')
      .set('content-type', 'application/json')
      .send({ unexpected: true });

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expectNoStore(response);
  });
});
