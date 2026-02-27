import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import requestContext from '../src/middleware/requestContext.js';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';

type LoggedPayload = {
  event?: string;
  level?: string;
  path?: string;
  latencyMs?: number;
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

describe('requestContext security logging', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('removes query parameters from request logs', async () => {
    const app = express();
    app.use(requestContext);
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).get('/probe?token=abc123');

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const requestReceived = logs.find((entry) => entry.event === 'request.received');
    const requestCompleted = logs.find((entry) => entry.event === 'request.completed');

    expect(requestReceived?.path).toBe('/probe');
    expect(requestCompleted?.path).toBe('/probe');
  });

  it('keeps request.completed latency as a top-level field for non-2xx responses', async () => {
    const app = express();
    app.use(requestContext);
    app.get('/not-found', (_req, res) => {
      res.status(404).json({ ok: false });
    });

    await request(app).get('/not-found?token=abc123');

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const requestCompleted = logs.find((entry) => entry.event === 'request.completed');

    expect(requestCompleted?.level).toBe('warn');
    expect(typeof requestCompleted?.latencyMs).toBe('number');
    expect((requestCompleted?.data as { statusCode?: unknown }).statusCode).toBe(404);
    expect((requestCompleted?.data as Record<string, unknown>).latencyMs).toBeUndefined();
  });

  it('sanitizes path in global error logs', async () => {
    const app = express();
    app.use(requestContext);
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.use(errorHandler);

    await request(app).get('/boom?apiKey=topsecret');

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    const requestFailed = logs.find((entry) => entry.event === 'request.failed');

    expect(requestFailed?.path).toBe('/boom');
    expect((requestFailed?.data as { path?: unknown }).path).toBe('/boom');
  });
});
