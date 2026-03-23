import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createJobMock = jest.fn();
const getJobByIdMock = jest.fn();
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
  getJobById: getJobByIdMock,
  getLatestJob: jest.fn(),
  listFailedJobs: jest.fn(async () => []),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn()
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
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
  getWorkerAutonomySettings: jest.fn(() => ({
    workerId: 'async-queue',
    statsWorkerId: 'async-queue',
    workerType: 'async_queue',
    heartbeatIntervalMs: 10_000,
    leaseMs: 30_000,
    inspectorIntervalMs: 30_000,
    staleAfterMs: 60_000,
    defaultMaxRetries: 2,
    retryBackoffBaseMs: 2_000,
    retryBackoffMaxMs: 60_000,
    maxJobsPerHour: 120,
    maxAiCallsPerHour: 120,
    maxRssMb: 2_048,
    queueDepthDeferralThreshold: 25,
    queueDepthDeferralMs: 5_000,
    failureWebhookUrl: null,
    failureWebhookThreshold: 3,
    failureWebhookCooldownMs: 300_000
  })),
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

describe('async /brain queue contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createJobMock.mockResolvedValue({ id: 'job-123' });
    getJobByIdMock.mockResolvedValue(null);
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Refactor this TypeScript function.',
      body: {}
    });
    tryDispatchDaemonToolsMock.mockResolvedValue(null);
    detectCognitiveDomainMock.mockReturnValue({ domain: 'code', confidence: 0.9 });
    gptFallbackClassifierMock.mockResolvedValue('code');
    delete process.env.WORKER_ID;
    delete process.env.ASK_ASYNC_WAIT_FOR_RESULT_MS;
  });

  it('queues async ask work with preserved endpoint and client context when bounded waiting is disabled', async () => {
    const response = await request(buildApp()).post('/brain').send({
      message: 'Refactor this TypeScript function.',
      async: true,
      waitForResultMs: 0,
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
        endpointName: 'brain',
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

  it('returns exact literal output immediately for explicit literal prompts', async () => {
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Write exactly this token and nothing else: BLUE-RIVER-1773037986080',
      body: {}
    });

    const response = await request(buildApp()).post('/brain').send({
      message: 'Write exactly this token and nothing else: BLUE-RIVER-1773037986080'
    });

    expect(response.status).toBe(200);
    expect(response.body.result).toBe('BLUE-RIVER-1773037986080');
    expect(response.body.module).toBe('exact-literal-dispatcher');
    expect(response.body.routingStages).toEqual(['EXACT-LITERAL-DISPATCH']);
    expect(response.body.gpt5Used).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
    expect(handleAIErrorMock).not.toHaveBeenCalled();
  });

  it('returns the completed ask payload when the worker finishes within the wait window', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-123',
      status: 'completed',
      output: {
        result: 'Refactored output',
        endpoint: 'ask',
        module: 'ft:test',
        meta: {
          id: 'resp_123',
          created: 1773037200
        }
      }
    });

    const response = await request(buildApp()).post('/brain').send({
      message: 'Refactor this TypeScript function.',
      async: true
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      result: 'Refactored output',
      endpoint: 'ask',
      module: 'ft:test',
      meta: {
        id: 'resp_123',
        created: 1773037200
      }
    });
    expect(getJobByIdMock).toHaveBeenCalledWith('job-123');
  });

  it('surfaces terminal worker failures that occur within the wait window', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-123',
      status: 'failed',
      error_message: 'OpenAI upstream timed out'
    });

    const response = await request(buildApp()).post('/brain').send({
      message: 'Refactor this TypeScript function.',
      async: true
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'ASYNC_ASK_JOB_FAILED',
      message: 'OpenAI upstream timed out',
      jobId: 'job-123',
      poll: '/jobs/job-123'
    });
  });
});
