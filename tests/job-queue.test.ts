import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';

const createJobMock = jest.fn();
const failPendingJobIfUnclaimedMock = jest.fn();
const getJobByIdMock = jest.fn();
const requestJobCancellationMock = jest.fn();
const updateClaimedJobTerminalMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const sleepMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  createClaimedJobFence: (workerId: string, claimGeneration: string) => ({
    workerId,
    claimGeneration
  }),
  createJob: createJobMock,
  failPendingJobIfUnclaimed: failPendingJobIfUnclaimedMock,
  getJobById: getJobByIdMock,
  requestJobCancellation: requestJobCancellationMock,
  updateClaimedJobTerminal: updateClaimedJobTerminalMock
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: planAutonomousWorkerJobMock
}));

jest.unstable_mockModule('@shared/sleep.js', () => ({
  sleep: sleepMock
}));

const { DatabaseBackedDagJobQueue } = await import('../src/jobs/jobQueue.js');
const { buildDagNodeJobInput } = await import('../src/jobs/jobSchema.js');
const { DEFAULT_DAG_NODE_TIMEOUT_MS } = await import('../src/workers/workerExecutionLimits.js');

function buildJobRow(overrides: Partial<JobData> = {}): JobData {
  return {
    id: overrides.id ?? 'job-1',
    worker_id: overrides.worker_id ?? 'dag-orchestrator',
    job_type: overrides.job_type ?? 'dag-node',
    status: overrides.status ?? 'running',
    claim_generation: overrides.claim_generation ?? '1',
    input:
      overrides.input ??
      {
        dagId: 'dag-1',
        node: {
          id: 'audit',
          type: 'agent',
          dependencies: [],
          executionKey: 'audit'
        },
        payload: {},
        dependencyResults: {},
        sharedState: {},
        depth: 0,
        attempt: 0,
        maxRetries: 2,
        waitingTimeoutMs: 5_000
      },
    output: overrides.output,
    error_message: overrides.error_message,
    retry_count: overrides.retry_count ?? 0,
    max_retries: overrides.max_retries ?? 2,
    next_run_at: overrides.next_run_at ?? new Date('2026-03-07T16:00:00.000Z'),
    started_at: overrides.started_at,
    last_heartbeat_at: overrides.last_heartbeat_at,
    lease_expires_at: overrides.lease_expires_at,
    cancel_requested_at: overrides.cancel_requested_at,
    cancel_reason: overrides.cancel_reason,
    priority: overrides.priority ?? 100,
    last_worker_id: Object.prototype.hasOwnProperty.call(overrides, 'last_worker_id')
      ? overrides.last_worker_id
      : 'async-queue-slot-1',
    autonomy_state: overrides.autonomy_state ?? {},
    created_at: overrides.created_at ?? new Date('2026-03-07T16:00:00.000Z'),
    updated_at: overrides.updated_at ?? new Date('2026-03-07T16:00:00.000Z'),
    completed_at: overrides.completed_at
  } as JobData;
}

describe('DatabaseBackedDagJobQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the shared DAG node timeout fallback when a queued payload omits waitingTimeoutMs', () => {
    const jobInput = buildDagNodeJobInput({
      dagId: 'dag-1',
      node: {
        id: 'audit',
        type: 'agent',
        dependencies: [],
        executionKey: 'audit',
        execute: async () => {
          throw new Error('not used');
        }
      },
      depth: 0
    });

    expect(jobInput.waitingTimeoutMs).toBe(DEFAULT_DAG_NODE_TIMEOUT_MS);
  });

  it('enqueues DAG node jobs through the shared job table with a schema-safe payload', async () => {
    const queue = new DatabaseBackedDagJobQueue('dag-orchestrator-test');
    planAutonomousWorkerJobMock.mockResolvedValue({
      status: 'pending',
      retryCount: 1,
      maxRetries: 3,
      priority: 42,
      autonomyState: {
        planner: {
          reasons: ['test-plan']
        }
      },
      planningReasons: ['test-plan']
    });
    createJobMock.mockImplementation(async (workerId, jobType, input, createOptions) => ({
      ...buildJobRow({
        id: 'job-created-dag-node',
        worker_id: workerId,
        job_type: jobType,
        status: 'pending',
        input,
        retry_count: input.attempt,
        max_retries: input.maxRetries,
        priority: createOptions.priority,
        created_at: new Date('2026-03-07T16:00:00.000Z'),
        updated_at: new Date('2026-03-07T16:00:00.000Z')
      }),
      last_worker_id: null
    }));

    const record = await queue.enqueueDagNodeJob({
      dagId: 'dag-create-1',
      node: {
        id: 'planner',
        type: 'agent',
        dependencies: [],
        executionKey: 'planner',
        metadata: {
          role: 'plan'
        },
        execute: async () => {
          throw new Error('not used by queue creation');
        }
      },
      payload: {
        goal: 'Plan the Trinity DAG execution.'
      },
      sharedState: {
        sessionId: 'session-1'
      },
      depth: 0,
      attempt: 1,
      maxRetries: 3,
      waitingTimeoutMs: 90_000,
      workerId: 'dag-worker-1'
    });

    expect(planAutonomousWorkerJobMock).toHaveBeenCalledWith(
      'dag-node',
      expect.objectContaining({
        dagId: 'dag-create-1',
        node: expect.objectContaining({
          id: 'planner',
          executionKey: 'planner'
        }),
        payload: {
          goal: 'Plan the Trinity DAG execution.'
        },
        sharedState: {
          sessionId: 'session-1'
        },
        attempt: 1,
        maxRetries: 3,
        waitingTimeoutMs: 90_000
      }),
      { maxRetries: 0 }
    );
    const persistedInput = createJobMock.mock.calls[0]?.[2];
    expect(persistedInput.node).not.toHaveProperty('execute');
    expect(createJobMock).toHaveBeenCalledWith(
      'dag-worker-1',
      'dag-node',
      persistedInput,
      expect.objectContaining({
        maxRetries: 0,
        priority: 42,
        planningReasons: ['test-plan']
      })
    );
    expect(record).toMatchObject({
      jobId: 'job-created-dag-node',
      dagId: 'dag-create-1',
      nodeId: 'planner',
      status: 'queued',
      workerId: 'dag-worker-1',
      retries: 1,
      maxRetries: 3,
      waitingTimeoutMs: 90_000,
      payload: {
        goal: 'Plan the Trinity DAG execution.'
      },
      sharedState: {
        sessionId: 'session-1'
      }
    });
  });

  it('times out queued jobs using queue wait plus claim grace instead of immediate wall-clock failure', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const createdAt = new Date(
      Date.now() - DEFAULT_DAG_NODE_TIMEOUT_MS - 121_000
    );
    const failedJob = buildJobRow({
      status: 'failed',
      claim_generation: '0',
      created_at: createdAt,
      updated_at: new Date(),
      error_message:
        'Timed out waiting 541000ms for DAG node claim (execution limit 420000ms, queue grace 120000ms).'
    });

    getJobByIdMock.mockResolvedValue(
      buildJobRow({
        status: 'pending',
        claim_generation: '0',
        last_worker_id: null,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: undefined,
        last_heartbeat_at: undefined,
        input: {
          dagId: 'dag-1',
          node: {
            id: 'audit',
            type: 'agent',
            dependencies: [],
            executionKey: 'audit'
          },
          payload: {},
          dependencyResults: {},
          sharedState: {},
          depth: 0,
          attempt: 0,
          maxRetries: 2,
          waitingTimeoutMs: DEFAULT_DAG_NODE_TIMEOUT_MS
        }
      })
    );
    failPendingJobIfUnclaimedMock.mockResolvedValue(failedJob);

    const record = await queue.waitForDagJobCompletion('job-1');

    expect(failPendingJobIfUnclaimedMock).toHaveBeenCalledWith(
      'job-1',
      {
        claimGeneration: '0',
        output: null,
        errorMessage: expect.stringContaining('queue grace 120000ms')
      }
    );
    expect(record.status).toBe('failed');
  });

  it('does not fail a job claimed concurrently with a pending-timeout CAS', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const createdAt = new Date(Date.now() - 126_000);
    getJobByIdMock
      .mockResolvedValueOnce(buildJobRow({
        status: 'pending',
        claim_generation: '0',
        last_worker_id: null,
        created_at: createdAt,
        updated_at: createdAt
      }))
      .mockResolvedValueOnce(buildJobRow({
        status: 'running',
        claim_generation: '1',
        last_worker_id: 'worker-new',
        created_at: createdAt,
        started_at: new Date(),
        updated_at: new Date()
      }))
      .mockResolvedValueOnce(buildJobRow({
        status: 'completed',
        claim_generation: '1',
        last_worker_id: 'worker-new',
        created_at: createdAt,
        completed_at: new Date(),
        updated_at: new Date()
      }));
    failPendingJobIfUnclaimedMock.mockResolvedValueOnce(null);

    const record = await queue.waitForDagJobCompletion('job-1', {
      pollIntervalMs: 1,
      timeoutMs: 5_000
    });

    expect(failPendingJobIfUnclaimedMock).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ claimGeneration: '0' })
    );
    expect(updateClaimedJobTerminalMock).not.toHaveBeenCalled();
    expect(record.status).toBe('completed');
  });

  it('times out a running job only through its exact observed claim fence', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const startedAt = new Date(Date.now() - 6_000);
    const runningJob = buildJobRow({
      status: 'running',
      claim_generation: '3',
      last_worker_id: 'worker-a',
      started_at: startedAt,
      last_heartbeat_at: startedAt,
      lease_expires_at: new Date(Date.now() + 30_000),
      updated_at: startedAt
    });
    const failedJob = buildJobRow({
      ...runningJob,
      status: 'failed',
      error_message: 'timed out',
      completed_at: new Date(),
      lease_expires_at: undefined
    });
    getJobByIdMock.mockResolvedValueOnce(runningJob);
    updateClaimedJobTerminalMock.mockResolvedValueOnce(failedJob);

    const record = await queue.waitForDagJobCompletion('job-1', {
      timeoutMs: 5_000
    });

    expect(updateClaimedJobTerminalMock).toHaveBeenCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({
        fence: {
          workerId: 'worker-a',
          claimGeneration: '3'
        },
        output: null,
        errorMessage: expect.stringContaining('DAG node execution')
      })
    );
    expect(record.status).toBe('failed');
  });

  it('does not fail a newer owner after a running-timeout fence miss', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const createdAt = new Date(Date.now() - 30_000);
    const oldStartedAt = new Date(Date.now() - 6_000);
    getJobByIdMock
      .mockResolvedValueOnce(buildJobRow({
        status: 'running',
        claim_generation: '3',
        last_worker_id: 'worker-a',
        created_at: createdAt,
        started_at: oldStartedAt,
        last_heartbeat_at: oldStartedAt,
        lease_expires_at: new Date(Date.now() + 30_000),
        updated_at: oldStartedAt
      }))
      .mockResolvedValueOnce(buildJobRow({
        status: 'running',
        claim_generation: '4',
        last_worker_id: 'worker-b',
        created_at: createdAt,
        started_at: new Date(),
        last_heartbeat_at: new Date(),
        lease_expires_at: new Date(Date.now() + 30_000),
        updated_at: new Date()
      }))
      .mockResolvedValueOnce(buildJobRow({
        status: 'completed',
        claim_generation: '4',
        last_worker_id: 'worker-b',
        created_at: createdAt,
        completed_at: new Date(),
        updated_at: new Date()
      }));
    updateClaimedJobTerminalMock.mockResolvedValueOnce(null);

    const record = await queue.waitForDagJobCompletion('job-1', {
      pollIntervalMs: 1,
      timeoutMs: 5_000
    });

    expect(updateClaimedJobTerminalMock).toHaveBeenCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({
        fence: {
          workerId: 'worker-a',
          claimGeneration: '3'
        }
      })
    );
    expect(record.status).toBe('completed');
  });

  it('measures running-job timeout from startedAt instead of queuedAt', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const queuedAt = new Date(Date.now() - 15 * 60_000);
    const startedAt = new Date();
    const completedAt = new Date(startedAt.getTime() + 1_000);

    getJobByIdMock
      .mockResolvedValueOnce(
        buildJobRow({
          status: 'running',
          created_at: queuedAt,
          updated_at: startedAt,
          started_at: startedAt,
          last_heartbeat_at: startedAt,
          input: {
            dagId: 'dag-1',
            node: {
              id: 'audit',
              type: 'agent',
              dependencies: [],
              executionKey: 'audit'
            },
            payload: {},
            dependencyResults: {},
            sharedState: {},
            depth: 0,
            attempt: 0,
            maxRetries: 2,
            waitingTimeoutMs: 5_000
          }
        })
      )
      .mockResolvedValueOnce(
        buildJobRow({
          status: 'completed',
          created_at: queuedAt,
          updated_at: completedAt,
          started_at: startedAt,
          last_heartbeat_at: startedAt,
          completed_at: completedAt,
          output: {
            nodeId: 'audit',
            status: 'success',
            output: { ok: true },
            metrics: {}
          },
          input: {
            dagId: 'dag-1',
            node: {
              id: 'audit',
              type: 'agent',
              dependencies: [],
              executionKey: 'audit'
            },
            payload: {},
            dependencyResults: {},
            sharedState: {},
            depth: 0,
            attempt: 0,
            maxRetries: 2,
            waitingTimeoutMs: 5_000
          }
        })
      );

    const record = await queue.waitForDagJobCompletion('job-1', {
      pollIntervalMs: 1,
      timeoutMs: 5_000
    });

    expect(updateClaimedJobTerminalMock).not.toHaveBeenCalled();
    expect(record.status).toBe('completed');
    expect(sleepMock).toHaveBeenCalled();
  });

  it('treats cancelled jobs as first-class terminal queue records without timeout mutation', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const cancelledAt = new Date('2026-07-27T12:00:01.000Z');
    getJobByIdMock.mockResolvedValueOnce(buildJobRow({
      status: 'cancelled',
      error_message: 'DAG run cancellation requested.',
      cancel_requested_at: cancelledAt,
      cancel_reason: 'DAG run cancellation requested.',
      completed_at: cancelledAt,
      updated_at: cancelledAt
    }));

    const record = await queue.waitForDagJobCompletion('job-1');

    expect(record.status).toBe('cancelled');
    expect(record.errorMessage).toBe('DAG run cancellation requested.');
    expect(record.timestamps.completedAt).toBe(cancelledAt.toISOString());
    expect(getJobByIdMock).toHaveBeenCalledTimes(1);
    expect(failPendingJobIfUnclaimedMock).not.toHaveBeenCalled();
    expect(updateClaimedJobTerminalMock).not.toHaveBeenCalled();
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('normalizes immediate pending-job cancellation through requestDagJobCancellation', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const cancelledAt = new Date('2026-07-27T12:00:01.000Z');
    requestJobCancellationMock.mockResolvedValueOnce({
      outcome: 'cancelled',
      job: buildJobRow({
        status: 'cancelled',
        last_worker_id: null,
        error_message: 'Cancelled before claim.',
        cancel_requested_at: cancelledAt,
        cancel_reason: 'Cancelled before claim.',
        completed_at: cancelledAt,
        updated_at: cancelledAt
      })
    });

    const result = await queue.requestDagJobCancellation(
      'job-1',
      'Cancelled before claim.'
    );

    expect(requestJobCancellationMock).toHaveBeenCalledWith(
      'job-1',
      'Cancelled before claim.'
    );
    expect(result.outcome).toBe('cancelled');
    expect(result.record).toMatchObject({
      jobId: 'job-1',
      status: 'cancelled',
      errorMessage: 'Cancelled before claim.'
    });
  });

  it('preserves running state when requestDagJobCancellation only records a cancellation request', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const requestedAt = new Date('2026-07-27T12:00:01.000Z');
    requestJobCancellationMock.mockResolvedValueOnce({
      outcome: 'cancellation_requested',
      job: buildJobRow({
        status: 'running',
        cancel_requested_at: requestedAt,
        cancel_reason: 'Cancel the active node.',
        updated_at: requestedAt
      })
    });

    const result = await queue.requestDagJobCancellation(
      'job-1',
      'Cancel the active node.'
    );

    expect(requestJobCancellationMock).toHaveBeenCalledWith(
      'job-1',
      'Cancel the active node.'
    );
    expect(result.outcome).toBe('cancellation_requested');
    expect(result.record).toMatchObject({
      jobId: 'job-1',
      status: 'running'
    });
  });

  it('keeps polling a cancellation-requested running row until the database reports cancelled', async () => {
    const queue = new DatabaseBackedDagJobQueue();
    const requestedAt = new Date();
    const cancelledAt = new Date(requestedAt.getTime() + 1_000);
    const observedStatuses: string[] = [];
    getJobByIdMock
      .mockResolvedValueOnce(buildJobRow({
        status: 'running',
        started_at: requestedAt,
        last_heartbeat_at: requestedAt,
        lease_expires_at: new Date(requestedAt.getTime() + 30_000),
        cancel_requested_at: requestedAt,
        cancel_reason: 'Cancel the active node.',
        updated_at: requestedAt
      }))
      .mockResolvedValueOnce(buildJobRow({
        status: 'cancelled',
        started_at: requestedAt,
        cancel_requested_at: requestedAt,
        cancel_reason: 'Cancel the active node.',
        error_message: 'Cancel the active node.',
        completed_at: cancelledAt,
        updated_at: cancelledAt
      }));

    const record = await queue.waitForDagJobCompletion('job-1', {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      onStatusChange: statusRecord => {
        observedStatuses.push(statusRecord.status);
      }
    });

    expect(record.status).toBe('cancelled');
    expect(observedStatuses).toEqual(['running', 'cancelled']);
    expect(getJobByIdMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(failPendingJobIfUnclaimedMock).not.toHaveBeenCalled();
    expect(updateClaimedJobTerminalMock).not.toHaveBeenCalled();
  });
});
