import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockAuditLog = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/platform/logging/auditLogger.js', () => ({
  auditLogger: {
    log: mockAuditLog,
  },
}));

jest.unstable_mockModule('../src/services/runtimeInspectionRoutingService.js', () => ({
  executeRuntimeInspection: jest.fn(),
  classifyRuntimeInspectionPrompt: jest.fn(() => ({
    detectedIntent: 'STANDARD',
    matchedKeywords: [],
    repoInspectionDisabled: false,
    onlyReturnRuntimeValues: false,
  })),
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    getFeatureFlags: jest.fn(),
    getExecutionLimits: jest.fn(),
  },
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

describe('root.deep_diagnostics GPT bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects root diagnostics on /gpt/:gptId and points clients to GPT Access diagnostics', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({ action: 'root.deep_diagnostics' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      action: 'root.deep_diagnostics',
      code: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
      route: '/gpt/:gptId',
      _route: expect.objectContaining({
        route: 'control_guard',
      }),
      canonical: expect.objectContaining({
        mcp: '/gpt-access/mcp',
      }),
    }));
    expect(JSON.stringify(response.body)).toContain('/gpt-access/');
    expect(mockResolveGptRouting).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
