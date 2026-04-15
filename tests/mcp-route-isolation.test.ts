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

const router = (await import('../src/routes/mcp.js')).default;

function buildApp() {
  const app = express();
  app.use(router);
  return app;
}

describe('mcp route request isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMcpRequestContext.mockReturnValue({ requestId: 'req-1' });

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
});
