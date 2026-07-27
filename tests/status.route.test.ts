import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writePublicHealthResponseMock = jest.fn();
const loadStateMock = jest.fn();
const updateStateMock = jest.fn();
const getOpenAIServiceHealthMock = jest.fn();

jest.unstable_mockModule('../src/core/diagnostics.js', () => ({
  writePublicHealthResponse: writePublicHealthResponseMock
}));

jest.unstable_mockModule('../src/services/stateManager.js', () => ({
  loadState: loadStateMock,
  updateState: updateStateMock,
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  getOpenAIServiceHealth: getOpenAIServiceHealthMock,
}));

const { default: statusRouter } = await import('../src/routes/status.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', statusRouter);
  return app;
}

describe('/status route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateStateMock.mockReset();
    getOpenAIServiceHealthMock.mockReset();
    writePublicHealthResponseMock.mockImplementation(async (_req, res) => {
      res.status(200).json({
        status: 'ok',
        service: 'arcanos-backend',
        version: '1.0.0'
      });
    });
    updateStateMock.mockImplementation((updates) => ({
      status: 'unknown',
      version: '0.0.0',
      lastSync: '2026-07-27T00:00:00.000Z',
      ...updates,
    }));
    getOpenAIServiceHealthMock.mockReturnValue({ status: 'healthy' });
  });

  it('aliases GET /status to the public health response without stale state', async () => {
    const response = await request(buildApp()).get('/status');

    expect(response.status).toBe(200);
    expect(response.headers['x-status-endpoint']).toBe('deprecated');
    expect(response.headers['x-status-replacement']).toBe('/health');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      status: 'ok',
      service: 'arcanos-backend',
      version: '1.0.0'
    });
    expect(writePublicHealthResponseMock).toHaveBeenCalledTimes(1);
  });

  it('returns a fixed no-store error while preserving deprecation metadata', async () => {
    const privateFailureSentinel = 'PRIVATE_STATUS_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const failure = new Error(`status failed: ${privateFailureSentinel}`);
    failure.name = `PrivateStatusFailure:${privateFailureSentinel}`;
    writePublicHealthResponseMock.mockRejectedValueOnce(failure);

    try {
      const response = await request(buildApp()).get('/status');

      expect(response.status).toBe(500);
      expect(response.headers['x-status-endpoint']).toBe('deprecated');
      expect(response.headers['x-status-replacement']).toBe('/health');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        error: 'Failed to retrieve system state',
        message: 'Status endpoint unavailable.',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('marks an unconfirmed POST challenge no-store before state mutation', async () => {
    const response = await request(buildApp())
      .post('/status')
      .send({ status: 'maintenance' });

    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(updateStateMock).not.toHaveBeenCalled();
  });

  it('preserves the confirmed POST success payload', async () => {
    const response = await request(buildApp())
      .post('/status')
      .set('x-confirmed', 'yes')
      .send({ status: 'maintenance' });

    expect(response.status).toBe(200);
    expect(response.headers['x-confirmation-status']).toBe('confirmed');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      status: 'maintenance',
      version: '0.0.0',
      lastSync: '2026-07-27T00:00:00.000Z',
    });
    expect(updateStateMock).toHaveBeenCalledWith({ status: 'maintenance' });
  });

  it('returns a fixed error when confirmed state persistence fails', async () => {
    const privateFailureSentinel = 'PRIVATE_STATUS_UPDATE_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error(`state persistence failed: ${privateFailureSentinel}`);
    failure.name = `PrivateStatePersistenceFailure:${privateFailureSentinel}`;
    updateStateMock.mockImplementationOnce(() => {
      throw failure;
    });

    try {
      const response = await request(buildApp())
        .post('/status')
        .set('x-confirmed', 'yes')
        .send({ status: 'maintenance' });

      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        error: 'Failed to update system state',
        message: 'System state update failed.',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('contains failures from the shadowed detailed health compatibility handler', async () => {
    const privateFailureSentinel = 'PRIVATE_STATUS_HEALTH_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error(`health dependency failed: ${privateFailureSentinel}`);
    failure.name = `PrivateHealthFailure:${privateFailureSentinel}`;
    getOpenAIServiceHealthMock.mockImplementationOnce(() => {
      throw failure;
    });

    try {
      const response = await request(buildApp()).get('/health');

      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        error: 'Failed to retrieve health status',
        message: 'Health status unavailable.',
        status: 'unhealthy',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
