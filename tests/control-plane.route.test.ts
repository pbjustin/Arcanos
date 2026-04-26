import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExecuteControlPlaneRequest = jest.fn();
const mockGetControlPlaneCapabilities = jest.fn();

jest.unstable_mockModule('@services/controlPlane/service.js', () => ({
  executeControlPlaneRequest: mockExecuteControlPlaneRequest,
  getControlPlaneCapabilities: mockGetControlPlaneCapabilities
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/control-plane.js')).default;

function buildResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    requestId: 'req-http-1',
    phase: 'plan',
    adapter: 'railway-cli',
    operation: 'status',
    route: {
      requested: 'direct',
      status: 'DIRECT_FAST_PATH',
      eligibleForTrinity: false,
      reason: 'test route',
      evidence: {},
      requestedAt: '2026-04-26T00:00:00.000Z',
      verifiedAt: '2026-04-26T00:00:00.000Z'
    },
    approval: {
      required: false,
      satisfied: true,
      gate: 'none'
    },
    audit: {
      auditId: 'audit-http-1',
      logged: true
    },
    result: {
      status: 'planned',
      adapter: 'railway-cli',
      operation: 'status'
    },
    ...overrides
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).requestId = 'req-http-1';
    next();
  });
  app.use(router);
  return app;
}

describe('control-plane route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetControlPlaneCapabilities.mockReturnValue({
      operations: [],
      mcpTools: {
        readOnly: [],
        mutating: []
      },
      routeStatuses: [
        'TRINITY_CONFIRMED',
        'TRINITY_UNAVAILABLE',
        'TRINITY_REQUESTED_BUT_NOT_CONFIRMED',
        'DIRECT_FAST_PATH',
        'UNKNOWN_ROUTE'
      ]
    });
    mockExecuteControlPlaneRequest.mockResolvedValue(buildResponse());
  });

  it('returns allowlisted capabilities for discovery', async () => {
    const response = await request(buildApp()).get('/api/control-plane/capabilities');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.capabilities.routeStatuses).toContain('TRINITY_CONFIRMED');
  });

  it('rejects requests that do not satisfy the control-plane request schema', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane')
      .send({
        phase: 'execute',
        adapter: 'railway-cli'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CONTROL_PLANE_REQUEST');
    expect(mockExecuteControlPlaneRequest).not.toHaveBeenCalled();
  });

  it('passes validated requests with request and session context to the executor', async () => {
    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('x-session-id', 'session-http-1')
      .send({
        phase: 'plan',
        adapter: 'railway-cli',
        operation: 'status',
        routePreference: 'direct'
      });

    expect(response.status).toBe(200);
    expect(mockExecuteControlPlaneRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-http-1',
      phase: 'plan',
      adapter: 'railway-cli',
      operation: 'status',
      context: expect.objectContaining({
        sessionId: 'session-http-1',
        caller: expect.objectContaining({
          type: 'http-request'
        })
      })
    }));
  });

  it('allows confirmed mutation requests to reach the executor', async () => {
    mockExecuteControlPlaneRequest.mockResolvedValue(buildResponse({
      phase: 'mutate',
      operation: 'deploy',
      result: {
        status: 'completed',
        adapter: 'railway-cli',
        operation: 'deploy',
        exitCode: 0
      }
    }));

    const response = await request(buildApp())
      .post('/api/control-plane')
      .set('x-confirmed', 'yes')
      .send({
        phase: 'mutate',
        adapter: 'railway-cli',
        operation: 'deploy',
        approval: {
          approved: true,
          approvedBy: 'operator:test',
          reason: 'route test'
        }
      });

    expect(response.status).toBe(200);
    expect(mockExecuteControlPlaneRequest).toHaveBeenCalledTimes(1);
  });
});
