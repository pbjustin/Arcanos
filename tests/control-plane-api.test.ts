import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExecuteControlPlaneOperation = jest.fn();
const mockListControlPlaneAllowlist = jest.fn();

jest.unstable_mockModule('@services/controlPlane/index.js', () => ({
  executeControlPlaneOperation: mockExecuteControlPlaneOperation,
  listControlPlaneAllowlist: mockListControlPlaneAllowlist,
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  securityHeaders: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/api-control-plane.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/control-plane', router);
  return app;
}

function buildControlPlaneResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    operation: 'backend.health',
    provider: 'backend-api',
    environment: 'local',
    result: { dryRun: true },
    auditId: 'cp_test',
    warnings: [],
    redactedOutput: { dryRun: true },
    ...overrides,
  };
}

describe('api-control-plane route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListControlPlaneAllowlist.mockReturnValue([
      {
        operation: 'backend.health',
        provider: 'backend-api',
        workflow: 'control_plane.inspect',
        readOnly: true,
        approvalRequired: false,
      },
    ]);
  });

  it('returns the allowlist without exposing execution output', async () => {
    const response = await request(buildApp()).get('/api/control-plane/allowlist');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      operations: [
        expect.objectContaining({
          operation: 'backend.health',
          provider: 'backend-api',
          workflow: 'control_plane.inspect',
          readOnly: true,
          approvalRequired: false,
        }),
      ],
    });
    expect(mockExecuteControlPlaneOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['success', buildControlPlaneResponse(), 200],
    [
      'schema failure',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_SCHEMA', message: 'bad schema' },
      }),
      400,
    ],
    [
      'bad request',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_BAD_REQUEST', message: 'bad request' },
      }),
      400,
    ],
    [
      'denied operation',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_DENIED', message: 'denied' },
      }),
      403,
    ],
    [
      'missing scope',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_SCOPE', message: 'missing scope' },
      }),
      403,
    ],
    [
      'GPT policy denial',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_GPT_POLICY', message: 'GPT denied' },
      }),
      403,
    ],
    [
      'approval failure',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_APPROVAL', message: 'approval required' },
      }),
      428,
    ],
    [
      'internal execution failure',
      buildControlPlaneResponse({
        ok: false,
        error: { code: 'ERR_CONTROL_PLANE_EXECUTION', message: 'internal failure' },
      }),
      500,
    ],
  ])('maps %s to HTTP %i', async (_label, controlPlaneResponse, expectedStatus) => {
    mockExecuteControlPlaneOperation.mockResolvedValue(controlPlaneResponse);

    const response = await request(buildApp())
      .post('/api/control-plane/operations')
      .send({
        operation: 'backend.health',
        provider: 'backend-api',
        target: { resource: 'health' },
        environment: 'local',
        scope: 'backend:read',
        params: {},
        traceId: 'trace-api-status-test',
        requestedBy: 'test-runner',
      });

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toEqual(controlPlaneResponse);
    expect(mockExecuteControlPlaneOperation).toHaveBeenCalledTimes(1);
  });
});
