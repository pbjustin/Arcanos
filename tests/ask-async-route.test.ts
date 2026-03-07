import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createJobMock = jest.fn();
const validateAIRequestMock = jest.fn();
const handleAIErrorMock = jest.fn();
const logRequestFeedbackMock = jest.fn();
const tryDispatchDaemonToolsMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const gptFallbackClassifierMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock,
  claimNextPendingJob: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  recoverStaleJobs: jest.fn(),
  updateJob: jest.fn(),
  getJobById: jest.fn(),
  getLatestJob: jest.fn(),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn()
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock
}));

jest.unstable_mockModule('../src/routes/ask/daemonTools.js', () => ({
  tryDispatchDaemonTools: tryDispatchDaemonToolsMock
}));

jest.unstable_mockModule('@dispatcher/detectCognitiveDomain.js', () => ({
  detectCognitiveDomain: detectCognitiveDomainMock
}));

jest.unstable_mockModule('@dispatcher/gptDomainClassifier.js', () => ({
  gptFallbackClassifier: gptFallbackClassifierMock
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomyHealthReport: jest.fn(async () => ({
    overallStatus: 'healthy',
    alerts: [],
    workers: []
  })),
  planAutonomousWorkerJob: jest.fn(async () => ({
    status: 'pending',
    retryCount: 0,
    maxRetries: 2,
    priority: 100,
    autonomyState: {
      planner: {
        reasons: []
      }
    },
    planningReasons: []
  }))
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const askRouter = (await import('../src/routes/ask.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', askRouter);
  return app;
}

describe('async /ask queue contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createJobMock.mockResolvedValue({ id: 'job-123' });
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Refactor this TypeScript function.',
      body: {}
    });
    tryDispatchDaemonToolsMock.mockResolvedValue(null);
    detectCognitiveDomainMock.mockReturnValue({ domain: 'code', confidence: 0.9 });
    gptFallbackClassifierMock.mockResolvedValue('code');
    delete process.env.WORKER_ID;
  });

  it('queues async ask work with preserved endpoint and client context', async () => {
    const response = await request(buildApp()).post('/ask').send({
      message: 'Refactor this TypeScript function.',
      async: true,
      sessionId: 'session-123',
      clientContext: {
        routingDirectives: ['concise']
      }
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      status: 'pending',
      jobId: 'job-123',
      poll: '/jobs/job-123'
    });
    expect(createJobMock).toHaveBeenCalledWith(
      'api',
      'ask',
      expect.objectContaining({
        prompt: 'Refactor this TypeScript function.',
        sessionId: 'session-123',
        cognitiveDomain: 'code',
        endpointName: 'ask',
        clientContext: {
          routingDirectives: ['concise']
        }
      }),
      expect.objectContaining({
        maxRetries: 2,
        priority: 100
      })
    );
    expect(handleAIErrorMock).not.toHaveBeenCalled();
  });
});
