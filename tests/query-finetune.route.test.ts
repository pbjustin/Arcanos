import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityMock = jest.fn();

jest.unstable_mockModule('../src/trinity/trinity.js', () => ({
  runTrinity: runTrinityMock
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const requestContext = (await import('../src/middleware/requestContext.js')).default;
const errorHandler = (await import('../src/transport/http/middleware/errorHandler.js')).default;
const queryFinetuneRouter = (await import('../src/routes/queryFinetune.js')).default;

type LoggedPayload = {
  event?: string;
  traceId?: string;
  data?: Record<string, unknown>;
};

function collectStructuredLogs(logCalls: unknown[][]): LoggedPayload[] {
  return logCalls
    .map((call) => {
      const firstArg = call[0];
      if (typeof firstArg !== 'string') {
        return null;
      }

      try {
        return JSON.parse(firstArg) as LoggedPayload;
      } catch {
        return null;
      }
    })
    .filter((payload): payload is LoggedPayload => payload !== null);
}

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use('/', queryFinetuneRouter);
  app.use(errorHandler);
  return app;
}

describe('/query-finetune route', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    runTrinityMock.mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('rejects invalid payloads with a deterministic schema error', async () => {
    const response = await request(buildApp()).post('/query-finetune').send({ bad: 'payload' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'invalid request schema',
      details: ['Required']
    });
    expect(runTrinityMock).not.toHaveBeenCalled();
  });

  it('returns structured success payloads with route telemetry', async () => {
    runTrinityMock.mockResolvedValue({
      requestedModel: 'ft:model',
      model: 'ft:model',
      activeModel: 'ft:model',
      output: '{"ok":true}',
      fallbackFlag: false,
      raw: { id: 'resp_123' }
    });

    const response = await request(buildApp()).post('/query-finetune').send({ prompt: 'health check' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      activeModel: 'ft:model',
      fallbackFlag: false
    }));
    expect(runTrinityMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'health check',
      model: expect.any(String),
      structured: true,
      latencyBudgetMs: 8_000
    }));
    expect(typeof response.headers['x-trace-id']).toBe('string');

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const routeCompleted = logs.find((entry) => entry.event === 'ai.route.completed');
    expect(routeCompleted?.traceId).toBe(response.headers['x-trace-id']);
    expect((routeCompleted?.data as { endpoint?: unknown }).endpoint).toBe('query-finetune');
    expect((routeCompleted?.data as { activeModel?: unknown }).activeModel).toBe('ft:model');
  });

  it('maps malformed JSON bodies to invalid request schema responses', async () => {
    const response = await request(buildApp())
      .post('/query-finetune')
      .set('Content-Type', 'application/json')
      .send('{"prompt":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'invalid request schema',
      code: 400
    });
  });
});
