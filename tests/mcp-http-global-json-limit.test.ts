import { type NextFunction, type Request, type Response } from 'express';
import { afterAll, describe, expect, it, jest } from '@jest/globals';

const GLOBAL_JSON_LIMIT_BYTES = 256 * 1024;
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
  'MCP_HTTP_BODY_LIMIT',
  'JSON_LIMIT',
] as const;
const originalEnvironment = new Map(
  trackedEnvironmentNames.map(name => [name, process.env[name]] as const)
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
process.env.MCP_HTTP_BODY_LIMIT = '1mb';
process.env.JSON_LIMIT = '256kb';

const unsafeExecutionGateMock = jest.fn((
  _req: Request,
  _res: Response,
  next: NextFunction
): void => next());

jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn(),
}));
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

function jsonBodyWithByteLength(byteLength: number): string {
  const emptyBody = JSON.stringify({ padding: '' });
  const body = JSON.stringify({
    padding: 'x'.repeat(byteLength - Buffer.byteLength(emptyBody)),
  });
  expect(Buffer.byteLength(body)).toBe(byteLength);
  return body;
}

describe('MCP HTTP body cap with a stricter global JSON limit', () => {
  it('preserves the operator-selected global limit in the assembled application', async () => {
    const response = await request(createApp())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(GLOBAL_JSON_LIMIT_BYTES + 1));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: 'MCP_REQUEST_TOO_LARGE',
      message: 'MCP request body is too large.',
    });
    expect(unsafeExecutionGateMock).not.toHaveBeenCalled();
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
