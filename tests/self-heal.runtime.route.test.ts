import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const mockBuildSelfHealRuntimeSnapshot = jest.fn();
const mockBuildSelfHealEventsSnapshot = jest.fn();
const mockBuildSelfHealInspectionSnapshot = jest.fn();
const mockBuildSelfHealProviderHealthSnapshot = jest.fn();

jest.unstable_mockModule('@transport/http/middleware/capabilityGate.js', () => ({
  capabilityGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingDecision: jest.fn(),
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSelfHealRuntimeSnapshot: mockBuildSelfHealRuntimeSnapshot,
  buildSelfHealEventsSnapshot: mockBuildSelfHealEventsSnapshot,
  buildSelfHealInspectionSnapshot: mockBuildSelfHealInspectionSnapshot,
  buildSelfHealProviderHealthSnapshot: mockBuildSelfHealProviderHealthSnapshot,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const selfHealRouter = (await import('../src/routes/self-heal.js')).default;
const controlPlaneAccessToken = 'self-heal-runtime-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes = 'arcanos:read'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:self-heal-runtime-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(logger?: {
  info?: jest.Mock;
  warn?: jest.Mock;
  error?: jest.Mock;
}) {
  const app = express();
  if (logger) {
    app.use((req, _res, next) => {
      req.logger = logger as never;
      next();
    });
  }
  app.use(express.json());
  app.use(selfHealRouter);
  return app;
}

describe('self-heal runtime routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    mockBuildSelfHealRuntimeSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      loopStatus: { loopRunning: true },
    });
    mockBuildSelfHealEventsSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      count: 1,
      events: [{ id: 'evt-1' }],
    });
    mockBuildSelfHealInspectionSnapshot.mockResolvedValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      summary: 'Collected 1 self-heal runtime event.',
      evidence: {
        selfHealRuntimeSnapshot: {
          status: 'ok',
          lastDecision: 'observe',
        },
        recentSelfHealEvents: [{ ts: '2026-03-27T00:00:00.000Z', type: 'AI_DIAGNOSIS_REQUEST' }],
        recentPromptDebugEvents: [],
        recentAIRoutingEvents: [],
        recentWorkerEvidence: [],
      },
      limits: {
        selfHealEvents: 10,
        promptDebugEvents: 10,
        aiRoutingEvents: 10,
        workerEvidence: 10,
      },
    });
    mockBuildSelfHealProviderHealthSnapshot.mockResolvedValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      provider: {
        configured: true,
        clientInitialized: true,
        reachable: true,
        authenticated: true,
        completionHealthy: true,
        model: 'gpt-4.1',
        baseUrl: 'https://api.openai.com/v1',
        lastAttemptAt: '2026-03-27T00:00:00.000Z',
        lastSuccessAt: '2026-03-27T00:00:00.000Z',
        lastFailureAt: null,
        lastFailureReason: null,
        lastFailureCategory: null,
        lastFailureStatus: null,
        circuitBreakerState: 'CLOSED',
        circuitBreakerHealthy: true,
        circuitBreakerFailures: 0,
        circuitBreakerLastOpenedAt: null,
        circuitBreakerLastHalfOpenAt: null,
        circuitBreakerLastClosedAt: '2026-03-27T00:00:00.000Z',
        circuitBreakerNextRetryAt: null,
      },
      probe: null,
    });
  });

  it('rejects anonymous diagnostics before invoking snapshot builders', async () => {
    const response = await request(buildApp()).get('/api/self-heal/runtime');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-ratelimit-bucket']).toBe('self-heal-client');
    expect(mockBuildSelfHealRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when the control-plane principal is not configured', async () => {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;

    const response = await request(buildApp())
      .get('/api/self-heal/runtime')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
    expect(mockBuildSelfHealRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('requires the established read scope for passive diagnostics', async () => {
    configureControlPlane('');

    const response = await request(buildApp())
      .get('/api/self-heal/runtime')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(JSON.stringify(response.body)).not.toContain('arcanos:read');
    expect(mockBuildSelfHealRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('does not place denied query values in authorization audit metadata', async () => {
    const querySentinel = 'query-secret-must-not-be-logged';
    const warn = jest.fn();
    configureControlPlane('');

    const response = await request(buildApp({ warn }))
      .get(`/api/self-heal/runtime?token=${querySentinel}`)
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(403);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(querySentinel);
  });

  it('returns and logs a stable error without echoing dependency messages', async () => {
    const errorSentinel = 'upstream-secret-must-not-be-disclosed';
    const error = jest.fn();
    mockBuildSelfHealRuntimeSnapshot.mockImplementationOnce(() => {
      throw new Error(errorSentinel);
    });

    const response = await request(buildApp({ error }))
      .get('/api/self-heal/runtime')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'SELF_HEAL_INTERNAL_ERROR',
      where: 'self-heal/runtime',
    });
    expect(JSON.stringify(response.body)).not.toContain(errorSentinel);
    expect(JSON.stringify(error.mock.calls)).not.toContain(errorSentinel);
  });

  it('exposes authenticated self-heal runtime and event snapshots', async () => {
    const app = buildApp();

    const runtimeResponse = await request(app)
      .get('/api/self-heal/runtime')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    expect(runtimeResponse.status).toBe(200);
    expect(runtimeResponse.body).toMatchObject({
      status: 'ok',
      loopStatus: { loopRunning: true },
    });

    const eventsResponse = await request(app)
      .get('/api/self-heal/events?limit=5')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.body).toMatchObject({
      status: 'ok',
      count: 1,
      events: [{ id: 'evt-1' }],
    });
    expect(mockBuildSelfHealEventsSnapshot).toHaveBeenCalledWith(5);

    const inspectionResponse = await request(app)
      .get('/api/self-heal/inspection?limit=7')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    expect(inspectionResponse.status).toBe(200);
    expect(inspectionResponse.body).toMatchObject({
      status: 'ok',
      evidence: {
        selfHealRuntimeSnapshot: {
          lastDecision: 'observe',
        },
        recentSelfHealEvents: [{ type: 'AI_DIAGNOSIS_REQUEST' }],
      },
    });
    expect(mockBuildSelfHealInspectionSnapshot).toHaveBeenCalledWith(7);

    const providerHealthResponse = await request(app)
      .get('/api/self-heal/provider-health')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    expect(providerHealthResponse.status).toBe(200);
    expect(providerHealthResponse.body).toMatchObject({
      status: 'ok',
      provider: {
        configured: true,
        completionHealthy: true,
        model: 'gpt-4.1',
      },
    });
    expect(mockBuildSelfHealProviderHealthSnapshot).toHaveBeenCalledWith(false);
  });

  it('requires a separate scope for active GET and HEAD provider probes', async () => {
    const deniedResponse = await request(buildApp())
      .get('/api/self-heal/provider-health?probe=true')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(deniedResponse.status).toBe(403);
    expect(deniedResponse.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(deniedResponse.headers['x-ratelimit-bucket']).toBe('self-heal-provider-probe');
    expect(mockBuildSelfHealProviderHealthSnapshot).not.toHaveBeenCalled();

    configureControlPlane('arcanos:read,self-heal:probe');
    const logger = { info: jest.fn() };
    const app = buildApp(logger);
    const allowedGetResponse = await request(app)
      .get('/api/self-heal/provider-health?probe=YES')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
    const allowedHeadResponse = await request(app)
      .head('/api/self-heal/provider-health?probe=1')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(allowedGetResponse.status).toBe(200);
    expect(allowedHeadResponse.status).toBe(200);
    expect(mockBuildSelfHealProviderHealthSnapshot).toHaveBeenNthCalledWith(1, true);
    expect(mockBuildSelfHealProviderHealthSnapshot).toHaveBeenNthCalledWith(2, true);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'self_heal.provider_probe.authorized',
      {
        principalId: 'operator:self-heal-runtime-test',
        requestId: undefined,
        activeProbe: true,
      }
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('probe=');
  });

  it('treats an ambiguous repeated probe parameter as passive', async () => {
    const response = await request(buildApp())
      .get('/api/self-heal/provider-health?probe=true&probe=false')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(200);
    expect(mockBuildSelfHealProviderHealthSnapshot).toHaveBeenCalledWith(false);
  });

  it('terminates authenticated unknown self-heal paths inside the namespace', async () => {
    const response = await request(buildApp())
      .get('/api/self-heal/unknown')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
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
