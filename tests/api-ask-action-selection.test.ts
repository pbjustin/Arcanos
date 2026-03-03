import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetGptModuleMap = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockDispatchModuleAction = jest.fn();

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap
}));

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  getModuleMetadata: mockGetModuleMetadata,
  dispatchModuleAction: mockDispatchModuleAction
}));

const { default: apiAskRouter } = await import('../src/routes/api-ask.js');

function createApiAskTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(apiAskRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  });

  return app;
}

describe('/api/ask action selection', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApiAskTestApp();
    mockGetGptModuleMap.mockResolvedValue({
      tutor: {
        route: 'queryroute',
        module: 'test-module',
        gptId: 'tutor'
      }
    });
    mockDispatchModuleAction.mockResolvedValue({ ok: true });
  });

  it("prefers the 'query' action when available", async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'query', 'analyze']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'hello world'
    });

    expect(response.status).toBe(200);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'test-module',
      'query',
      expect.objectContaining({ prompt: 'hello world' })
    );
  });

  it('uses the only available action when exactly one action is exposed', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'hello world'
    });

    expect(response.status).toBe(200);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'test-module',
      'summarize',
      expect.objectContaining({ prompt: 'hello world' })
    );
  });

  it("fails closed when actions are ambiguous and no 'query' action exists", async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'analyze']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'hello world'
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain(
      "Ambiguous actions and no default 'query' action found for module test-module"
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
