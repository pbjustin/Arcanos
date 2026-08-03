import type { NextFunction, Request, Response } from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'dispatch-app-token-12345678901234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

let rejectAtUnsafeGate = false;
const unsafeExecutionGateMock = jest.fn((
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (rejectAtUnsafeGate) {
    res.status(503).json({ code: 'UNSAFE_EXECUTION_TEST_SENTINEL' });
    return;
  }
  next();
});
const routeGptRequestMock = jest.fn();
const resolveGptRoutingMock = jest.fn();
const createRunMock = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock,
  resolveGptRouting: resolveGptRoutingMock,
}));
jest.unstable_mockModule('@services/arcanosDagRunService.js', () => ({
  DEFAULT_DAG_ADMISSION_RECONCILIATION_DELAY_MS: 1000,
  DagRunAdmissionUncertainError: class DagRunAdmissionUncertainError extends Error {},
  DagRunCapacityExceededError: class DagRunCapacityExceededError extends Error {},
  arcanosDagRunService: {
    createRun: createRunMock,
  },
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({ initOpenAI: jest.fn() }));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(),
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
  gamingIngressAudit: (
    _req: Request,
    _res: Response,
    next: NextFunction
  ) => next(),
}));
const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(principalId: string): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

let consoleInfoSpy: ReturnType<typeof jest.spyOn>;
let consoleLogSpy: ReturnType<typeof jest.spyOn>;

describe('/dispatch production application composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rejectAtUnsafeGate = false;
    configureControlPlane('operator:dispatch-app-default');
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    createRunMock.mockResolvedValue({
      runId: 'dag-run-app-1',
      sessionId: 'dispatch-app-session',
      template: 'trinity-core',
      status: 'queued',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    });
    routeGptRequestMock.mockImplementation(async ({
      gptId,
      body,
    }: {
      gptId: string;
      body: Record<string, unknown>;
    }) => ({
      ok: true,
      result: {
        handledBy: 'app-composition-gpt',
        gptId,
        action: body.action ?? 'query',
      },
      _route: {
        gptId,
        module: 'ARCANOS:CORE',
        route: 'core',
        action: body.action ?? 'query',
        timestamp: '2026-07-31T00:00:00.000Z',
      },
    }));
    resolveGptRoutingMock.mockImplementation(async (gptId: string) => ({
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
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it.each([
    ['JSON', 'json'],
    ['form', 'form'],
  ] as const)('denies anonymous %s DAG selection before the unsafe gate', async (
    _bodyKind,
    requestType
  ) => {
    rejectAtUnsafeGate = true;
    const pendingRequest = request(createApp()).post('/dispatch');
    const response = requestType === 'form'
      ? await pendingRequest.type('form').send({
          target: 'dag',
          prompt: 'Run the workflow now.',
        })
      : await pendingRequest.send({
          target: 'dag',
          prompt: 'Run the workflow now.',
        });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(unsafeExecutionGateMock).not.toHaveBeenCalled();
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('preserves DAG no-store policy when a later application gate denies execution', async () => {
    rejectAtUnsafeGate = true;
    configureControlPlane('operator:dispatch-app-unsafe');

    const response = await request(createApp())
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('UNSAFE_EXECUTION_TEST_SENTINEL');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['x-ratelimit-remaining']).toBe('59');
    expect(unsafeExecutionGateMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('applies the idempotent policy once before an authorized DAG run', async () => {
    configureControlPlane('operator:dispatch-app-success');

    const response = await request(createApp())
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-ratelimit-remaining']).toBe('59');
    expect(unsafeExecutionGateMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit GPT precedence anonymous-compatible in the production app', async () => {
    const response = await request(createApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        action: 'dag.run.create',
        executionMode: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(200);
    expect(response.body.target).toBe('gpt');
    expect(unsafeExecutionGateMock).toHaveBeenCalledTimes(1);
    expect(routeGptRequestMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('rejects an anonymous direct Backstage mutation before broad JSON parsing', async () => {
    const response = await request(createApp())
      .post('/backstage/book-event')
      .set('Content-Type', 'application/json')
      .set('X-Confirmed', 'yes')
      .send('{');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(unsafeExecutionGateMock).not.toHaveBeenCalled();
  });

  it('rejects an anonymous canonical Backstage mutation selected through a query alias', async () => {
    const response = await request(createApp())
      .post('/gpt/backstage')
      .query({ operation: 'updateRoster' })
      .set('X-Confirmed', 'yes')
      .send({ payload: [] });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(unsafeExecutionGateMock).not.toHaveBeenCalled();
    expect(routeGptRequestMock).not.toHaveBeenCalled();
  });

  it('admits a confirmed operator Backstage mutation through GPT-selected dispatch', async () => {
    configureControlPlane('operator:dispatch-app-backstage');

    const response = await request(createApp())
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-Confirmed', 'yes')
      .send({
        target: 'gpt',
        gptId: 'backstage',
        action: 'updateRoster',
        payload: [],
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe('10');
    expect(response.headers['x-ratelimit-remaining']).toBe('9');
    expect(response.headers['x-ratelimit-bucket']).toBe('backstage-mutation-principal');
    expect(response.headers['x-public-provider-client-remaining']).toBeDefined();
    expect(response.headers['x-public-provider-global-remaining']).toBeDefined();
    expect(routeGptRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'backstage',
      body: expect.objectContaining({
        action: 'updateRoster',
        payload: [],
      }),
    }));
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('shares principal admission between the canonical and compatibility DAG routes', async () => {
    configureControlPlane('operator:dispatch-app-shared-quota');
    const app = createApp();

    for (let requestIndex = 0; requestIndex < 60; requestIndex += 1) {
      const response = await request(app)
        .post('/api/arcanos/dag/runs')
        .set('Authorization', `Bearer ${controlPlaneToken}`)
        .send({});
      expect(response.status).not.toBe(429);
    }

    createRunMock.mockClear();
    const denied = await request(app)
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(denied.status).toBe(429);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.headers['x-ratelimit-bucket']).toBe('api-arcanos-dag-execution');
    expect(createRunMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});
