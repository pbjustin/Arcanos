import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

const logExecutionMock = jest.fn();

jest.unstable_mockModule('../src/core/db/index.js', () => ({
  logExecution: logExecutionMock,
}));

const { sendSdkFailure } = await import('../src/routes/sdk/shared.js');

describe('SDK failure response boundary', () => {
  it('logs through redaction but returns a stable public error', async () => {
    logExecutionMock.mockResolvedValue(undefined);
    const app = express();
    app.get('/failure', async (_req, res) => {
      await sendSdkFailure(
        res,
        'SDK test failure',
        new Error('SENTINEL_SDK_INTERNAL_FAILURE'),
        { apiKey: 'test-SENTINEL_SDK_SECRET_VALUE' }
      );
    });

    const response = await request(app).get('/failure');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('SDK operation failed');
    expect(JSON.stringify(response.body)).not.toContain(
      'SENTINEL_SDK_INTERNAL_FAILURE'
    );
    expect(JSON.stringify(response.body)).not.toContain(
      'SENTINEL_SDK_SECRET_VALUE'
    );
    expect(logExecutionMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logExecutionMock.mock.calls[0])).not.toContain(
      'SENTINEL_SDK_SECRET_VALUE'
    );
  });
});
