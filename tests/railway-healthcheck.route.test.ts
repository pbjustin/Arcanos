import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runHealthCheckMock = jest.fn();

jest.unstable_mockModule('@platform/logging/diagnostics.js', () => ({
  runHealthCheck: runHealthCheckMock,
}));

const { registerRoutes } = await import('../src/routes/register.js');

function buildApp() {
  const app = express();
  registerRoutes(app);
  return app;
}

function buildHealthReport(input: {
  status: 'ok' | 'degraded';
  workerFiles?: string[];
  workerReason?: string;
  memory?: Partial<{
    heapMB: string;
    rssMB: string;
    externalMB: string;
    arrayBuffersMB: string;
  }>;
}) {
  return {
    status: input.status,
    summary: input.workerReason
      ? `Heap 12.00MB | Workers: ${input.workerReason}`
      : 'Heap 12.00MB | Workers: healthy',
    components: {
      workers: {
        expected: true,
        directoryExists: input.status === 'ok',
        healthy: input.status === 'ok',
        files: input.workerFiles ?? [],
        reason: input.workerReason,
      },
      memory: {
        heapMB: '12.00',
        rssMB: '24.00',
        externalMB: '3.00',
        arrayBuffersMB: '1.00',
        ...input.memory,
      },
    },
  };
}

describe('GET /railway/healthcheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('projects degraded worker diagnostics without paths, filenames, or raw reasons', async () => {
    const privatePathSentinel =
      'C:\\private\\runtime\\PRIVATE_RAILWAY_WORKER_PATH_SENTINEL';
    const privateFilenameSentinel = 'private-worker-module-sentinel.js';
    runHealthCheckMock.mockReturnValue(buildHealthReport({
      status: 'degraded',
      workerFiles: [privateFilenameSentinel],
      workerReason: `Workers directory not found (checked: ${privatePathSentinel})`,
    }));

    const response = await request(buildApp()).get('/railway/healthcheck');

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      status: 'degraded',
      code: 'RAILWAY_HEALTHCHECK_DEGRADED',
      components: {
        workers: {
          expected: true,
          directoryExists: false,
          healthy: false,
          fileCount: 1,
        },
        memory: {
          heapMB: '12.00',
          rssMB: '24.00',
          externalMB: '3.00',
          arrayBuffersMB: '1.00',
        },
      },
      summary: 'Railway healthcheck is degraded.',
      timestamp: expect.any(String),
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(privatePathSentinel);
    expect(serialized).not.toContain(privateFilenameSentinel);
  });

  it('preserves the healthy status code through the bounded public projection', async () => {
    const privateFilenameSentinel = 'healthy-private-worker-module.js';
    runHealthCheckMock.mockReturnValue(buildHealthReport({
      status: 'ok',
      workerFiles: [privateFilenameSentinel],
    }));

    const response = await request(buildApp()).get('/railway/healthcheck');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body.status).toBe('ok');
    expect(response.body.code).toBe('RAILWAY_HEALTHCHECK_OK');
    expect(response.body.summary).toBe('Railway healthcheck is healthy.');
    expect(response.body.components.workers.fileCount).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain(privateFilenameSentinel);
  });

  it('normalizes invalid memory diagnostics instead of reflecting their values', async () => {
    const privateMemorySentinel = 'PRIVATE_RAILWAY_MEMORY_SENTINEL';
    runHealthCheckMock.mockReturnValue(buildHealthReport({
      status: 'ok',
      memory: {
        heapMB: privateMemorySentinel,
        rssMB: '-1',
        externalMB: '3.456',
        arrayBuffersMB: 'Infinity',
      },
    }));

    const response = await request(buildApp()).get('/railway/healthcheck');

    expect(response.status).toBe(200);
    expect(response.body.components.memory).toEqual({
      heapMB: '0.00',
      rssMB: '0.00',
      externalMB: '3.46',
      arrayBuffersMB: '0.00',
    });
    expect(JSON.stringify(response.body)).not.toContain(privateMemorySentinel);
  });

  it('returns a fixed no-store response when health report generation throws', async () => {
    const privateFailureSentinel = 'PRIVATE_RAILWAY_HEALTHCHECK_FAILURE_SENTINEL';
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    runHealthCheckMock.mockImplementation(() => {
      const failure = new Error(`health report failed: ${privateFailureSentinel}`);
      failure.name = `PrivateRailwayFailure:${privateFailureSentinel}`;
      throw failure;
    });

    try {
      const response = await request(buildApp()).get('/railway/healthcheck');

      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).toEqual({
        status: 'error',
        code: 'RAILWAY_HEALTHCHECK_UNAVAILABLE',
        message: 'Railway healthcheck unavailable.',
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(privateFailureSentinel);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});
