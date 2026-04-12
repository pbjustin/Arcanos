import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/', workerHelperRouter);
  return app;
}

describe('/worker-helper routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-06T10:00:30.000Z'));
    delete process.env.WORKER_ID;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;

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

  it('returns combined status without helper auth', async () => {
    const response = await request(buildApp()).get('/worker-helper/status');

    expect(response.status).toBe(200);
    expect(response.body.mainApp.runtime).toEqual(
      expect.objectContaining({
        started: true,
        activeListeners: 2
      })
    );
  });

  it('returns combined status with queue visibility', async () => {
    const response = await request(buildApp()).get('/worker-helper/status');

    expect(response.status).toBe(200);
    expect(response.body.mainApp).toEqual({
      connected: true,
      workerId: 'worker-helper',
      runtime: expect.objectContaining({
        enabled: true,
        workerIds: ['worker-1', 'worker-2']
      })
    });
    expect(response.body.workerService).toEqual(expect.objectContaining({
      observationMode: 'queue-observed',
      database: {
        connected: true,
        hasPool: true,
        error: null
      },
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
        lastUpdatedAt: '2026-03-06T10:00:00.000Z'
      },
      queueSemantics: {
        failedCountMode: 'retained_terminal_jobs',
        failedCountDescription:
          'The failed counter represents job rows currently retained in terminal failed state. It is not a count of currently running failures.',
        activeFailureSignals: ['stalledRunning', 'oldestPendingJobAgeMs', 'recentFailed', 'workerHeartbeatAgeMs']
      },
      retryPolicy: {
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2000,
        retryBackoffMaxMs: 60000,
        staleAfterMs: 60000,
        watchdogIdleMs: 120000
      },
      recentFailedJobs: [
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
      ],
      latestJob: {
        id: 'job-latest',
        worker_id: 'worker-helper',
        job_type: 'ask',
        status: 'completed',
        created_at: '2026-03-06T09:59:00.000Z',
        updated_at: '2026-03-06T10:00:00.000Z',
        completed_at: '2026-03-06T10:00:00.000Z',
        error_message: null
      },
      health: {
        overallStatus: 'healthy',
        alerts: [],
        diagnosticAlerts: [],
        operationalHealth: {
          overallStatus: 'healthy',
          alerts: [],
          pending: 1,
          running: 0,
          delayed: 0,
          stalledRunning: 0,
          staleWorkers: 0,
          staleWorkerIds: [],
          stalledJobs: 0,
          recoveryActions: 0,
          oldestPendingJobAgeMs: 0,
          recentFailed: 0,
          recentCompleted: 0,
          recentTotalTerminal: 0,
          recentTerminalWindowMs: 3600000,
          workerHeartbeatAgeMs: expect.any(Number),
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
            activeJobs: [],
            currentJobId: null,
            lastError: null,
            lastHeartbeatAt: '2026-03-06T10:00:00.000Z',
            lastActivityAt: '2026-03-06T10:00:00.000Z',
            lastProcessedJobAt: '2026-03-06T09:59:30.000Z',
            heartbeatAgeMs: expect.any(Number),
            stale: false,
            inactivityMs: expect.any(Number),
            processedJobs: 0,
            scheduledRetries: 0,
            terminalFailures: 0,
            recoveredJobs: 0,
            staleWorkersDetected: 0,
            stalledJobsDetected: 0,
            deadLetterJobs: 0,
            recoveryActions: 0,
            lastRecoveryActionAt: null,
            lastWatchdogRunAt: null,
            updatedAt: '2026-03-06T10:00:00.000Z',
            watchdog: {
              triggered: false,
              reason: null,
              restartRecommended: false,
              idleThresholdMs: 120000
            }
          }
        ]
      }
    }));
  });

  it('ignores legacy auth headers and still serves worker helper requests', async () => {
    const response = await request(buildApp())
      .get('/worker-helper/status')
      .set('Authorization', 'Bearer test-helper-key');

    expect(response.status).toBe(200);
    expect(response.body.mainApp.runtime).toEqual(
      expect.objectContaining({
        started: true,
        activeListeners: 2
      })
    );
  });

  it('queues ask work with detected domain metadata', async () => {
    const response = await request(buildApp())
      .post('/worker-helper/queue/ask')
      .send({
        prompt: 'Explain this stack trace.',
        sessionId: 'session-42',
        clientContext: {
          routingDirectives: ['cli']
        }
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      status: 'pending',
      jobId: 'job-123',
      poll: '/jobs/job-123',
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

    const response = await request(buildApp())
      .post('/worker-helper/queue/ask')
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

    const response = await request(buildApp())
      .post('/worker-helper/queue/ask')
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

  it('lists recently retained failed jobs without helper auth', async () => {
    const response = await request(buildApp()).get('/worker-helper/jobs/failed?limit=1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      failedCountMode: 'retained_terminal_jobs',
      jobs: [
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
      ]
    });
    expect(listFailedJobsMock).toHaveBeenCalledWith(1);
  });

  it('returns autonomous worker health', async () => {
    const response = await request(buildApp()).get('/worker-helper/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      overallStatus: 'healthy',
      alerts: [],
      operationalHealth: expect.objectContaining({
        overallStatus: 'healthy',
        staleWorkers: 0,
        stalledJobs: 0,
        recoveryActions: 0
      }),
      historicalDebt: expect.objectContaining({
        retainedFailedJobs: 1,
        retryExhaustedJobs: 1
      }),
      workers: [
        expect.objectContaining({
          workerId: 'async-queue',
          healthStatus: 'healthy',
          operationalStatus: 'healthy',
          activeJobs: [],
          stale: false,
          heartbeatAgeMs: expect.any(Number)
        })
      ]
    }));
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
    expect(response.body).toEqual(expect.objectContaining({
      overallStatus: 'healthy',
      alerts: [],
      diagnosticAlerts: ['Retry exhaustion is elevated (56 terminal failure(s)).'],
      operationalHealth: expect.objectContaining({
        overallStatus: 'healthy',
        workerHeartbeatAgeMs: expect.any(Number)
      }),
      historicalDebt: expect.objectContaining({
        retainedFailedJobs: 56,
        retryExhaustedJobs: 56
      }),
      workers: expect.arrayContaining([
        expect.objectContaining({
          workerId: 'async-queue',
          healthStatus: 'degraded',
          operationalStatus: 'healthy',
          inactivityMs: expect.any(Number)
        })
      ])
    }));
  });

  it('dispatches direct commands through the in-process worker runtime', async () => {
    const response = await request(buildApp())
      .post('/worker-helper/dispatch')
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
    const response = await request(buildApp()).post('/worker-helper/heal?mode=plan');

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

    const response = await request(buildApp())
      .post('/worker-helper/heal')
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
});
