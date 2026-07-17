import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockBuildMcpRequestContext = jest.fn();
const mockCreateMcpRequestContextProxy = jest.fn(() => ({ proxy: true }));
const mockRunWithMcpRequestContext = jest.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());
const mockBuildMcpServer = jest.fn();
const mockCreateRateLimitMiddleware = jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
const mockGetRequestActorKey = jest.fn(() => 'actor:test');
const mockResolveErrorMessage = jest.fn((error: unknown) => error instanceof Error ? error.message : String(error));
const mockSendInternalErrorPayload = jest.fn((res: express.Response, payload: unknown) => res.status(500).json(payload));
const mockApiLoggerError = jest.fn();

jest.unstable_mockModule('../src/mcp/auth.js', () => ({
  mcpAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('../src/mcp/context.js', () => ({
  buildMcpRequestContext: mockBuildMcpRequestContext,
  createMcpRequestContextProxy: mockCreateMcpRequestContextProxy,
  runWithMcpRequestContext: mockRunWithMcpRequestContext,
}));

jest.unstable_mockModule('../src/mcp/server.js', () => ({
  buildMcpServer: mockBuildMcpServer,
}));

jest.unstable_mockModule('../src/platform/runtime/security.js', () => ({
  createRateLimitMiddleware: mockCreateRateLimitMiddleware,
  getRequestActorKey: mockGetRequestActorKey,
}));

jest.unstable_mockModule('../src/core/lib/errors/index.js', () => ({
  resolveErrorMessage: mockResolveErrorMessage,
}));

jest.unstable_mockModule('../src/shared/http/index.js', () => ({
  sendInternalErrorPayload: mockSendInternalErrorPayload,
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: mockApiLoggerError,
  },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const router = (await import('../src/routes/mcp.js')).default;

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'phase2b-mcp-http-request';
    req.traceId = 'phase2b-mcp-http-trace';
    next();
  });
  app.use(router);
  return app;
}

function containsForbiddenValue(value: unknown, forbidden: string): boolean {
  try {
    return JSON.stringify(value).includes(forbidden);
  } catch {
    return true;
  }
}

describe('mcp route request isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMcpRequestContext.mockReturnValue({ requestId: 'req-1' });
    mockApiLoggerError.mockReset();

    let transportIndex = 0;
    mockBuildMcpServer.mockImplementation(async () => {
      transportIndex += 1;
      const id = transportIndex;
      return {
        transport: {
          id,
          handleRequest: jest.fn(async (_req: express.Request, res: express.Response) => {
            res.status(200).json({ ok: true, transportId: id });
          }),
        },
      };
    });
  });

  it('builds a fresh MCP server and transport for each HTTP request', async () => {
    const app = buildApp();

    const firstResponse = await request(app).post('/mcp').send({ call: 1 });
    const secondResponse = await request(app).post('/mcp').send({ call: 2 });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.body.transportId).toBe(1);
    expect(secondResponse.body.transportId).toBe(2);
    expect(mockBuildMcpServer).toHaveBeenCalledTimes(2);
    expect(mockCreateMcpRequestContextProxy).toHaveBeenCalledTimes(2);
    expect(mockRunWithMcpRequestContext).toHaveBeenCalledTimes(2);

    const [firstCallResult, secondCallResult] = mockBuildMcpServer.mock.results;
    expect(firstCallResult.value).not.toBe(secondCallResult.value);
  });

  it.each(['context', 'server', 'transport'] as const)('sanitizes %s dependency failures', async stage => {
    const internalDetail = ['phase2b', stage, 'internal'].join('-');

    if (stage === 'context') {
      mockBuildMcpRequestContext.mockImplementation(() => {
        throw new Error(internalDetail);
      });
    } else if (stage === 'server') {
      mockBuildMcpServer.mockRejectedValue(new Error(internalDetail));
    } else {
      mockBuildMcpServer.mockResolvedValue({
        transport: {
          handleRequest: jest.fn(async () => {
            throw new Error(internalDetail);
          }),
        },
      });
    }

    const response = await request(buildApp()).post('/mcp').send({ operation: 'synthetic' });
    const observable = {
      body: response.body,
      text: response.text,
      logs: mockApiLoggerError.mock.calls,
    };

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'MCP_OPERATION_FAILED',
      message: 'MCP operation failed.',
    });
    expect(containsForbiddenValue(observable, internalDetail)).toBe(false);
    expect(mockApiLoggerError).toHaveBeenCalledWith('MCP transport failed', {
      module: 'mcp',
      errorCode: 'MCP_OPERATION_FAILED',
      operation: 'mcp.http.request',
      errorClass: 'Error',
      requestId: 'phase2b-mcp-http-request',
      traceId: 'phase2b-mcp-http-trace',
      retryable: false,
    });
  });

  it('returns the stable transport error when diagnostic logging fails', async () => {
    mockBuildMcpServer.mockRejectedValue(new Error('unobservable transport detail'));
    mockApiLoggerError.mockImplementation(() => {
      throw new Error('unobservable logger detail');
    });

    const response = await request(buildApp()).post('/mcp').send({ operation: 'synthetic' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'MCP_OPERATION_FAILED',
      message: 'MCP operation failed.',
    });
  });
});
