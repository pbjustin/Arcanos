import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.unstable_mockModule('@core/init-openai.js', () => ({ initOpenAI: jest.fn() }));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(),
}));
jest.unstable_mockModule('@routes/register.js', () => ({
  registerRoutes: (app: import('express').Express) => {
    app.post('/plans/:planId/execute', (_req, res) => res.status(204).end());
    app.post('/plans/:planId/executions/:runId/result', (_req, res) => res.status(204).end());
  },
}));
jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  startSelfHealingControlLoop: jest.fn(),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary: jest.fn(async () => undefined),
    recordRequestCompletion: jest.fn(),
  },
}));
jest.unstable_mockModule('@services/arcanosMcp.js', () => ({ arcanosMcpService: {} }));
jest.unstable_mockModule('@transport/http/middleware/unsafeExecutionGate.js', () => ({
  unsafeExecutionGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.unstable_mockModule('@transport/http/middleware/fallbackHandler.js', () => ({
  createHealthCheckMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  createFallbackMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.unstable_mockModule('@transport/http/gamingIngressAudit.js', () => ({
  gamingIngressAudit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => {
  const base = {
    debug: jest.fn(), info: jest.fn(), warn: loggerWarnMock, error: loggerErrorMock,
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: loggerWarnMock, error: loggerErrorMock }),
  };
  return {
    logger: base,
    apiLogger: base,
    aiLogger: base,
    dbLogger: base,
    workerLogger: base,
    createRequestLogger: () => base,
  };
});

const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');

let consoleLogMock: ReturnType<typeof jest.spyOn>;

describe('Phase 2E production parser seam', () => {
  beforeEach(() => {
    loggerWarnMock.mockClear();
    loggerErrorMock.mockClear();
    consoleLogMock = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogMock.mockRestore();
  });

  it.each([
    '/plans',
    '/agents/register',
    '/plans/plan-1/execute/',
    '/plans/plan-1/executions/run-1/result/',
  ])('enforces the 64 KiB limit on trailing-slash protocol route %s', async path => {
    const response = await request(createApp())
      .post(path)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(64 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    const logs = JSON.stringify(consoleLogMock.mock.calls);
    const structuredLogs = JSON.stringify([
      ...loggerWarnMock.mock.calls,
      ...loggerErrorMock.mock.calls,
    ]);
    expect(logs).not.toContain('PayloadTooLargeError');
    expect(logs).not.toContain('request entity too large');
    expect(logs).not.toContain('node_modules');
    expect(structuredLogs).not.toContain('PayloadTooLargeError');
    expect(structuredLogs).not.toContain('request entity too large');
    expect(structuredLogs).not.toContain('node_modules');
  });

  it('rejects a text/plain result-shaped body at the command boundary before route dispatch', async () => {
    const sentinel = 'private-result-sentinel';
    const response = await request(createApp())
      .post('/plans/plan-1/execute')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ action_id: 'action-1', outcome: 'failed', error: sentinel }));
    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'ACTION_PLAN_EXECUTION_REQUEST_INVALID',
        message: 'ActionPlan execution request is invalid.',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
  });

  it('keeps malformed JSON parser errors no-store and excludes body sentinels from public output', async () => {
    const sentinel = 'private-json-parser-sentinel';
    const response = await request(createApp())
      .post('/plans/plan-1/executions/run-1/result')
      .set('Content-Type', 'application/json')
      .send(`{"result":"${sentinel}"`);
    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    const logs = JSON.stringify(consoleLogMock.mock.calls);
    const structuredLogs = JSON.stringify([
      ...loggerWarnMock.mock.calls,
      ...loggerErrorMock.mock.calls,
    ]);
    expect(logs).not.toContain(sentinel);
    expect(logs).not.toContain('SyntaxError');
    expect(logs).not.toContain('JSON.parse');
    expect(logs).not.toContain('node_modules');
    expect(structuredLogs).not.toContain(sentinel);
    expect(structuredLogs).not.toContain('SyntaxError');
    expect(structuredLogs).not.toContain('JSON.parse');
    expect(structuredLogs).not.toContain('node_modules');
  });
});
