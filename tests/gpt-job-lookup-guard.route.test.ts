import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
const resolveAsyncGptPollIntervalMsMock = jest.fn(() => 250);
const resolveAsyncGptWaitForResultMsMock = jest.fn((requested?: number) => requested ?? 3500);
class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
  getJobById: getJobByIdMock,
  createJob: jest.fn(),
  claimNextPendingJob: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  recoverStaleJobs: jest.fn(),
  updateJob: jest.fn(),
  getLatestJob: jest.fn(),
  listFailedJobs: jest.fn(async () => []),
  requeueFailedJob: jest.fn(),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn(),
  requestJobCancellation: jest.fn(),
  cleanupExpiredGptJobs: jest.fn(async () => ({
    expiredPending: 0,
    expiredTerminal: 0,
    deletedExpired: 0
  }))
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: planAutonomousWorkerJobMock,
  getWorkerAutonomyHealthReport: jest.fn(async () => ({
    status: 'ok',
    workers: [],
  })),
  getWorkerAutonomySettings: jest.fn(() => ({
    enabled: false,
    mode: 'off',
  })),
}));

jest.unstable_mockModule('../src/services/queuedGptCompletionService.js', () => ({
  waitForQueuedGptJobCompletion: waitForQueuedGptJobCompletionMock,
  resolveAsyncGptPollIntervalMs: resolveAsyncGptPollIntervalMsMock,
  resolveAsyncGptWaitForResultMs: resolveAsyncGptWaitForResultMsMock
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

describe('natural-language job lookup guard on /gpt/:gptId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveGptRouting.mockImplementation(async (gptId: string) => ({
      ok: true,
      plan: {
        matchedId: gptId,
        module: 'ARCANOS:CORE',
        route: 'core',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact'
      },
      _route: {
        gptId,
        route: 'core',
        module: 'ARCANOS:CORE',
        action: 'query',
        timestamp: '2026-04-24T00:00:00.000Z'
      }
    }));
  });

  it('rejects result retrieval prompts and points callers to the canonical jobs result route', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Pull result for job job-123.'
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      action: 'result_lookup',
      gptId: 'arcanos-core',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'JOB_LOOKUP_REQUIRES_JOBS_API',
        message: 'Job retrieval requests must use the jobs API. Do not send result or status lookups through POST /gpt/{gptId}.'
      },
      canonical: {
        poll: '/jobs/job-123/result',
        result: '/jobs/job-123/result'
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'job_lookup_guard',
        action: 'result_lookup'
      })
    }));
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects look-up phrasing that previously slipped through to the writing plane', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Look up job id job-123 and return its result.'
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      action: 'result_lookup',
      gptId: 'arcanos-core',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'JOB_LOOKUP_REQUIRES_JOBS_API',
        message: 'Job retrieval requests must use the jobs API. Do not send result or status lookups through POST /gpt/{gptId}.'
      },
      canonical: {
        poll: '/jobs/job-123/result',
        result: '/jobs/job-123/result'
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'job_lookup_guard',
        action: 'result_lookup'
      })
    }));
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects status polling prompts and points callers to the canonical jobs status route', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Check status for job job-456'
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      action: 'status_lookup',
      gptId: 'arcanos-core',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'JOB_LOOKUP_REQUIRES_JOBS_API',
        message: 'Job retrieval requests must use the jobs API. Do not send result or status lookups through POST /gpt/{gptId}.'
      },
      canonical: {
        poll: '/jobs/job-456/result',
        result: '/jobs/job-456/result'
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'job_lookup_guard',
        action: 'status_lookup'
      })
    }));
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects question-style status prompts that include a concrete job id', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'What is the status of job job-789?'
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      action: 'status_lookup',
      gptId: 'arcanos-core',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'JOB_LOOKUP_REQUIRES_JOBS_API',
        message: 'Job retrieval requests must use the jobs API. Do not send result or status lookups through POST /gpt/{gptId}.'
      },
      canonical: {
        poll: '/jobs/job-789/result',
        result: '/jobs/job-789/result'
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'job_lookup_guard',
        action: 'status_lookup'
      })
    }));
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('rejects lookup prompts that omit a concrete job id', async () => {
    const response = await request(buildApp())
      .post('/gpt/arcanos-core')
      .send({
        prompt: 'Fetch result for job please.'
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      action: 'result_lookup',
      gptId: 'arcanos-core',
      route: '/gpt/:gptId',
      traceId: expect.any(String),
      error: {
        code: 'JOB_ID_REQUIRED',
        message: 'Job retrieval prompts sent to /gpt/{gptId} must include a concrete job ID. Use the jobs API instead of prompting the GPT route.'
      },
      canonical: {
        poll: null,
        result: null
      },
      _route: expect.objectContaining({
        gptId: 'arcanos-core',
        route: 'job_lookup_guard',
        action: 'result_lookup'
      })
    }));
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });
});
