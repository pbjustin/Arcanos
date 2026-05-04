import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetWorkerControlStatus = jest.fn();
const mockGetSnapshot = jest.fn();

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: mockGetWorkerControlStatus
}));

jest.unstable_mockModule('../src/services/routeMemorySnapshotStore.js', () => ({
  routeMemorySnapshotStore: {
    getSnapshot: mockGetSnapshot
  }
}));

const { getTrinityStatus } = await import('../src/services/trinityStatusService.js');

describe('getTrinityStatus', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WORKER_MODE = 'async_queue';
    process.env.MEMORY_CONTAINER = 'trinity';
    process.env.TRINITY_SESSION = 'active';
    process.env.DATABASE_URL = 'postgres://example.invalid/trinity';
    process.env.WORKER_API_TIMEOUT_MS = '180000';
    process.env.WORKER_TRINITY_RUNTIME_BUDGET_MS = '420000';
    process.env.WORKER_TRINITY_STAGE_TIMEOUT_MS = '180000';
    process.env.DAG_MAX_TOKEN_BUDGET = '250000';
    process.env.DAG_NODE_TIMEOUT_MS = '420000';
    process.env.DAG_QUEUE_CLAIM_GRACE_MS = '120000';
    process.env.TRINITY_SESSION_TOKEN_LIMIT = '250000';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a healthy Trinity status payload when workers and memory sync are live', async () => {
    mockGetWorkerControlStatus.mockResolvedValue({
      timestamp: '2026-03-07T20:00:00.000Z',
      mainApp: {
        connected: true,
        workerId: 'main-worker',
        runtime: {
          enabled: true,
          model: 'gpt-5.1',
          configuredCount: 3,
          started: true,
          activeListeners: 3,
          workerIds: ['main-worker-1', 'main-worker-2', 'main-worker-3'],
          totalDispatched: 42,
          lastDispatchAt: '2026-03-07T20:00:05.000Z'
        }
      },
      workerService: {
        observationMode: 'queue-observed',
        database: {
          connected: true
        },
        queueSummary: {
          pending: 2,
          running: 1,
          completed: 8,
          failed: 3,
          delayed: 1,
          stalledRunning: 0,
          lastUpdatedAt: '2026-03-07T20:00:08.000Z'
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
          staleAfterMs: 60000
        },
        recentFailedJobs: [
          {
            id: 'job-failed-1',
            worker_id: 'worker-helper',
            last_worker_id: 'async-queue-slot-2',
            job_type: 'ask',
            status: 'failed',
            error_message: 'OpenAI upstream timeout',
            retry_count: 2,
            max_retries: 2,
            created_at: '2026-03-07T19:55:00.000Z',
            updated_at: '2026-03-07T19:58:00.000Z',
            completed_at: '2026-03-07T19:58:00.000Z'
          }
        ],
        latestJob: {
          id: 'job-1',
          worker_id: 'async-queue-slot-2',
          job_type: 'ask',
          status: 'completed',
          created_at: '2026-03-07T19:59:59.000Z',
          updated_at: '2026-03-07T20:00:06.000Z',
          completed_at: '2026-03-07T20:00:06.000Z',
          error_message: null
        },
        health: {
          overallStatus: 'healthy',
          alerts: [],
          workers: [
            {
              workerId: 'async-queue-slot-1',
              workerType: 'async_queue',
              healthStatus: 'healthy',
              currentJobId: null,
              lastError: null,
              lastHeartbeatAt: '2026-03-07T20:00:04.000Z',
              updatedAt: '2026-03-07T20:00:04.000Z'
            },
            {
              workerId: 'async-queue-slot-2',
              workerType: 'async_queue',
              healthStatus: 'healthy',
              currentJobId: 'job-1',
              lastError: null,
              lastHeartbeatAt: '2026-03-07T20:00:07.000Z',
              updatedAt: '2026-03-07T20:00:07.000Z'
            }
          ]
        }
      }
    });
    mockGetSnapshot.mockResolvedValue({
      memoryVersion: '2026-03-07T20:00:01.000Z',
      loadedFrom: 'db',
      snapshot: {
        updated_at: '2026-03-07T20:00:01.000Z',
        bindings_version: 'dispatch-v9',
        trusted_snapshot_id: 'trusted-snapshot-1',
        route_state: {
          ask: {
            expected_route: 'ask',
            last_validated_at: '2026-03-07T20:00:01.000Z',
            hard_conflict: false
          }
        }
      }
    });

    const status = await getTrinityStatus();

    expect(status).toEqual(
      expect.objectContaining({
        pipeline: 'trinity',
        version: '1.0',
        status: 'healthy',
        workersConnected: true,
        lastDispatch: '2026-03-07T20:00:06.000Z',
        lastWorkerHeartbeat: '2026-03-07T20:00:07.000Z',
        workerHealth: expect.objectContaining({
          overallStatus: 'healthy',
          observedWorkerIds: ['async-queue-slot-1', 'async-queue-slot-2'],
          queueDepth: 3
        }),
        bindings: {
          workerMode: 'async_queue',
          memoryContainer: 'trinity',
          trinitySession: 'active',
          databaseConfigured: true
        }
      })
    );
    expect(status.memorySync).toEqual({
      status: 'active',
      memoryVersion: '2026-03-07T20:00:01.000Z',
      lastUpdatedAt: '2026-03-07T20:00:01.000Z',
      loadedFrom: 'db',
      bindingsVersion: 'dispatch-v9',
      trustedSnapshotId: 'trusted-snapshot-1',
      routeCount: 1
    });
    expect(status.queue).toEqual({
      idle: false,
      pendingJobs: 2,
      runningJobs: 1,
      completedJobs: 8,
      retainedFailedJobs: 3,
      delayedJobs: 1,
      stalledRunningJobs: 0,
      lastUpdatedAt: '2026-03-07T20:00:08.000Z',
        semantics: {
          failedCountMode: 'retained_terminal_jobs',
          failedCountDescription:
            'The failed counter represents job rows currently retained in terminal failed state. It is not a count of currently running failures.',
          activeFailureSignals: ['stalledRunning', 'oldestPendingJobAgeMs', 'recentFailed', 'workerHeartbeatAgeMs']
        },
      retryPolicy: {
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2000,
        retryBackoffMaxMs: 60000,
        staleAfterMs: 60000
      },
      recentFailedJobs: [
        {
          id: 'job-failed-1',
          worker_id: 'worker-helper',
          last_worker_id: 'async-queue-slot-2',
          job_type: 'ask',
          status: 'failed',
          error_message: 'OpenAI upstream timeout',
          retry_count: 2,
          max_retries: 2,
          created_at: '2026-03-07T19:55:00.000Z',
          updated_at: '2026-03-07T19:58:00.000Z',
          completed_at: '2026-03-07T19:58:00.000Z'
        }
      ]
    });
    expect(status.limits).toEqual({
      workerApiTimeoutMs: 180000,
      workerTrinityRuntimeBudgetMs: 420000,
      workerTrinityStageTimeoutMs: 180000,
      dagMaxTokenBudget: 250000,
      dagNodeTimeoutMs: 420000,
      dagQueueClaimGraceMs: 120000,
      sessionTokenLimit: 250000
    });
    expect(status.telemetry.failedJobInspectionEndpoint).toBe('/worker-helper/jobs/failed');
  });

  it('degrades to offline memory status when the snapshot store is unavailable', async () => {
    mockGetWorkerControlStatus.mockResolvedValue({
      timestamp: '2026-03-07T20:00:00.000Z',
      mainApp: {
        connected: true,
        workerId: 'main-worker',
        runtime: {
          enabled: false,
          model: 'gpt-5.1',
          configuredCount: 0,
          started: false,
          activeListeners: 0,
          workerIds: [],
          totalDispatched: 0
        }
      },
      workerService: {
        observationMode: 'queue-observed',
        database: {
          connected: false
        },
        queueSummary: null,
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
          staleAfterMs: 60000
        },
        recentFailedJobs: [],
        latestJob: null,
        health: {
          overallStatus: 'offline',
          alerts: ['worker runtime unavailable'],
          workers: []
        }
      }
    });
    mockGetSnapshot.mockRejectedValue(new Error('snapshot unavailable'));

    const status = await getTrinityStatus();

    expect(status.status).toBe('offline');
    expect(status.workersConnected).toBe(false);
    expect(status.lastDispatch).toBeNull();
    expect(status.lastWorkerHeartbeat).toBeNull();
    expect(status.memorySync).toEqual({
      status: 'offline',
      memoryVersion: null,
      lastUpdatedAt: null,
      loadedFrom: null,
      bindingsVersion: null,
      trustedSnapshotId: null,
      routeCount: 0
    });
    expect(status.queue).toEqual({
      idle: true,
      pendingJobs: 0,
      runningJobs: 0,
      completedJobs: 0,
      retainedFailedJobs: 0,
      delayedJobs: 0,
      stalledRunningJobs: 0,
      lastUpdatedAt: null,
        semantics: {
          failedCountMode: 'retained_terminal_jobs',
          failedCountDescription:
            'The failed counter represents job rows currently retained in terminal failed state. It is not a count of currently running failures.',
          activeFailureSignals: ['stalledRunning', 'oldestPendingJobAgeMs', 'recentFailed', 'workerHeartbeatAgeMs']
        },
      retryPolicy: {
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2000,
        retryBackoffMaxMs: 60000,
        staleAfterMs: 60000
      },
      recentFailedJobs: []
    });
    expect(status.limits).toEqual({
      workerApiTimeoutMs: 180000,
      workerTrinityRuntimeBudgetMs: 420000,
      workerTrinityStageTimeoutMs: 180000,
      dagMaxTokenBudget: 250000,
      dagNodeTimeoutMs: 420000,
      dagQueueClaimGraceMs: 120000,
      sessionTokenLimit: 250000
    });
  });

  it('uses the shared stale-worker default when worker-control telemetry is unavailable', async () => {
    delete process.env.JOB_WORKER_STALE_AFTER_MS;
    mockGetWorkerControlStatus.mockRejectedValue(new Error('worker-control unavailable'));
    mockGetSnapshot.mockRejectedValue(new Error('snapshot unavailable'));

    const status = await getTrinityStatus();

    expect(status.status).toBe('offline');
    expect(status.queue.retryPolicy).toEqual(
      expect.objectContaining({
        defaultMaxRetries: 2,
        retryBackoffBaseMs: 2000,
        retryBackoffMaxMs: 60000,
        staleAfterMs: 45_000,
        watchdogIdleMs: 120_000
      })
    );
  });
});
