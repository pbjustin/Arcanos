import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { access, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DAGNodeExecutionContext, DAGResult } from '../../src/dag/dagNode.js';
import type { DagMetricsRecorder } from '../../src/utils/metrics.js';

const queryMock = jest.fn();
const claimNextMock = jest.fn();
const initializeDatabaseMock = jest.fn();
const initializeDatabaseWithSchemaMock = jest.fn();
const configureBackendOpenAIClientMock = jest.fn();
const providerCallMock = jest.fn(async () => {
  throw new Error('DAG metrics fixture must not call a provider.');
});
const runWorkerTrinityPromptMock = jest.fn(async () => {
  throw new Error('DAG metrics fixture must not execute a provider prompt.');
});
const routeGptRequestMock = jest.fn(async () => {
  throw new Error('DAG metrics fixture must not dispatch a GPT request.');
});
const fakeOpenAIClient = { responses: { create: providerCallMock } };
const getOpenAIAdapterMock = jest.fn(() => ({ getClient: () => fakeOpenAIClient }));
const providerRuntime = {
  configVersion: 'dag-metrics-provider-fixture',
  nextRetryAt: null,
  lastFailureAt: null,
  lastFailureCategory: null,
  consecutiveFailures: 0
};
const probeOpenAIProviderHealthMock = jest.fn(async () => ({
  ok: true,
  runtime: providerRuntime
}));
const stopAfterFixtureJobs = new Error('STOP_AFTER_DAG_METRICS_FIXTURE_JOBS');
const sleepMock = jest.fn<() => Promise<void>>();
const signalListenersBeforeImport = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM')
};
const originalOpenAIKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-dag-metrics-provider-key';

// Keep the worker, payload parser, task runner, metrics and filesystem artifact
// store real. Only database, queue, provider and unrelated dispatch boundaries
// are replaced, following the existing finite worker-consumer fixture.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: jest.fn(),
  initializeDatabase: initializeDatabaseMock,
  isDatabaseConnected: jest.fn(() => true)
}));
jest.unstable_mockModule('@core/db/query.js', () => ({ query: queryMock }));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: jest.fn(async () => undefined),
  recordJobEventWithClient: jest.fn()
}));
jest.unstable_mockModule('@core/db/index.js', () => ({
  getBackstageNotionPartitionCutoverEvidenceRepository: jest.fn(),
  getBackstageNotionPartitionRepository: jest.fn(),
  getBackstageNotionRagRepository: jest.fn(),
  getBackstageNotionSyncStatusRepository: jest.fn(),
  getStatus: jest.fn(),
  initializeDatabaseWithSchema: initializeDatabaseWithSchemaMock
}));
jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({
  postgresQueueSchedulerAdapter: { claimNext: claimNextMock }
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({
  configureBackendUnifiedOpenAIClient: configureBackendOpenAIClientMock
}));
jest.unstable_mockModule('@core/adapters/openai.adapter.js', () => ({
  assertValidResponsesCreateParams: jest.fn(),
  classifyWorkerAiBudgetError: jest.fn(() => null),
  createOpenAIAdapter: getOpenAIAdapterMock,
  normalizeWorkerAiBudgetError: jest.fn((error: unknown) => error),
  normalizeResponsesCreateParams: jest.fn((value: unknown) => value),
  getOpenAIAdapter: getOpenAIAdapterMock,
  isOpenAIAdapterInitialized: jest.fn(() => true),
  resetOpenAIAdapter: jest.fn()
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: jest.fn(() => providerRuntime),
  getOpenAIProviderRuntimeStatus: jest.fn(() => providerRuntime),
  probeOpenAIProviderHealth: probeOpenAIProviderHealthMock,
  syncOpenAIProviderRuntime: jest.fn(() => ({ runtime: providerRuntime }))
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  WorkerAutonomyService: class {},
  classifyWorkerExecutionError: jest.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  })),
  getWorkerAutonomySettings: jest.fn()
}));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: jest.fn(async () => ({}))
}));
jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null)
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({
  executeQueuedGamingSourceIngestion: jest.fn(),
  GAMING_SOURCE_INGESTION_GPT_ID: 'arcanos-gaming',
  GAMING_SOURCE_INGESTION_REASON: 'gaming_source_ingestion',
  GAMING_SOURCE_INGESTION_REQUEST_PATH: '/gpt-access/gaming/sources/ingestions',
  GAMING_SOURCE_REFRESH_REQUEST_PATH: '/gpt-access/gaming/sources/refreshes',
  parseQueuedGamingSourceIngestionBody: jest.fn()
}));
jest.unstable_mockModule('../../src/workers/trinityWorkerPipeline.js', () => ({
  runWorkerTrinityPrompt: runWorkerTrinityPromptMock
}));
jest.unstable_mockModule('@services/trinity/adapter.js', () => ({
  isTrinityDagGptAccessEnabled: jest.fn(() => false),
  routeDagNodeToGptAccess: routeGptRequestMock
}));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn()
}));
jest.unstable_mockModule('@routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock
}));
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: jest.fn()
}));
jest.unstable_mockModule('@shared/sleep.js', () => ({ sleep: sleepMock }));

const { runWorkerConsumerSlot } = await import('../../src/workers/jobRunner.js');
const { dagAgentManager } = await import('../../src/agents/agentManager.js');
const { dagMetrics } = await import('../../src/utils/metrics.js');
const { healthMetrics, logger } = await import('../../src/platform/logging/logger.js');
const { createDagArtifactStore } = await import('../../src/dag/artifactStore.js');
const { buildDagNodeJobInput } = await import('../../src/jobs/jobSchema.js');

afterAll(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListenersBeforeImport[signal].includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  jest.restoreAllMocks();
});

function durationStorage(recorder: DagMetricsRecorder): Map<string, unknown> {
  return (recorder as unknown as { durationsMs: Map<string, unknown> }).durationsMs;
}

describe('DAG worker metrics through queued execution', () => {
  it('preserves terminal outputs and real artifacts while the default singleton stays bounded across queue claims', async () => {
    const temporaryParent = await realpath(tmpdir());
    const artifactDirectory = await mkdtemp(path.join(temporaryParent, 'arcanos-dag-worker-metrics-'));
    const originalArtifactBackend = process.env.TRINITY_ARTIFACT_STORE_BACKEND;
    const originalArtifactDirectory = process.env.TRINITY_ARTIFACT_STORE_DIR;
    process.env.TRINITY_ARTIFACT_STORE_BACKEND = 'filesystem';
    process.env.TRINITY_ARTIFACT_STORE_DIR = artifactDirectory;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('DAG worker metrics fixture forbids network requests.')
    );
    for (const method of ['debug', 'info', 'warn', 'error'] as const) {
      jest.spyOn(logger, method).mockImplementation(() => undefined);
    }
    let now = Date.parse('2026-09-20T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const workerId = 'dag-metrics-worker-slot-1';
      const jobsPerStatus = 12;
      const makeJob = (index: number, failure: boolean) => {
        const id = `${failure ? 'failure' : 'success'}-${index}`;
        return {
          id,
          worker_id: 'queue',
          job_type: 'dag-node',
          status: 'running',
          claim_generation: String(index + 1),
          input: buildDagNodeJobInput({
            dagId: `dagrun_metrics_worker_${id}`,
            node: {
              id: `node-${id}`,
              type: 'agent',
              dependencies: [],
              executionKey: 'dag-worker-metrics-fixture'
            },
            payload: { index, failure, durationMs: failure ? index * 2 : index },
            depth: 0,
            maxRetries: 0,
            waitingTimeoutMs: 60_000
          }),
          retry_count: 0,
          max_retries: 0,
          last_worker_id: workerId,
          lease_expires_at: new Date('2099-09-20T12:01:00.000Z'),
          correlation_id: `dag-metrics-fixture-${id}`,
          cancel_requested_at: null,
          cancel_reason: null,
          created_at: new Date('2026-09-20T11:59:59.000Z'),
          updated_at: new Date('2026-09-20T12:00:00.000Z')
        };
      };
      const validJobs = Array.from({ length: jobsPerStatus }, (_, index) => [
        makeJob(index, false),
        makeJob(index, true)
      ]).flat();
      const malformedJob = {
        ...makeJob(jobsPerStatus, false),
        id: 'malformed-dag-input',
        input: { ...makeJob(jobsPerStatus, false).input, depth: -1 }
      };
      const jobs = [...validJobs, malformedJob];
      let claimedCount = 0;
      let activeJob = jobs[0];
      const completedOutputs = new Map<string, DAGResult>();
      const failedOutputs = new Map<string, unknown>();
      const unexpectedQueries: string[] = [];
      const checkpoints: number[] = [];
      const retainedStorage = durationStorage(dagMetrics);
      expect(retainedStorage.size).toBe(0);

      const agentHandler = jest.fn(async (context: DAGNodeExecutionContext) => {
        now += Number(context.payload.durationMs);
        if (context.payload.failure) {
          throw new Error(`Expected DAG metrics failure ${context.payload.index}.`);
        }
        return { result: `DAG metrics output ${context.payload.index}.` };
      });
      dagAgentManager.registerAgent('dag-worker-metrics-fixture', agentHandler);
      claimNextMock.mockImplementation(async () => {
        const job = jobs[claimedCount++];
        if (!job) {
          throw new Error('Worker claimed beyond the finite metrics fixture.');
        }
        activeJob = job;
        return { job };
      });
      queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
        const statement = String(sql);
        if (statement.startsWith('SELECT * FROM job_data')) {
          expect(params[0]).toBe(activeJob.id);
          return { rows: [activeJob] };
        }
        if (statement.includes('UPDATE job_data')) {
          expect(params[0]).toBe('completed');
          expect(params[9]).toBe(activeJob.id);
          expect(params[10]).toBe(workerId);
          expect(params[11]).toBe(activeJob.claim_generation);
          const output = JSON.parse(String(params[1])) as DAGResult;
          completedOutputs.set(activeJob.id, output);
          return { rows: [{ ...activeJob, status: 'completed', output }] };
        }
        unexpectedQueries.push(statement);
        throw new Error('Unexpected query outside the DAG metrics fixture.');
      });

      const checkRetention = (observationsPerStatus: number) => {
        // Check retained state before snapshot: trimming during snapshot must
        // not conceal an ever-growing worker history between observations.
        expect(durationStorage(dagMetrics)).toBe(retainedStorage);
        expect(retainedStorage.size).toBe(2);
        expect([...retainedStorage.values()].every(value => typeof value === 'number')).toBe(true);
        expect(Object.fromEntries(retainedStorage)).toEqual({
          node_execution: observationsPerStatus - 1,
          node_execution_failed: (observationsPerStatus - 1) * 2
        });
        expect(dagMetrics.snapshot()).toEqual({
          counters: { node_success: observationsPerStatus, node_failure: observationsPerStatus },
          gauges: {},
          durationsMs: {
            node_execution: [observationsPerStatus - 1],
            node_execution_failed: [(observationsPerStatus - 1) * 2]
          }
        });
        expect(healthMetrics.getMetrics()).toMatchObject({
          'dag.counter.node_success': { value: observationsPerStatus },
          'dag.counter.node_failure': { value: observationsPerStatus },
          'dag.duration.node_execution': { value: observationsPerStatus - 1 },
          'dag.duration.node_execution_failed': { value: (observationsPerStatus - 1) * 2 }
        });
        checkpoints.push(observationsPerStatus);
      };
      sleepMock.mockImplementation(async () => {
        if (claimedCount === 12 || claimedCount === 24) {
          checkRetention(claimedCount / 2);
        }
        if (claimedCount === jobs.length) {
          throw stopAfterFixtureJobs;
        }
      });

      const autonomyService = {
        markDispatcherStarted: jest.fn(async () => undefined),
        getHeartbeatIntervalMs: jest.fn(() => 30_000),
        getRecommendedWorkerHeartbeatDelayMs: jest.fn(() => 30_000),
        recordWorkerHeartbeat: jest.fn(async () => undefined),
        evaluateBudgetsBeforeClaim: jest.fn(async () => ({ allowed: true })),
        getWorkerAiCallBudget: jest.fn(() => ({
          statsWorkerId: 'dag-metrics-worker', workerId, maxCallsPerHour: 120
        })),
        setClaimAcceptanceState: jest.fn(async () => undefined),
        recordClaimAttempt: jest.fn(),
        getClaimOptions: jest.fn(() => ({ workerId, leaseMs: 30_000 })),
        recordClaimResult: jest.fn(),
        markJobStarted: jest.fn(async () => undefined),
        recordHeartbeat: jest.fn(async () => activeJob),
        recordProviderCircuitBreakerReset: jest.fn(async () => undefined),
        handleJobFailure: jest.fn(async (
          job: typeof activeJob,
          _message: string,
          _retryable: boolean,
          output: unknown
        ) => {
          failedOutputs.set(job.id, output);
          return { action: 'failed' as const };
        }),
        markJobLeaseLost: jest.fn(async () => undefined),
        markJobCompleted: jest.fn(async () => undefined),
        flushSnapshotPipeline: jest.fn(async () => undefined)
      };
      await expect(runWorkerConsumerSlot(
        {
          slotIndex: 0,
          slotNumber: 1,
          workerId,
          statsWorkerId: 'dag-metrics-worker',
          isInspectorSlot: true
        },
        {
          pollMs: 1,
          idleBackoffMs: 1,
          concurrency: 1,
          baseWorkerId: 'dag-metrics-worker',
          statsWorkerId: 'dag-metrics-worker'
        },
        autonomyService as never
      )).rejects.toBe(stopAfterFixtureJobs);

      expect(checkpoints).toEqual([6, 12]);
      expect(claimNextMock).toHaveBeenCalledTimes(25);
      expect(agentHandler).toHaveBeenCalledTimes(24);
      expect(completedOutputs.size).toBe(12);
      expect(failedOutputs.size).toBe(13);
      expect(autonomyService.markJobCompleted).toHaveBeenCalledTimes(12);
      expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
      expect(autonomyService.flushSnapshotPipeline).toHaveBeenCalledWith('worker-slot-shutdown');

      const artifactStore = createDagArtifactStore();
      for (let index = 0; index < jobsPerStatus; index += 1) {
        const success = completedOutputs.get(`success-${index}`)!;
        expect(success).toMatchObject({
          nodeId: `node-success-${index}`,
          status: 'success',
          metrics: { durationMs: index },
          output: { result: `DAG metrics output ${index}.`, summary: `DAG metrics output ${index}.` }
        });
        expect(success.artifactRef).toBe(
          `trinity/runs/dagrun_metrics_worker_success-${index}/node-success-${index}/attempt-1/result.json`
        );
        expect(await artifactStore.readArtifact(success.artifactRef!)).toEqual(success.output);
        const failure = failedOutputs.get(`failure-${index}`) as DAGResult;
        expect(failure).toMatchObject({
          nodeId: `node-failure-${index}`,
          status: 'failed',
          errorMessage: `Expected DAG metrics failure ${index}.`,
          output: { errorMessage: `Expected DAG metrics failure ${index}.`, durationMs: index * 2 }
        });
        expect(failure.artifactRef).toBe(
          `trinity/runs/dagrun_metrics_worker_failure-${index}/node-failure-${index}/attempt-1/failure.json`
        );
        expect(await artifactStore.readArtifact(failure.artifactRef!)).toEqual(failure.output);
        expect(autonomyService.handleJobFailure).toHaveBeenCalledWith(
          expect.objectContaining({ id: `failure-${index}` }),
          `Expected DAG metrics failure ${index}.`,
          false,
          failure
        );
      }
      expect(autonomyService.handleJobFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: malformedJob.id }),
        expect.stringMatching(/^Invalid DAG job\.input: depth:/),
        false,
        null
      );
      expect(failedOutputs.get(malformedJob.id)).toBeNull();
      expect((await readdir(artifactDirectory, { recursive: true }))
        .filter(file => file.endsWith('.json'))).toHaveLength(24);
      checkRetention(jobsPerStatus);
      expect(unexpectedQueries).toEqual([]);
      expect(providerCallMock).not.toHaveBeenCalled();
      expect(runWorkerTrinityPromptMock).not.toHaveBeenCalled();
      expect(routeGptRequestMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(initializeDatabaseMock).not.toHaveBeenCalled();
      expect(initializeDatabaseWithSchemaMock).not.toHaveBeenCalled();
      expect(configureBackendOpenAIClientMock).not.toHaveBeenCalled();
    } finally {
      if (originalArtifactBackend === undefined) {
        delete process.env.TRINITY_ARTIFACT_STORE_BACKEND;
      } else {
        process.env.TRINITY_ARTIFACT_STORE_BACKEND = originalArtifactBackend;
      }
      if (originalArtifactDirectory === undefined) {
        delete process.env.TRINITY_ARTIFACT_STORE_DIR;
      } else {
        process.env.TRINITY_ARTIFACT_STORE_DIR = originalArtifactDirectory;
      }
      jest.restoreAllMocks();
      const resolvedArtifactDirectory = await realpath(artifactDirectory);
      expect(path.dirname(resolvedArtifactDirectory)).toBe(temporaryParent);
      expect(path.basename(resolvedArtifactDirectory)).toMatch(/^arcanos-dag-worker-metrics-/);
      await rm(resolvedArtifactDirectory, { recursive: true, force: true });
      await expect(access(resolvedArtifactDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
