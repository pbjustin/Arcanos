import { readFileSync } from 'node:fs';

import type { NextFunction, Request, Response } from 'express';
import { afterAll, describe, expect, it, jest } from '@jest/globals';

const trackedEnvironmentNames = [
  'NODE_ENV',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'RAILWAY_OPENAI_API_KEY',
  'API_KEY',
  'OPENAI_KEY',
  'RUN_WORKERS',
  'DISABLE_EXTERNAL_CALLS',
  'DISABLE_DIAGNOSTICS_CRON',
  'DIAGNOSTICS_SHARED_METRICS',
  'ASK_ROUTE_MODE',
  'PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX',
  'PUBLIC_PROVIDER_RATE_LIMIT_MAX',
  'PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE',
  'PUBLIC_PROVIDER_RATE_LIMIT_STORE',
  'PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS',
  'PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_ID',
] as const;

const originalEnvironment = new Map(
  trackedEnvironmentNames.map((name) => [name, process.env[name]] as const)
);

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.OPENAI_API_KEY = '';
process.env.RAILWAY_OPENAI_API_KEY = '';
process.env.API_KEY = '';
process.env.OPENAI_KEY = '';
process.env.RUN_WORKERS = 'false';
process.env.DISABLE_EXTERNAL_CALLS = 'true';
process.env.DISABLE_DIAGNOSTICS_CRON = 'true';
process.env.DIAGNOSTICS_SHARED_METRICS = 'false';
process.env.ASK_ROUTE_MODE = 'compat';
process.env.PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX = '6';
process.env.PUBLIC_PROVIDER_RATE_LIMIT_MAX = '7';
process.env.PUBLIC_PROVIDER_RATE_LIMIT_STORE = 'memory';
process.env.PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS = '600000';
delete process.env.PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE;
delete process.env.PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_ENVIRONMENT_ID;
delete process.env.RAILWAY_SERVICE_ID;

const executeArcanosPipelineMock = jest.fn(async () => ({
  result: 'pipeline-ok',
  stages: ['analysis', 'draft'],
  meta: {},
  activeModel: 'test-model',
  routingStages: [],
}));
const routeGptRequestMock = jest.fn(async (gptId: string) => ({
  ok: true,
  result: {
    ok: true,
    route: 'diagnostic',
    message: 'backend operational',
  },
  _route: {
    requestId: 'diagnostic-request',
    traceId: 'diagnostic-trace',
    gptId,
    module: 'diagnostic',
    action: 'diagnostic',
    route: 'diagnostic',
    availableActions: [],
    moduleVersion: null,
    timestamp: '2026-07-31T00:00:00.000Z',
  },
}));
const resolveGptRoutingMock = jest.fn(async (gptId: string) => ({
  ok: true,
  plan: {
    matchedId: gptId,
    module: 'ARCANOS:CORE',
    route: 'core',
    action: 'query',
    availableActions: ['query'],
    moduleVersion: null,
    moduleDescription: null,
    matchMethod: 'exact',
  },
  _route: {
    gptId,
    route: 'core',
    module: 'ARCANOS:CORE',
    action: 'query',
    timestamp: '2026-07-31T00:00:00.000Z',
  },
}));
const researchMock = jest.fn(async () => ({
  summary: 'research-ok',
  sources: [],
}));
const executeDirectGptActionMock = jest.fn(async () => ({
  ok: true,
  result: {
    result: 'direct-ok',
    module: 'direct_action',
    activeModel: 'test-model',
    routingStages: ['GPT-DIRECT-ACTION'],
  },
  directAction: {
    inline: true,
    queueBypassed: true,
    orchestrationBypassed: true,
    action: 'query_and_wait',
    timeoutMs: 24_000,
    modelLatencyMs: 1,
    totalLatencyMs: 1,
  },
  _route: {
    requestId: 'direct-request',
    gptId: 'arcanos-core',
    module: 'GPT:DIRECT_ACTION',
    action: 'query_and_wait',
    route: 'direct_action',
    timestamp: '2026-07-31T00:00:00.000Z',
  },
}));
const executeFastGptPromptMock = jest.fn();
const runTrinityWritingPipelineMock = jest.fn(async () => ({
  result: '{}',
  stages: [],
  meta: {},
  activeModel: 'test-model',
  routingStages: [],
}));
let unsafeExecutionDenied = false;
const unsafeExecutionGateMock = jest.fn(
  (_req: Request, res: Response, next: NextFunction) => {
    if (!unsafeExecutionDenied) {
      next();
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({
      ok: false,
      code: 'UNSAFE_EXECUTION_DENIED',
      message: 'Unsafe execution is unavailable.',
    });
  }
);

jest.unstable_mockModule('@services/arcanosPipeline.js', () => ({
  executeArcanosPipeline: executeArcanosPipelineMock,
}));
jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock,
  resolveGptRouting: resolveGptRoutingMock,
}));
jest.unstable_mockModule('@services/researchHub.js', () => ({
  connectResearchBridge: jest.fn(() => ({
    requestResearch: researchMock,
    subscribe: jest.fn(() => jest.fn()),
  })),
  requestResearchViaHub: researchMock,
}));
jest.unstable_mockModule('@services/gptFastPath.js', () => ({
  executeDirectGptAction: executeDirectGptActionMock,
  executeFastGptPrompt: executeFastGptPromptMock,
}));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock,
  applyTrinityGenerationInvariant: (result: unknown) => result,
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn(),
}));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(async (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  }),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary: jest.fn(async () => undefined),
    recordRequestCompletion: jest.fn(),
  },
}));
jest.unstable_mockModule('@transport/http/middleware/unsafeExecutionGate.js', () => ({
  unsafeExecutionGate: unsafeExecutionGateMock,
}));
jest.unstable_mockModule('@transport/http/gamingIngressAudit.js', () => ({
  gamingIngressAudit: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');

function addRotatedCallerMetadata(
  pendingRequest: import('supertest').Test,
  suffix: string
): import('supertest').Test {
  return pendingRequest
    .query({ sessionId: `query-session-${suffix}` })
    .set('x-session-id', `header-session-${suffix}`)
    .set('mcp-session-id', `mcp-session-${suffix}`)
    .set('Authorization', `Bearer caller-selected-${suffix}`)
    .set('x-forwarded-for', `198.51.100.${suffix}`);
}

describe('public provider admission in the production application composition', () => {
  it('places the dispatch GPT identifier boundary before admission and the GPT leaf', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const broadParserIndex = appSource.indexOf('app.use(express.json');
    const appDispatchPathIndex = appSource.indexOf("'/dispatch',", broadParserIndex);
    const appDagBoundaryIndex = appSource.indexOf(
      'dispatchDagCompatibilityBoundary',
      appDispatchPathIndex,
    );
    const appGptIdentifierBoundaryIndex = appSource.indexOf(
      'dispatchGptIdentifierBoundary',
      appDispatchPathIndex,
    );
    const appBackstageBoundaryIndex = appSource.indexOf(
      'backstageMutationHttpBoundary',
      appDispatchPathIndex,
    );
    const providerAdmissionIndex = appSource.indexOf(
      'app.use(publicProviderAdmission)',
      appDispatchPathIndex,
    );

    expect(broadParserIndex).toBeGreaterThanOrEqual(0);
    expect(appDispatchPathIndex).toBeGreaterThan(broadParserIndex);
    expect(appDagBoundaryIndex).toBeGreaterThan(appDispatchPathIndex);
    expect(appGptIdentifierBoundaryIndex).toBeGreaterThan(appDagBoundaryIndex);
    expect(appBackstageBoundaryIndex).toBeGreaterThan(appGptIdentifierBoundaryIndex);
    expect(providerAdmissionIndex).toBeGreaterThan(appBackstageBoundaryIndex);

    const dispatchRouteSource = readFileSync(
      new URL('../src/routes/dispatch.ts', import.meta.url),
      'utf8',
    );
    const routerDispatchPathIndex = dispatchRouteSource.lastIndexOf("'/dispatch',");
    const routerDagBoundaryIndex = dispatchRouteSource.indexOf(
      'dispatchDagCompatibilityBoundary',
      routerDispatchPathIndex,
    );
    const routerGptIdentifierBoundaryIndex = dispatchRouteSource.indexOf(
      'dispatchGptIdentifierBoundary',
      routerDispatchPathIndex,
    );
    const routerBackstageBoundaryIndex = dispatchRouteSource.indexOf(
      'backstageMutationHttpBoundary',
      routerDispatchPathIndex,
    );
    const universalDispatchIndex = dispatchRouteSource.indexOf(
      'universalDispatch',
      routerDispatchPathIndex,
    );

    expect(routerDispatchPathIndex).toBeGreaterThanOrEqual(0);
    expect(routerDagBoundaryIndex).toBeGreaterThan(routerDispatchPathIndex);
    expect(routerGptIdentifierBoundaryIndex).toBeGreaterThan(routerDagBoundaryIndex);
    expect(routerBackstageBoundaryIndex).toBeGreaterThan(routerGptIdentifierBoundaryIndex);
    expect(universalDispatchIndex).toBeGreaterThan(routerBackstageBoundaryIndex);
  });

  it('shares one hierarchical ceiling without charging health, control, or DAG lanes', async () => {
    const app = createApp();
    app.set('trust proxy', (address: string) => (
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    ));

    const oversizedDispatchGptId = 'x'.repeat(257);
    const readyRouteCallsBeforeInvalidId = routeGptRequestMock.mock.calls.length;
    const readyResolveCallsBeforeInvalidId = resolveGptRoutingMock.mock.calls.length;
    const readyInvalidDispatchResponse = await addRotatedCallerMetadata(
      request(app).post('/dispatch'),
      '01',
    ).send({
      target: 'gpt',
      gptId: oversizedDispatchGptId,
      action: 'query',
      prompt: 'Reject this identifier before ready admission capacity is consumed.',
    });

    expect(readyInvalidDispatchResponse.status).toBe(400);
    expect(readyInvalidDispatchResponse.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(readyInvalidDispatchResponse.headers['cache-control']).toBe('no-store');
    expect(readyInvalidDispatchResponse.body).toEqual(expect.objectContaining({
      ok: false,
      target: 'gpt',
      routeFamily: 'dispatch',
      gptId: 'invalid',
      error: {
        code: 'BAD_REQUEST',
        message: 'gptId too long',
      },
    }));
    expect(JSON.stringify(readyInvalidDispatchResponse.body)).not.toContain(
      oversizedDispatchGptId,
    );
    expect(routeGptRequestMock).toHaveBeenCalledTimes(readyRouteCallsBeforeInvalidId);
    expect(resolveGptRoutingMock).toHaveBeenCalledTimes(readyResolveCallsBeforeInvalidId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const healthResponse = await request(app).get('/healthz');
      const controlResponse = await request(app).get('/api/control-plane/allowlist');

      expect(healthResponse.status).toBe(200);
      expect(controlResponse.status).not.toBe(429);
    }

    unsafeExecutionDenied = true;
    const deniedByUnsafeGateResponse = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '05'
    ).send({
      action: 'query',
      prompt: 'This valid provider request must be charged before unsafe denial.',
      sessionId: 'body-session-05',
    });
    unsafeExecutionDenied = false;

    expect(deniedByUnsafeGateResponse.status).toBe(503);
    expect(deniedByUnsafeGateResponse.headers['x-ratelimit-bucket']).toBe(
      'public-provider-instance'
    );
    expect(deniedByUnsafeGateResponse.headers['x-ratelimit-remaining']).toBe('6');
    expect(deniedByUnsafeGateResponse.headers['cache-control']).toBe('no-store');
    expect(routeGptRequestMock).not.toHaveBeenCalled();

    const admittedResearchResponse = await addRotatedCallerMetadata(
      request(app).post('/commands/research'),
      '10'
    )
      .set('x-confirmed', 'yes')
      .send({
        topic: 'Bounded test research',
        urls: [],
        sessionId: 'body-session-10',
      });

    expect(admittedResearchResponse.status).toBe(200);
    expect(admittedResearchResponse.headers['cache-control']).toBe('no-store');
    expect(researchMock).toHaveBeenCalledTimes(1);

    const pipelineResponse = await addRotatedCallerMetadata(
      request(app).post('/arcanos-pipeline'),
      '20'
    ).send({
      messages: [],
      sessionId: 'body-session-10',
    });

    expect(pipelineResponse.status).toBe(200);
    expect(pipelineResponse.headers['x-ratelimit-bucket']).toBe('public-provider-instance');
    expect(pipelineResponse.headers['x-ratelimit-remaining']).toBe('4');
    expect(pipelineResponse.headers['cache-control']).toBe('no-store');
    expect(executeArcanosPipelineMock).toHaveBeenCalledTimes(1);

    routeGptRequestMock.mockRejectedValueOnce(new Error('provider failure sentinel'));
    const dispatchResponse = await addRotatedCallerMetadata(
      request(app).post('/dispatch'),
      '30'
    ).send({
      target: 'gpt',
      action: 'query',
      prompt: 'Use the GPT lane.',
      sessionId: 'body-session-30',
    });

    expect(dispatchResponse.status).toBe(500);
    expect(dispatchResponse.headers['x-ratelimit-bucket']).toBe('public-provider-instance');
    expect(dispatchResponse.headers['x-ratelimit-remaining']).toBe('3');
    expect(dispatchResponse.headers['cache-control']).toBe('no-store');
    expect(routeGptRequestMock).toHaveBeenCalledTimes(1);

    const directDiagnosticActionResponse = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '40'
    ).send({
      action: 'query_and_wait',
      prompt: 'ping',
      sessionId: 'body-session-40',
    });

    expect(directDiagnosticActionResponse.status).toBe(200);
    expect(directDiagnosticActionResponse.headers['x-ratelimit-bucket']).toBe(
      'public-provider-instance'
    );
    expect(directDiagnosticActionResponse.headers['x-ratelimit-remaining']).toBe('2');
    expect(directDiagnosticActionResponse.headers['cache-control']).toBe('no-store');
    expect(executeDirectGptActionMock).toHaveBeenCalledTimes(1);

    routeGptRequestMock.mockRejectedValueOnce(new Error('canonical provider failure sentinel'));
    const canonicalGptResponse = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '50'
    ).send({
      action: 'query',
      prompt: 'Use the canonical GPT route.',
      sessionId: 'body-session-50',
    });

    expect(canonicalGptResponse.status).toBe(500);
    expect(canonicalGptResponse.headers['x-ratelimit-bucket']).toBe('public-provider-instance');
    expect(canonicalGptResponse.headers['x-ratelimit-remaining']).toBe('1');
    expect(canonicalGptResponse.headers['cache-control']).toBe('no-store');
    expect(routeGptRequestMock).toHaveBeenCalledTimes(2);

    const oversizedGptId = 'x'.repeat(257);
    const routeCallsBeforeOversizedId = routeGptRequestMock.mock.calls.length;
    const resolveCallsBeforeOversizedId = resolveGptRoutingMock.mock.calls.length;
    const oversizedGptResponse = await addRotatedCallerMetadata(
      request(app).post(`/gpt/${oversizedGptId}`),
      '55'
    ).send({
      action: 'query',
      prompt: 'The canonical identifier boundary must run before the exhausted provider bucket.',
      sessionId: 'body-session-55',
    });

    expect(oversizedGptResponse.status).toBe(400);
    expect(oversizedGptResponse.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(oversizedGptResponse.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'invalid',
      code: 'BAD_REQUEST',
      error: {
        code: 'BAD_REQUEST',
        message: 'gptId too long',
      },
    }));
    expect(JSON.stringify(oversizedGptResponse.body)).not.toContain(oversizedGptId);
    expect(routeGptRequestMock).toHaveBeenCalledTimes(routeCallsBeforeOversizedId);
    expect(resolveGptRoutingMock).toHaveBeenCalledTimes(resolveCallsBeforeOversizedId);

    const deniedResearchResponse = await addRotatedCallerMetadata(
      request(app).post('/commands/research'),
      '60'
    )
      .set('x-confirmed', 'yes')
      .send({
        topic: 'Bounded test research',
        urls: [],
        sessionId: 'body-session-60',
      });

    expect(deniedResearchResponse.status).toBe(429);
    expect(deniedResearchResponse.headers['x-ratelimit-bucket']).toBe('public-provider-client');
    expect(deniedResearchResponse.headers['x-ratelimit-limit']).toBe('6');
    expect(deniedResearchResponse.headers['x-ratelimit-remaining']).toBe('0');
    expect(deniedResearchResponse.headers['x-public-provider-global-remaining']).toBe('1');
    expect(deniedResearchResponse.headers['retry-after']).toBeTruthy();
    expect(deniedResearchResponse.headers['cache-control']).toBe('no-store');
    expect(researchMock).toHaveBeenCalledTimes(1);

    const exhaustedRouteCallsBeforeInvalidId = routeGptRequestMock.mock.calls.length;
    const exhaustedResolveCallsBeforeInvalidId = resolveGptRoutingMock.mock.calls.length;
    const exhaustedInvalidDispatchResponse = await addRotatedCallerMetadata(
      request(app).post('/dispatch'),
      '65',
    ).send({
      target: 'gpt',
      gptId: oversizedDispatchGptId,
      action: 'query',
      prompt: 'Reject this identifier while provider admission is already exhausted.',
    });

    expect(exhaustedInvalidDispatchResponse.status).toBe(400);
    expect(exhaustedInvalidDispatchResponse.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(exhaustedInvalidDispatchResponse.headers['cache-control']).toBe('no-store');
    expect(exhaustedInvalidDispatchResponse.body).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'invalid',
      error: {
        code: 'BAD_REQUEST',
        message: 'gptId too long',
      },
    }));
    expect(JSON.stringify(exhaustedInvalidDispatchResponse.body)).not.toContain(
      oversizedDispatchGptId,
    );
    expect(routeGptRequestMock).toHaveBeenCalledTimes(exhaustedRouteCallsBeforeInvalidId);
    expect(resolveGptRoutingMock).toHaveBeenCalledTimes(exhaustedResolveCallsBeforeInvalidId);

    const deniedDirectDiagnosticAction = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '70'
    ).send({
      action: 'query_and_wait',
      prompt: 'ping',
      sessionId: 'body-session-70',
    });

    expect(deniedDirectDiagnosticAction.status).toBe(429);
    expect(deniedDirectDiagnosticAction.headers['x-ratelimit-bucket']).toBe(
      'public-provider-client'
    );
    expect(deniedDirectDiagnosticAction.headers['cache-control']).toBe('no-store');
    expect(executeDirectGptActionMock).toHaveBeenCalledTimes(1);

    const deniedFastPathDiagnosticMode = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '80'
    ).send({
      mode: 'diagnostic',
      prompt: 'Write a haiku.',
      sessionId: 'body-session-80',
    });

    expect(deniedFastPathDiagnosticMode.status).toBe(429);
    expect(deniedFastPathDiagnosticMode.headers['x-ratelimit-bucket']).toBe(
      'public-provider-client'
    );
    expect(deniedFastPathDiagnosticMode.headers['cache-control']).toBe('no-store');
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();

    const explicitPingWithGenerativePrompt = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '79'
    ).send({
      action: 'ping',
      prompt: 'Write a haiku.',
      sessionId: 'body-session-79',
    });

    expect(explicitPingWithGenerativePrompt.status).not.toBe(429);
    expect(explicitPingWithGenerativePrompt.headers['x-ratelimit-bucket']).not.toBe(
      'public-provider-client'
    );
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();

    const diagnosticModeWithExplicitNonQueryAction = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '78'
    ).send({
      mode: 'diagnostic',
      action: 'generateBooking',
      prompt: 'Write a haiku.',
      sessionId: 'body-session-78',
    });

    expect(diagnosticModeWithExplicitNonQueryAction.status).not.toBe(429);
    expect(diagnosticModeWithExplicitNonQueryAction.headers['x-ratelimit-bucket']).not.toBe(
      'public-provider-client'
    );
    expect(executeFastGptPromptMock).not.toHaveBeenCalled();

    const routeCallsBeforeDeniedPingAlias = routeGptRequestMock.mock.calls.length;
    const deniedHeaderPingAlias = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '77'
    )
      .set('x-gpt-action', 'ping')
      .send({ prompt: 'Write a haiku.', sessionId: 'body-session-77' });

    expect(deniedHeaderPingAlias.status).toBe(429);
    expect(deniedHeaderPingAlias.headers['x-ratelimit-bucket']).toBe(
      'public-provider-client'
    );
    expect(deniedHeaderPingAlias.headers['cache-control']).toBe('no-store');
    expect(routeGptRequestMock).toHaveBeenCalledTimes(routeCallsBeforeDeniedPingAlias);

    const routeCallsBeforeDeniedPayloadPromptOverride = routeGptRequestMock.mock.calls.length;
    const deniedPayloadPromptOverride = await addRotatedCallerMetadata(
      request(app).post('/gpt/arcanos-core'),
      '74'
    ).send({
      prompt: 'ping',
      payload: { prompt: 'Write a haiku.' },
      sessionId: 'body-session-74',
    });

    expect(deniedPayloadPromptOverride.status).toBe(429);
    expect(deniedPayloadPromptOverride.headers['x-ratelimit-bucket']).toBe(
      'public-provider-client'
    );
    expect(deniedPayloadPromptOverride.headers['cache-control']).toBe('no-store');
    expect(routeGptRequestMock).toHaveBeenCalledTimes(routeCallsBeforeDeniedPayloadPromptOverride);

    const providerFreeApiAliasConflict = await addRotatedCallerMetadata(
      request(app).post('/api/arcanos/ask'),
      '73'
    ).send({
      prompt: 'ping',
      message: 'Write a haiku.',
      sessionId: 'body-session-73',
    });
    const deniedApiAliasConflict = await addRotatedCallerMetadata(
      request(app).post('/api/arcanos/ask'),
      '72'
    ).send({
      prompt: 'Write a haiku.',
      message: 'ping',
      sessionId: 'body-session-72',
    });
    const providerFreeSanitizedApiMode = await addRotatedCallerMetadata(
      request(app).post('/api/arcanos/ask'),
      '67'
    ).send({
      mode: 'diag\0nostic',
      prompt: 'Write a haiku.',
      sessionId: 'body-session-67',
    });

    expect(providerFreeApiAliasConflict.status).not.toBe(429);
    expect(providerFreeApiAliasConflict.headers['x-ratelimit-bucket']).not.toBe(
      'public-provider-instance'
    );
    expect(providerFreeSanitizedApiMode.status).not.toBe(429);
    expect(providerFreeSanitizedApiMode.headers['x-ratelimit-bucket']).not.toBe(
      'public-provider-instance'
    );
    expect(deniedApiAliasConflict.status).toBe(429);
    expect(deniedApiAliasConflict.headers['x-ratelimit-bucket']).toBe(
      'public-provider-client'
    );
    expect(deniedApiAliasConflict.headers['cache-control']).toBe('no-store');
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();

    const providerFreeDuplicateQuery = await addRotatedCallerMetadata(
      request(app).get('/brain'),
      '76'
    )
      .query({
        mode: ['chat', 'system_review'],
        prompt: ['ping', 'Write a haiku.'],
      })
      .set('x-confirmed', 'yes');

    expect(providerFreeDuplicateQuery.status).not.toBe(429);
    expect(providerFreeDuplicateQuery.headers['x-ratelimit-bucket']).not.toBe(
      'public-provider-instance'
    );
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();

    const providerFreeBrainAliasConflict = await addRotatedCallerMetadata(
      request(app).post('/brain'),
      '71'
    )
      .set('x-confirmed', 'yes')
      .send({
        prompt: 'ping',
        message: 'Write a haiku.',
        sessionId: 'body-session-71',
      });
    const deniedBrainAliasConflict = await addRotatedCallerMetadata(
      request(app).post('/brain'),
      '69'
    )
      .set('x-confirmed', 'yes')
      .send({
        prompt: 'Write a haiku.',
        message: 'ping',
        sessionId: 'body-session-69',
      });
    const deniedSanitizedSystemReview = await addRotatedCallerMetadata(
      request(app).post('/brain'),
      '68'
    )
      .set('x-confirmed', 'yes')
      .send({
        mode: 'system_\0review',
        prompt: 'ping',
        sessionId: 'body-session-68',
      });

    expect(providerFreeBrainAliasConflict.status).not.toBe(429);
    expect(providerFreeBrainAliasConflict.headers['x-ratelimit-bucket']).not.toBe(
      'public-provider-instance'
    );
    for (const deniedBrainConflict of [
      deniedBrainAliasConflict,
      deniedSanitizedSystemReview,
    ]) {
      expect(deniedBrainConflict.status).toBe(429);
      expect(deniedBrainConflict.headers['x-ratelimit-bucket']).toBe(
        'public-provider-client'
      );
      expect(deniedBrainConflict.headers['cache-control']).toBe('no-store');
    }
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();

    const deniedDuplicateSystemReviewQuery = await addRotatedCallerMetadata(
      request(app).get('/brain'),
      '75'
    )
      .query({ mode: ['system_review', 'chat'], prompt: 'ping' })
      .set('x-confirmed', 'yes');

    expect(deniedDuplicateSystemReviewQuery.status).toBe(429);
    expect(deniedDuplicateSystemReviewQuery.headers['x-ratelimit-bucket']).toBe(
      'public-provider-client'
    );
    expect(deniedDuplicateSystemReviewQuery.headers['cache-control']).toBe('no-store');
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();

    const deniedSystemReviewPost = await addRotatedCallerMetadata(
      request(app).post('/brain'),
      '81'
    )
      .set('x-confirmed', 'yes')
      .send({ mode: 'system_review', prompt: 'ping', sessionId: 'body-session-81' });
    const deniedSystemReviewGet = await addRotatedCallerMetadata(
      request(app).get('/brain'),
      '82'
    )
      .query({ mode: 'system_review', prompt: 'ping' })
      .set('x-confirmed', 'yes');
    const deniedImplicitHead = await addRotatedCallerMetadata(
      request(app).head('/brain'),
      '83'
    )
      .set('x-confirmed', 'yes')
      .query({ prompt: 'Write a haiku.' });

    for (const deniedBrainResponse of [
      deniedSystemReviewPost,
      deniedSystemReviewGet,
      deniedImplicitHead,
    ]) {
      expect(deniedBrainResponse.status).toBe(429);
      expect(deniedBrainResponse.headers['x-ratelimit-bucket']).toBe(
        'public-provider-client'
      );
      expect(deniedBrainResponse.headers['cache-control']).toBe('no-store');
    }
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();

    const dagResponse = await request(app)
      .post('/dispatch')
      .send({ target: 'dag' });
    const healthAfterExhaustion = await request(app).get('/healthz');
    const controlAfterExhaustion = await request(app).get('/api/control-plane/allowlist');
    const postControlAfterExhaustion = await request(app)
      .post('/api/control-plane/operations')
      .send({ operation: 'list' });
    const canonicalDagAfterExhaustion = await request(app)
      .post('/gpt/arcanos-core')
      .set('x-gpt-action', 'dag.status')
      .send({ payload: {} });
    const diagnosticAfterExhaustion = await request(app)
      .post('/api/arcanos/ask')
      .send({ action: 'ping' });
    const dispatchDiagnosticActionAfterExhaustion = await request(app)
      .post('/dispatch')
      .send({ action: 'ping' });
    const dispatchDiagnosticPromptAfterExhaustion = await request(app)
      .post('/dispatch')
      .send({ prompt: 'ping' });
    const dispatchControlAfterExhaustion = await request(app)
      .post('/dispatch')
      .send({ target: 'gpt', action: 'runtime.inspect' });

    expect(dagResponse.status).not.toBe(429);
    expect(healthAfterExhaustion.status).toBe(200);
    expect(controlAfterExhaustion.status).not.toBe(429);
    expect(postControlAfterExhaustion.status).not.toBe(429);
    expect(postControlAfterExhaustion.headers['x-ratelimit-bucket']).not.toBe('public-provider-instance');
    expect(canonicalDagAfterExhaustion.status).not.toBe(429);
    expect(canonicalDagAfterExhaustion.headers['x-ratelimit-bucket']).not.toBe('public-provider-instance');
    expect(diagnosticAfterExhaustion.status).toBe(200);
    expect(diagnosticAfterExhaustion.headers['x-ratelimit-bucket']).not.toBe('public-provider-instance');
    for (const providerFreeDispatchResponse of [
      dispatchDiagnosticActionAfterExhaustion,
      dispatchDiagnosticPromptAfterExhaustion,
      dispatchControlAfterExhaustion,
    ]) {
      expect(providerFreeDispatchResponse.status).not.toBe(429);
      expect(providerFreeDispatchResponse.headers['x-ratelimit-bucket']).not.toBe(
        'public-provider-instance'
      );
    }
  });
});

afterAll(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});
