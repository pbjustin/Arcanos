import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';

const createJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const updateJobMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const sleepMock = jest.fn(async () => undefined);

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock,
  getJobById: getJobByIdMock,
  updateJob: updateJobMock
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
    priority: overrides.priority ?? 100,
    last_worker_id: overrides.last_worker_id ?? 'async-queue-slot-1',
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
      { maxRetries: 3 }
    );
    const persistedInput = createJobMock.mock.calls[0]?.[2];
    expect(persistedInput.node).not.toHaveProperty('execute');
    expect(createJobMock).toHaveBeenCalledWith(
      'dag-worker-1',
      'dag-node',
      persistedInput,
      expect.objectContaining({
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
      created_at: createdAt,
      updated_at: new Date(),
      error_message:
        'Timed out waiting 541000ms for DAG node claim (execution limit 420000ms, queue grace 120000ms).'
    });

    getJobByIdMock.mockResolvedValue(
      buildJobRow({
        status: 'pending',
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
    updateJobMock.mockResolvedValue(failedJob);

    const record = await queue.waitForDagJobCompletion('job-1');

    expect(updateJobMock).toHaveBeenCalledWith(
      'job-1',
      'failed',
      null,
      expect.stringContaining('queue grace 120000ms')
    );
    expect(record.status).toBe('failed');
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

    expect(updateJobMock).not.toHaveBeenCalled();
    expect(record.status).toBe('completed');
    expect(sleepMock).toHaveBeenCalled();
  });
});
