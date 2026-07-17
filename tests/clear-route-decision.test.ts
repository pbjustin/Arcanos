import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const buildClear2SummaryMock = jest.fn();
const apiLoggerErrorMock = jest.fn();
const childLoggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../src/services/clear2.js', () => ({
  buildClear2Summary: buildClear2SummaryMock,
}));

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  getClearScore: jest.fn(),
}));

jest.unstable_mockModule('../src/platform/runtime/unifiedConfig.js', () => ({
  getConfig: jest.fn(() => ({ enableClear2: true })),
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: apiLoggerErrorMock,
  },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => childLoggerMock),
  },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const clearRouter = (await import('../src/routes/clear.js')).default;

const requestBody = {
  actions: [{
    agent_id: 'phase2b-agent',
    capability: 'inspect',
    params: {},
  }],
  origin: 'phase2b-clear-route-test',
  confidence: 0.8,
};

const validSummary = {
  clarity: 0.8,
  leverage: 0.8,
  efficiency: 0.8,
  alignment: 0.8,
  resilience: 0.8,
  overall: 0.8,
  decision: 'allow',
  notes: 'synthetic valid summary',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'phase2b-clear-http-request';
    req.traceId = 'phase2b-clear-http-trace';
    next();
  });
  app.use(clearRouter);
  return app;
}

describe('HTTP direct CLEAR evaluation contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves a valid evaluator response', async () => {
    buildClear2SummaryMock.mockReturnValue(validSummary);

    const response = await request(buildApp()).post('/clear/evaluate').send(requestBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(validSummary);
    expect(apiLoggerErrorMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null result', null, 503, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.'],
    ['missing decision', { ...validSummary, decision: undefined }, 503, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.'],
    ['contradictory result', { ...validSummary, overall: 0.2 }, 500, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.'],
    ['malformed score', { ...validSummary, overall: Number.NaN }, 500, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.'],
  ] as const)('rejects %s without returning HTTP 200', async (_label, result, status, category, message) => {
    buildClear2SummaryMock.mockReturnValue(result);

    const response = await request(buildApp()).post('/clear/evaluate').send(requestBody);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: category, message });
  });

  it('sanitizes evaluator exceptions and diagnostic logging', async () => {
    const internalDetail = [
      ['Authorization', 'Bearer', ['phase2b', 'clear-route', 'marker'].join('-')].join(' '),
      ['SELECT', '*', 'FROM', 'private_clear_route'].join(' '),
      ['C:', 'private', 'clear-route.log'].join('\\'),
    ].join(' | ');
    buildClear2SummaryMock.mockImplementation(() => {
      throw new Error(internalDetail);
    });

    const response = await request(buildApp()).post('/clear/evaluate').send(requestBody);
    const observable = JSON.stringify({ body: response.body, text: response.text, logs: apiLoggerErrorMock.mock.calls });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'CLEAR_EVALUATION_UNAVAILABLE',
      message: 'CLEAR evaluation is unavailable.',
    });
    expect(observable).not.toContain(internalDetail);
    expect(observable).not.toContain('private_clear_route');
    expect(observable).not.toContain('clear-route.log');
  });
});
