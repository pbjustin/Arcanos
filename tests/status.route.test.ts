import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writePublicHealthResponseMock = jest.fn();

jest.unstable_mockModule('../src/core/diagnostics.js', () => ({
  writePublicHealthResponse: writePublicHealthResponseMock
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
    writePublicHealthResponseMock.mockImplementation(async (_req, res) => {
      res.status(200).json({
        status: 'ok',
        service: 'arcanos-backend',
        version: '1.0.0'
      });
    });
  });

  it('aliases GET /status to the public health response without stale state', async () => {
    const response = await request(buildApp()).get('/status');

    expect(response.status).toBe(200);
    expect(response.headers['x-status-endpoint']).toBe('deprecated');
    expect(response.headers['x-status-replacement']).toBe('/health');
    expect(response.body).toEqual({
      status: 'ok',
      service: 'arcanos-backend',
      version: '1.0.0'
    });
    expect(writePublicHealthResponseMock).toHaveBeenCalledTimes(1);
  });
});
