import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const getJobQueueSummaryMock = jest.fn();
const getLatestJobMock = jest.fn();
const listFailedJobsMock = jest.fn();
const requeueFailedJobMock = jest.fn();
const dispatchArcanosTaskMock = jest.fn();
const getWorkerRuntimeStatusMock = jest.fn();
const startWorkersMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const getDatabaseStatusMock = jest.fn();
const getWorkerControlHealthMock = jest.fn();
const recordSelfHealEventMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock,
  getJobById: getJobByIdMock,
  getJobQueueSummary: getJobQueueSummaryMock,
  getLatestJob: getLatestJobMock,
  listFailedJobs: listFailedJobsMock,
  deferJobForProviderRecovery: jest.fn(),
  requeueFailedJob: requeueFailedJobMock
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  dispatchArcanosTask: dispatchArcanosTaskMock,
  getWorkerRuntimeStatus: getWorkerRuntimeStatusMock,
  startWorkers: startWorkersMock
}));

jest.unstable_mockModule('@dispatcher/detectCognitiveDomain.js', () => ({
  detectCognitiveDomain: detectCognitiveDomainMock
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  getStatus: getDatabaseStatusMock
}));

jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  recordSelfHealEvent: recordSelfHealEventMock,
  inferSelfHealComponentFromAction: jest.fn(() => 'worker_runtime'),
  inferSelfHealComponentFromRequest: jest.fn(() => 'worker_runtime'),
  buildSelfHealTelemetrySnapshot: jest.fn(),
  buildCompactSelfHealSummary: jest.fn()
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomyHealthReport: getWorkerControlHealthMock,
  getWorkerAutonomySettings: jest.fn(() => ({
    defaultMaxRetries: 2,
    retryBackoffBaseMs: 2000,
    retryBackoffMaxMs: 60000,
    staleAfterMs: 60000,
    watchdogIdleMs: 120000
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
const workerHelperRouter = (await import('../src/routes/worker-helper.js')).default;
const workerHelperToken = 'worker-helper-test-token-1234567890';
const jobReadSecret = 'worker-helper-job-read-capability-secret-1234567890';
const originalWorkerHelperToken = process.env.ARCANOS_WORKER_HELPER_TOKEN;
const originalJobReadSecret = process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

function buildApp(options: { authUser?: any; daemonToken?: string; operatorActor?: string } = {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  if (options.authUser || options.daemonToken || options.operatorActor) {
    app.use((req, _res, next) => {
      if (options.authUser) {
        req.authUser = options.authUser;
      }
      if (options.daemonToken) {
        req.daemonToken = options.daemonToken;
      }
      if (options.operatorActor) {
        req.operatorActor = options.operatorActor;
      }
      next();
    });
  }
  app.use('/', workerHelperRouter);
  return app;
}

function withWorkerHelperToken(requestBuilder: any): any {
  return requestBuilder.set('x-arcanos-worker-helper-token', workerHelperToken);
}

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => [
    key,
    ...collectObjectKeys(nestedValue),
  ]);
}

describe('/worker-helper routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-06T10:00:30.000Z'));
    delete process.env.WORKER_ID;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    process.env.ARCANOS_WORKER_HELPER_TOKEN = workerHelperToken;
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = jobReadSecret;

    getDatabaseStatusMock.mockReturnValue({
      connected: true,
      hasPool: true,
      error: null
    });
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: true,
      model: 'gpt-5.1',
      configuredCount: 2,
      started: true,
      activeListeners: 2,
      workerIds: ['worker-1', 'worker-2'],
      totalDispatched: 5
    });
    getJobQueueSummaryMock.mockResolvedValue({
      pending: 1,
      running: 0,
      completed: 3,
      failed: 1,
      total: 5,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0,
      failureBreakdown: {
        retryable: 0,
        permanent: 1,
        retryScheduled: 0,
        retryExhausted: 1,
        authentication: 0,
        network: 0,
        provider: 0,
        rateLimited: 0,
        timeout: 1,
        validation: 0,
        unknown: 0
      },
      recentFailureReasons: [
        {
          reason: 'OpenAI upstream timeout',
          category: 'timeout',
          retryable: false,
          count: 1,
          lastSeenAt: '2026-03-06T09:58:00.000Z'
        }
      ],
      lastUpdatedAt: '2026-03-06T10:00:00.000Z'
    });
    getLatestJobMock.mockResolvedValue({
      id: 'job-latest',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'completed',
      created_at: '2026-03-06T09:59:00.000Z',
      updated_at: '2026-03-06T10:00:00.000Z',
      completed_at: '2026-03-06T10:00:00.000Z',
      error_message: null,
      output: { result: 'ok' }
    });
    listFailedJobsMock.mockResolvedValue([
      {
        id: 'job-failed-1',
        worker_id: 'worker-helper',
        last_worker_id: 'async-queue-slot-1',
        job_type: 'ask',
        status: 'failed',
        error_message: 'OpenAI upstream timeout',
        retry_count: 2,
        max_retries: 2,
        created_at: '2026-03-06T09:55:00.000Z',
        updated_at: '2026-03-06T09:58:00.000Z',
        completed_at: '2026-03-06T09:58:00.000Z'
      }
    ]);
    createJobMock.mockResolvedValue({ id: 'job-123' });
    getWorkerControlHealthMock.mockResolvedValue({
      overallStatus: 'healthy',
      alerts: [],
      diagnosticAlerts: [],
      queueSummary: {
        pending: 1,
        running: 0,
        completed: 3,
        failed: 1,
        total: 5,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        recentFailed: 0,
        recentCompleted: 0,
        recentTotalTerminal: 0,
        recentTerminalWindowMs: 3600000,
        failureBreakdown: {
          retryable: 0,
          permanent: 1,
          retryScheduled: 0,
          retryExhausted: 1,
          authentication: 0,
          network: 0,
          provider: 0,
          rateLimited: 0,
          timeout: 1,
          validation: 0,
          unknown: 0
        },
        recentFailureReasons: [
          {
            reason: 'OpenAI upstream timeout',
            category: 'timeout',
            retryable: false,
            count: 1,
            lastSeenAt: '2026-03-06T09:58:00.000Z'
          }
        ],
        recentTerminalWindowMs: 3600000,
        recentFailed: 0,
        recentCompleted: 0,
        recentTotalTerminal: 0,
        lastUpdatedAt: '2026-03-06T10:00:00.000Z'
      },
      operationalHealth: {
        overallStatus: 'healthy',
        alerts: [],
        pending: 1,
        running: 0,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        recentFailed: 0,
        recentCompleted: 0,
        recentTotalTerminal: 0,
        recentTerminalWindowMs: 3600000,
        workerHeartbeatAgeMs: 0,
        degradedWorkerIds: [],
        unhealthyWorkerIds: []
      },
      historicalDebt: {
        retainedFailedJobs: 1,
        retryExhaustedJobs: 1,
        deadLetterJobs: 0,
        recentFailureReasons: [
          {
            reason: 'OpenAI upstream timeout',
            category: 'timeout',
            retryable: false,
            count: 1,
            lastSeenAt: '2026-03-06T09:58:00.000Z'
          }
        ],
        failureWindowMs: 3600000,
        inspectionEndpoint: '/worker-helper/jobs/failed',
        currentRiskExcluded: true
      },
      workers: [
        {
          workerId: 'async-queue',
          workerType: 'async_queue',
          healthStatus: 'healthy',
          operationalStatus: 'healthy',
          currentJobId: null,
          lastError: null,
          lastHeartbeatAt: '2026-03-06T10:00:00.000Z',
          updatedAt: '2026-03-06T10:00:00.000Z',
          snapshot: {
            dispatcherStarted: true,
            activeListeners: 2,
            lastActivityAt: '2026-03-06T10:00:00.000Z',
            lastProcessedJobAt: '2026-03-06T09:59:30.000Z',
            watchdog: {
              triggered: false,
              reason: null,
              restartRecommended: false,
              idleThresholdMs: 120000
            }
          }
        }
      ],
      settings: {
        heartbeatIntervalMs: 10000,
        leaseMs: 30000,
        inspectorIntervalMs: 30000,
        staleAfterMs: 60000,
        watchdogIdleMs: 120000,
        defaultMaxRetries: 2,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2048
      }
    });
    detectCognitiveDomainMock.mockReturnValue({ domain: 'code', confidence: 0.91 });
    dispatchArcanosTaskMock.mockResolvedValue([{ workerId: 'arcanos-core-direct', result: 'ok' }]);
    startWorkersMock.mockResolvedValue({
      started: true,
      alreadyRunning: false,
      runWorkers: true,
      workerCount: 2,
      workerIds: ['worker-1', 'worker-2'],
      model: 'gpt-5.1',
      startedAt: '2026-03-06T10:05:00.000Z',
      message: 'Workers started successfully.'
    });
    recordSelfHealEventMock.mockReset();
  });

  it('returns aggregate no-store status without helper auth', async () => {
    const response = await request(buildApp()).get('/worker-helper/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      status: 'healthy',
      runtime: expect.objectContaining({
        status: 'active',
        totalDispatched: 5
      }),
      workers: expect.objectContaining({
        configured: 2,
        active: 2,
        observed: 1
      }),
      queue: expect.objectContaining({
        status: 'active',
        total: 5,
        pending: 1,
        running: 0
      }),
      timestamp: '2026-03-06T10:00:30.000Z'
    }));
  });

  it.each([
    [
      'status',
      '/worker-helper/status',
      () => getLatestJobMock.mockRejectedValueOnce(new Error('sentinel-worker-helper-secret')),
      'WORKER_HELPER_STATUS_FAILED',
      'Worker helper status request failed.'
    ],
    [
      'health',
      '/worker-helper/health',
      () => getWorkerControlHealthMock.mockRejectedValueOnce(new Error('sentinel-worker-helper-secret')),
      'WORKER_HELPER_HEALTH_FAILED',
      'Worker helper health request failed.'
    ]
  ])('does not disclose dependency errors from public %s diagnostics', async (
    _name,
    path,
    arrangeFailure,
    error,
    message
  ) => {
    arrangeFailure();

    const response = await request(buildApp()).get(path);

    expect(response.status).toBe(500);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({ error, message });
    expect(JSON.stringify(response.body)).not.toContain('sentinel-worker-helper-secret');
  });

  it('omits known job, prompt, result, and error sentinels from public status', async () => {
    const jobUuidSentinel = '323e4567-e89b-42d3-a456-426614174000';
    const promptSentinel = 'WORKER_HELPER_PROMPT_SENTINEL';
    const resultSentinel = 'WORKER_HELPER_RESULT_SENTINEL';
    const errorSentinel = 'WORKER_HELPER_ERROR_SENTINEL';
    getWorkerRuntimeStatusMock.mockReturnValueOnce({
      enabled: true,
      model: 'gpt-5.1',
      configuredCount: 2,
      started: true,
      startedAt: '2026-03-06T09:50:00.000Z',
      activeListeners: 1,
      workerIds: [jobUuidSentinel],
      totalDispatched: 5,
      lastDispatchAt: '2026-03-06T09:59:00.000Z',
      lastInputPreview: promptSentinel,
      lastResult: { output: resultSentinel },
      lastError: errorSentinel
    });
    getLatestJobMock.mockResolvedValueOnce({
      id: jobUuidSentinel,
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'failed',
      created_at: '2026-03-06T09:59:00.000Z',
      updated_at: '2026-03-06T10:00:00.000Z',
      completed_at: '2026-03-06T10:00:00.000Z',
      error_message: errorSentinel,
      output: { result: resultSentinel }
    });
    listFailedJobsMock.mockResolvedValueOnce([{
      id: jobUuidSentinel,
      worker_id: 'worker-helper',
      last_worker_id: 'async-queue-slot-1',
      job_type: 'ask',
      status: 'failed',
      error_message: errorSentinel,
      retry_count: 2,
      max_retries: 2,
      created_at: '2026-03-06T09:55:00.000Z',
      updated_at: '2026-03-06T09:58:00.000Z',
      completed_at: '2026-03-06T09:58:00.000Z'
    }]);

    const response = await request(buildApp()).get('/worker-helper/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      status: 'healthy',
      runtime: expect.objectContaining({
        status: 'active',
        totalDispatched: 5,
        startedAt: '2026-03-06T09:50:00.000Z',
        lastDispatchAt: '2026-03-06T09:59:00.000Z'
      }),
      workers: expect.objectContaining({
        configured: 2,
        active: 1,
        observed: 1
      }),
      queue: expect.objectContaining({
        total: 5,
        retainedFailed: 1,
        lastUpdatedAt: '2026-03-06T10:00:00.000Z'
      })
    }));

    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      jobUuidSentinel,
      promptSentinel,
      resultSentinel,
      errorSentinel
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(collectObjectKeys(response.body)).toEqual(
      expect.not.arrayContaining([
        'latestJob',
        'recentFailedJobs',
        'activeJobs',
        'currentJobId',
        'lastError',
        'workerIds',
        'lastInputPreview',
        'lastResult',
        'workersDirectory'
      ])
    );
  });

  it('omits sensitive public diagnostics while retaining sanitized authenticated failed-job detail', async () => {
    const privateSdkMember = ['_then', 'Unwrap'].join('');
    const privateSdkFailure = `this._client.responses.create(...).${privateSdkMember} is not a function`;
    const sensitiveFailure =
      '401 Incorrect API key provided: sk-svcac********ZygA. Authorization: Bearer abcdefghijklmnop';
    const sensitiveFailedJob = {
      id: 'job-failed-sensitive',
      worker_id: 'worker-helper',
      last_worker_id: 'async-queue-slot-1',
      job_type: 'ask',
      status: 'failed',
      error_message: sensitiveFailure,
      retry_count: 2,
      max_retries: 2,
      created_at: '2026-03-06T09:55:00.000Z',
      updated_at: '2026-03-06T09:58:00.000Z',
      completed_at: '2026-03-06T09:58:00.000Z'
    };

    getWorkerControlHealthMock.mockResolvedValueOnce({
      overallStatus: 'healthy',
      alerts: [],
      queueSummary: null,
      workers: [],
      settings: {
        heartbeatIntervalMs: 10000,
        leaseMs: 30000,
        inspectorIntervalMs: 30000,
        staleAfterMs: 60000,
        watchdogIdleMs: 120000,
        defaultMaxRetries: 2,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2048
      }
    });
    getJobQueueSummaryMock.mockResolvedValueOnce({
      pending: 0,
      running: 0,
      completed: 3,
      failed: 1,
      total: 4,
      delayed: 0,
      stalledRunning: 0,
      oldestPendingJobAgeMs: 0,
      failureBreakdown: {
        retryable: 0,
        permanent: 1,
        retryScheduled: 0,
        retryExhausted: 1,
        authentication: 1,
        network: 0,
        provider: 0,
        rateLimited: 0,
        timeout: 0,
        validation: 0,
        unknown: 0
      },
      recentFailureReasons: [
        {
          reason: sensitiveFailure,
          category: 'authentication',
          retryable: false,
          count: 1,
          lastSeenAt: '2026-03-06T09:58:00.000Z'
        },
        {
          reason: privateSdkFailure,
          category: 'unknown',
          retryable: false,
          count: 1,
          lastSeenAt: '2026-03-06T09:57:00.000Z'
        }
      ],
      recentTerminalWindowMs: 3600000,
      recentFailed: 0,
      recentCompleted: 0,
      recentTotalTerminal: 0,
      lastUpdatedAt: '2026-03-06T10:00:00.000Z'
    });
    getLatestJobMock.mockResolvedValueOnce({
      id: 'job-latest-sensitive',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'failed',
      created_at: '2026-03-06T09:59:00.000Z',
      updated_at: '2026-03-06T10:00:00.000Z',
      completed_at: '2026-03-06T10:00:00.000Z',
      error_message: sensitiveFailure,
      output: { result: 'failed' }
    });
    listFailedJobsMock
      .mockResolvedValueOnce([sensitiveFailedJob])
      .mockResolvedValueOnce([sensitiveFailedJob]);

    const statusResponse = await request(buildApp()).get('/worker-helper/status');
    const failedJobsResponse = await withWorkerHelperToken(
      request(buildApp()).get('/worker-helper/jobs/failed?limit=1')
    );
    const rendered = JSON.stringify({
      status: statusResponse.body,
      failedJobs: failedJobsResponse.body
    });

    expect(statusResponse.status).toBe(200);
    expect(failedJobsResponse.status).toBe(200);
    expect(statusResponse.headers['cache-control']).toContain('no-store');
    expect(failedJobsResponse.headers['cache-control']).toContain('no-store');
    expect(failedJobsResponse.body.jobs[0].error_message).toBe('[REDACTED]');
    expect(rendered).not.toContain('sk-svcac');
    expect(rendered).not.toContain('ZygA');
    expect(rendered).not.toContain('Bearer abcdefghijklmnop');
    expect(rendered).not.toContain(privateSdkMember);
  });

  it('ignores legacy auth headers and still serves worker helper requests', async () => {
    const response = await request(buildApp())
      .get('/worker-helper/status')
      .set('Authorization', 'Bearer test-helper-key');

    expect(response.status).toBe(200);
    expect(response.body.runtime).toEqual(expect.objectContaining({
      status: 'active',
      totalDispatched: 5
    }));
  });

  it('rejects unauthenticated worker mutation requests while preserving read-only status', async () => {
    const statusResponse = await request(buildApp()).get('/worker-helper/status');
    const queueResponse = await request(buildApp())
      .post('/worker-helper/queue/ask')
      .send({ prompt: 'Explain this stack trace.' });
    const dispatchResponse = await request(buildApp())
      .post('/worker-helper/dispatch')
      .send({ input: 'Run a direct worker check.' });
    const healResponse = await request(buildApp()).post('/worker-helper/heal?mode=plan');

    expect(statusResponse.status).toBe(200);
    expect(queueResponse.status).toBe(401);
    expect(dispatchResponse.status).toBe(401);
    expect(healResponse.status).toBe(401);
    expect(queueResponse.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(createJobMock).not.toHaveBeenCalled();
    expect(dispatchArcanosTaskMock).not.toHaveBeenCalled();
    expect(startWorkersMock).not.toHaveBeenCalled();
  });

  it('rejects operator-light worker mutation requests', async () => {
    const response = await request(buildApp({
      authUser: {
        id: 7,
        email: 'operator-light@example.test',
        role: 'operator-light',
        plan: 'internal',
        profileId: null,
        source: 'header'
      }
    }))
      .post('/worker-helper/queue/ask')
      .send({ prompt: 'Explain this stack trace.' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('WORKER_HELPER_OPERATOR_FORBIDDEN');
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it.each([
    ['daemon context', { daemonToken: 'established-daemon-context' }],
    ['operator actor', { operatorActor: 'operator:established' }],
    [
      'admin role',
      {
        authUser: {
          id: 7,
          email: 'admin@example.test',
          role: 'admin',
          plan: 'internal',
          profileId: null,
          source: 'session'
        }
      }
    ],
    [
      'operator role',
      {
        authUser: {
          id: 8,
          email: 'operator@example.test',
          role: 'operator',
          plan: 'internal',
          profileId: null,
          source: 'session'
        }
      }
    ],
    [
      'owner role',
      {
        authUser: {
          id: 9,
          email: 'owner@example.test',
          role: 'owner',
          plan: 'internal',
          profileId: null,
          source: 'session'
        }
      }
    ]
  ])('preserves privileged %s access without token configuration', async (_label, authContext) => {
    delete process.env.ARCANOS_WORKER_HELPER_TOKEN;

    const response = await request(buildApp(authContext))
      .post('/worker-helper/queue/ask')
      .send({ prompt: 'Explain this stack trace.' });

    expect(response.status).toBe(202);
    expect(createJobMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid worker helper token and bearer token mutation requests', async () => {
    const invalidHeaderResponse = await request(buildApp())
      .post('/worker-helper/queue/ask')
      .set('x-arcanos-worker-helper-token', 'wrong-token')
      .send({ prompt: 'Explain this stack trace.' });
    const invalidBearerResponse = await request(buildApp())
      .post('/worker-helper/dispatch')
      .set('authorization', 'Bearer wrong-token')
      .send({ input: 'Run a direct worker check.' });

    expect(invalidHeaderResponse.status).toBe(401);
    expect(invalidBearerResponse.status).toBe(401);
    expect(createJobMock).not.toHaveBeenCalled();
    expect(dispatchArcanosTaskMock).not.toHaveBeenCalled();
  });

  it('allows valid bearer worker helper token mutation requests', async () => {
    const response = await request(buildApp())
      .post('/worker-helper/queue/ask')
      .set('authorization', `Bearer ${workerHelperToken}`)
      .send({ prompt: 'Explain this stack trace.' });

    expect(response.status).toBe(202);
    expect(createJobMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed before worker-helper queue persistence when job-read capability configuration is unavailable', async () => {
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const response = await withWorkerHelperToken(
      request(buildApp()).post('/worker-helper/queue/ask')
    ).send({ prompt: 'Explain this stack trace.' });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      error: 'JOB_READ_AUTH_UNAVAILABLE',
      message: 'Async job reads are temporarily unavailable.'
    });
    expect(createJobMock).not.toHaveBeenCalled();
    expect(detectCognitiveDomainMock).not.toHaveBeenCalled();
  });

  it('queues ask work with detected domain metadata', async () => {
    const response = await withWorkerHelperToken(request(buildApp())
      .post('/worker-helper/queue/ask')
    )
      .send({
        prompt: 'Explain this stack trace.',
        sessionId: 'session-42',
        clientContext: {
          routingDirectives: ['cli']
        }
      });

    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      ok: true,
      status: 'pending',
      jobId: 'job-123',
      poll: '/jobs/job-123/result',
      jobReadToken: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      jobReadTokenHeader: 'x-arcanos-job-read-token',
      endpoint: 'worker-helper',
      cognitiveDomain: 'code',
      cognitiveDomainSource: 'detected'
    });
    expect(createJobMock).toHaveBeenCalledWith(
      'worker-helper',
      'ask',
      expect.objectContaining({
        prompt: 'Explain this stack trace.',
        sessionId: 'session-42',
        cognitiveDomain: 'code',
        endpointName: 'worker-helper',
        clientContext: {
          routingDirectives: ['cli']
        }
      }),
      expect.objectContaining({
        maxRetries: 2,
        priority: 100
      })
    );
  });

  it('rejects preview chaos hooks outside Railway preview environments', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';

    const response = await withWorkerHelperToken(request(buildApp())
      .post('/worker-helper/queue/ask')
    )
      .send({
        prompt: 'Explain this stack trace.',
        previewChaosHook: {
          kind: 'reasoning_timeout_once',
          hookId: 'preview-chaos-test-hook',
          delayBeforeCallMs: 250,
          timeoutMs: 50
        }
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      error: 'PREVIEW_CHAOS_HOOK_UNAVAILABLE'
    }));
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('allows preview chaos hooks in Railway preview environments', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'Arcanos-pr-1283';

    const response = await withWorkerHelperToken(request(buildApp())
      .post('/worker-helper/queue/ask')
    )
      .send({
        prompt: 'Explain this stack trace.',
        previewChaosHook: {
          kind: 'reasoning_timeout_once',
          hookId: 'preview-chaos-test-hook',
          delayBeforeCallMs: 250,
          timeoutMs: 50
        }
      });

    expect(response.status).toBe(202);
    expect(createJobMock).toHaveBeenCalledWith(
      'worker-helper',
      'ask',
      expect.objectContaining({
        previewChaosHook: {
          kind: 'reasoning_timeout_once',
          hookId: 'preview-chaos-test-hook',
          delayBeforeCallMs: 250,
          timeoutMs: 50
        }
      }),
      expect.any(Object)
    );
  });

  it('authenticates before failed-job query parsing and retains operator detail', async () => {
    const jobUuidSentinel = '423e4567-e89b-42d3-a456-426614174000';
    const errorSentinel = 'AUTHENTICATED_FAILED_JOB_ERROR_SENTINEL';
    listFailedJobsMock.mockResolvedValueOnce([{
      id: jobUuidSentinel,
      worker_id: 'worker-helper',
      last_worker_id: 'async-queue-slot-1',
      job_type: 'ask',
      status: 'failed',
      error_message: errorSentinel,
      retry_count: 2,
      max_retries: 2,
      created_at: '2026-03-06T09:55:00.000Z',
      updated_at: '2026-03-06T09:58:00.000Z',
      completed_at: '2026-03-06T09:58:00.000Z'
    }]);

    const unauthenticated = await request(buildApp())
      .get('/worker-helper/jobs/failed?limit=not-a-number');

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['cache-control']).toContain('no-store');
    expect(unauthenticated.body.error).toBe('WORKER_HELPER_AUTH_REQUIRED');
    expect(listFailedJobsMock).not.toHaveBeenCalled();

    const response = await withWorkerHelperToken(
      request(buildApp()).get('/worker-helper/jobs/failed?limit=1')
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      failedCountMode: 'retained_terminal_jobs',
      jobs: [
        {
          id: jobUuidSentinel,
          worker_id: 'worker-helper',
          last_worker_id: 'async-queue-slot-1',
          job_type: 'ask',
          status: 'failed',
          error_message: errorSentinel,
          retry_count: 2,
          max_retries: 2,
          created_at: '2026-03-06T09:55:00.000Z',
          updated_at: '2026-03-06T09:58:00.000Z',
          completed_at: '2026-03-06T09:58:00.000Z'
        }
      ]
    });
    expect(listFailedJobsMock).toHaveBeenCalledWith(1);
  });

  it('requires helper auth for worker job detail routes', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-latest',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'completed',
      created_at: '2026-03-06T09:59:00.000Z',
      updated_at: '2026-03-06T10:00:00.000Z',
      completed_at: '2026-03-06T10:00:00.000Z',
      error_message: null,
      output: { result: 'ok' }
    });

    const unauthenticatedLatestResponse = await request(buildApp()).get('/worker-helper/jobs/latest');
    const unauthenticatedSpecificResponse = await request(buildApp()).get('/worker-helper/jobs/job-latest');
    const latestResponse = await withWorkerHelperToken(
      request(buildApp()).get('/worker-helper/jobs/latest')
    );
    const specificResponse = await withWorkerHelperToken(
      request(buildApp()).get('/worker-helper/jobs/job-latest')
    );

    expect(unauthenticatedLatestResponse.status).toBe(401);
    expect(unauthenticatedSpecificResponse.status).toBe(401);
    expect(latestResponse.status).toBe(200);
    expect(specificResponse.status).toBe(200);
    expect(latestResponse.body).toEqual(expect.objectContaining({ id: 'job-latest' }));
    expect(specificResponse.body).toEqual(expect.objectContaining({ id: 'job-latest' }));
  });

  it('omits known job, prompt, result, and error sentinels from public health', async () => {
    const jobUuidSentinel = '723e4567-e89b-42d3-a456-426614174000';
    const promptSentinel = 'WORKER_HELPER_HEALTH_PROMPT_SENTINEL';
    const resultSentinel = 'WORKER_HELPER_HEALTH_RESULT_SENTINEL';
    const errorSentinel = 'WORKER_HELPER_HEALTH_ERROR_SENTINEL';
    const healthSource = await getWorkerControlHealthMock();
    getWorkerControlHealthMock.mockResolvedValueOnce({
      ...healthSource,
      alerts: [promptSentinel, resultSentinel],
      workers: healthSource.workers.map((worker: Record<string, unknown> & {
        snapshot?: Record<string, unknown>;
      }) => ({
        ...worker,
        workerId: jobUuidSentinel,
        currentJobId: jobUuidSentinel,
        lastError: errorSentinel,
        snapshot: {
          ...worker.snapshot,
          activeJobs: [jobUuidSentinel],
          disabledReason: promptSentinel,
        },
      })),
    });
    listFailedJobsMock.mockResolvedValueOnce([{
      id: jobUuidSentinel,
      worker_id: 'worker-helper',
      last_worker_id: 'async-queue-slot-1',
      job_type: 'ask',
      status: 'failed',
      error_message: errorSentinel,
      retry_count: 2,
      max_retries: 2,
      created_at: '2026-03-06T09:55:00.000Z',
      updated_at: '2026-03-06T09:58:00.000Z',
      completed_at: '2026-03-06T09:58:00.000Z'
    }]);

    const response = await request(buildApp()).get('/worker-helper/health');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      status: 'healthy',
      overallStatus: 'healthy',
      workers: expect.objectContaining({
        status: 'healthy',
        active: 1,
        observed: 1,
        stale: 0,
        degraded: 0,
        unhealthy: 0,
        lastHeartbeatAt: '2026-03-06T10:00:00.000Z'
      }),
      queue: expect.objectContaining({
        status: 'active',
        total: 5,
        retainedFailed: 1
      })
    }));
    const serialized = JSON.stringify(response.body);
    for (const sentinel of [
      jobUuidSentinel,
      promptSentinel,
      resultSentinel,
      errorSentinel
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(collectObjectKeys(response.body)).toEqual(
      expect.not.arrayContaining([
        'latestJob',
        'recentFailedJobs',
        'activeJobs',
        'currentJobId',
        'lastError',
        'workerIds',
        'lastInputPreview',
        'lastResult',
        'workersDirectory'
      ])
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns idle historical debt without degrading the primary health payload', async () => {
    getWorkerControlHealthMock.mockResolvedValueOnce({
      overallStatus: 'healthy',
      alerts: ['Retry exhaustion is elevated (56 terminal failure(s)).'],
      queueSummary: {
        pending: 0,
        running: 0,
        completed: 3,
        failed: 56,
        total: 59,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        failureBreakdown: {
          retryable: 0,
          permanent: 56,
          retryScheduled: 0,
          retryExhausted: 56,
          authentication: 0,
          network: 0,
          provider: 0,
          rateLimited: 0,
          timeout: 56,
          validation: 0,
          unknown: 0
        },
        recentFailureReasons: [],
        recentTerminalWindowMs: 3600000,
        recentFailed: 0,
        lastUpdatedAt: '2026-03-06T10:00:00.000Z'
      },
      operationalHealth: {
        overallStatus: 'healthy',
        alerts: [],
        pending: 0,
        running: 0,
        delayed: 0,
        stalledRunning: 0,
        oldestPendingJobAgeMs: 0,
        recentFailed: 0,
        recentCompleted: 0,
        recentTotalTerminal: 0,
        recentTerminalWindowMs: 3600000,
        workerHeartbeatAgeMs: 300000,
        degradedWorkerIds: [],
        unhealthyWorkerIds: []
      },
      historicalDebt: {
        retainedFailedJobs: 56,
        retryExhaustedJobs: 56,
        deadLetterJobs: 0,
        recentFailureReasons: [],
        failureWindowMs: 3600000,
        inspectionEndpoint: '/worker-helper/jobs/failed',
        currentRiskExcluded: true
      },
      workers: [
        {
          workerId: 'async-queue',
          workerType: 'async_queue',
          healthStatus: 'degraded',
          operationalStatus: 'healthy',
          currentJobId: null,
          lastError: 'OpenAI upstream timeout',
          lastHeartbeatAt: null,
          updatedAt: '2026-03-06T10:00:00.000Z',
          snapshot: {
            lastActivityAt: '2026-03-06T09:55:00.000Z',
            lastProcessedJobAt: null
          }
        }
      ],
      settings: {
        heartbeatIntervalMs: 10000,
        leaseMs: 30000,
        inspectorIntervalMs: 30000,
        staleAfterMs: 60000,
        watchdogIdleMs: 120000,
        defaultMaxRetries: 2,
        maxJobsPerHour: 120,
        maxAiCallsPerHour: 120,
        maxRssMb: 2048
      }
    });

    const response = await request(buildApp()).get('/worker-helper/health');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      status: 'healthy',
      workers: expect.objectContaining({
        status: 'healthy',
        observed: 1,
        degraded: 1
      }),
      queue: expect.objectContaining({
        status: 'idle',
        total: 59,
        retainedFailed: 56
      })
    }));
    expect(JSON.stringify(response.body)).not.toContain('OpenAI upstream timeout');
    expect(JSON.stringify(response.body)).not.toContain('Retry exhaustion is elevated');
  });

  it('dispatches direct commands through the in-process worker runtime', async () => {
    const response = await withWorkerHelperToken(request(buildApp())
      .post('/worker-helper/dispatch')
    )
      .send({
        input: 'Run a direct worker check.',
        attempts: 2,
        backoffMs: 500
      });

    expect(response.status).toBe(200);
    expect(dispatchArcanosTaskMock).toHaveBeenCalledWith('Run a direct worker check.', {
      input: 'Run a direct worker check.',
      attempts: 2,
      backoffMs: 500
    });
    expect(response.body).toEqual(
      expect.objectContaining({
        mode: 'direct-dispatch',
        input: 'Run a direct worker check.',
        resultCount: 1,
        primaryResult: {
          workerId: 'arcanos-core-direct',
          result: 'ok'
        }
      })
    );
  });

  it('returns a bounded noop plan for worker-helper heal when mode=plan is requested', async () => {
    const response = await withWorkerHelperToken(request(buildApp()).post('/worker-helper/heal?mode=plan'));

    expect(response.status).toBe(200);
    expect(startWorkersMock).not.toHaveBeenCalled();
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'noop',
      source: 'worker-helper',
      actionTaken: 'worker-helper/heal',
      healedComponent: 'worker_runtime'
    }));
    expect(response.body).toEqual(expect.objectContaining({
      mode: 'plan',
      execution: null,
      requestedForce: true,
      runtime: expect.objectContaining({
        started: true,
        activeListeners: 2
      })
    }));
  });

  it('does not disclose dependency errors from authenticated worker healing', async () => {
    startWorkersMock.mockRejectedValueOnce(new Error('sentinel-worker-heal-secret'));

    const response = await withWorkerHelperToken(
      request(buildApp()).post('/worker-helper/heal')
    )
      .set('x-confirmed', 'yes')
      .send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'WORKER_HELPER_HEAL_FAILED',
      message: 'Worker heal request failed.'
    });
    expect(JSON.stringify(response.body)).not.toContain('sentinel-worker-heal-secret');
  });

  it('does not start in-process workers when execute heal is requested on a disabled runtime', async () => {
    startWorkersMock.mockResolvedValue({
      started: false,
      alreadyRunning: false,
      runWorkers: false,
      workerCount: 0,
      workerIds: [],
      model: 'gpt-5.1',
      message: 'RUN_WORKERS disabled for explicit web process role; workers not started.'
    });
    getWorkerRuntimeStatusMock.mockReturnValue({
      enabled: false,
      model: 'gpt-5.1',
      configuredCount: 2,
      started: false,
      activeListeners: 0,
      workerIds: [],
      totalDispatched: 5
    });

    const response = await withWorkerHelperToken(request(buildApp())
      .post('/worker-helper/heal')
    )
      .set('x-confirmed', 'yes')
      .send({});

    expect(response.status).toBe(200);
    expect(startWorkersMock).toHaveBeenCalledWith(true);
    expect(response.body).toEqual(expect.objectContaining({
      requestedForce: true,
      restart: expect.objectContaining({
        started: false,
        runWorkers: false,
        message: 'RUN_WORKERS disabled for explicit web process role; workers not started.'
      }),
      runtime: expect.objectContaining({
        enabled: false,
        started: false,
        activeListeners: 0
      })
    }));
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'attempt',
      source: 'worker-helper',
      actionTaken: 'healWorkerRuntime',
      healedComponent: 'worker_runtime'
    }));
    expect(recordSelfHealEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'noop',
      source: 'worker-helper',
      actionTaken: 'healWorkerRuntime:blocked',
      healedComponent: 'worker_runtime'
    }));
  });

  afterAll(() => {
    if (originalWorkerHelperToken === undefined) {
      delete process.env.ARCANOS_WORKER_HELPER_TOKEN;
    } else {
      process.env.ARCANOS_WORKER_HELPER_TOKEN = originalWorkerHelperToken;
    }
    if (originalJobReadSecret === undefined) {
      delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;
    } else {
      process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = originalJobReadSecret;
    }
  });
});
