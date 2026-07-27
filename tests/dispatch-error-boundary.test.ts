import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockCreateDagRun = jest.fn();
const requestErrorLoggerMock = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    createRun: mockCreateDagRun
  }
}));

jest.unstable_mockModule('@dag/templates.js', () => ({
  TRINITY_CORE_DAG_TEMPLATE_NAME: 'trinity-core'
}));

const { default: dispatchRouter } = await import('../src/routes/dispatch.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & {
      logger: { error: typeof requestErrorLoggerMock };
    }).logger = {
      error: requestErrorLoggerMock
    };
    next();
  });
  app.use('/', dispatchRouter);
  return app;
}

describe('/dispatch error boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not expose unexpected dispatch exceptions', async () => {
    const privateErrorSentinel = 'PRIVATE_DISPATCH_FAILURE_SENTINEL';
    const rawMessage = `dispatch provider failed: ${privateErrorSentinel}`;
    mockRouteGptRequest.mockRejectedValueOnce(new Error(rawMessage));

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'arcanos-core',
        action: 'query',
        executionMode: 'gpt',
        prompt: 'Run a normal writing request.'
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      code: 'DISPATCH_FAILED',
      message: 'Dispatch failed.',
      routeFamily: 'dispatch',
      target: 'gpt',
      action: 'query',
      executionMode: 'gpt'
    });
    expect(JSON.stringify(response.body)).not.toContain(rawMessage);
    expect(JSON.stringify(response.body)).not.toContain(privateErrorSentinel);
    expect(requestErrorLoggerMock).toHaveBeenCalledWith(
      'dispatch.universal.failed',
      expect.objectContaining({
        target: 'gpt',
        gptId: 'arcanos-core',
        action: 'query',
        executionMode: 'gpt',
        error: rawMessage
      })
    );
  });
});
