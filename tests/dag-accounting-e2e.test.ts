import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { JobData } from '../src/core/db/schema.js';
import type { DAGGraph } from '../src/dag/dagGraph.js';
import type { DagArtifactStore } from '../src/dag/artifactStore.js';
import type { DagJobQueue, EnqueueDagNodeJobRequest } from '../src/jobs/jobQueue.js';
import {
  assertDisposablePostgresTestDatabaseUrl, POSTGRES_TEST_DATABASE_NAME, resolvePostgresTestDatabaseUrl
} from './integration/postgresTestDatabase.js';

const databaseEnvironment = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(databaseEnvironment);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, databaseEnvironment);
const schemaName = `dag_claimed_accounting_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
let database: Client;
let connected = false;
let schemaCreated = false;

// Provider transport and background lifecycle are synthetic. The adapter/SDK, claimed
// worker accounting, failure persistence, repository serialization, gateway read,
// parent task runner, and orchestrator below are production implementations.
// Normal Jest uses an in-memory SQL transport. Required PostgreSQL CI mode uses
// the same cases with real inserts, claims, JSONB, terminal fences and SELECTs.
const query = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
const claimNext = jest.fn<() => Promise<{ job: JobData | null }>>();
const dispatch = jest.fn<() => Promise<unknown>>();
const stopWorker = new Error('STOP_SYNTHETIC_WORKER_AFTER_ONE_CLAIM');
const providerRuntime = {
  configVersion: 'synthetic-accounting-provider', nextRetryAt: null,
  lastFailureAt: null, lastFailureCategory: null, consecutiveFailures: 0
};
const listenersBeforeImport = {
  SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM')
};

const databaseClient = await import('../src/core/db/client.js');
jest.unstable_mockModule('@core/db/client.js', () => ({
  ...databaseClient,
  getPool: () => connected ? {
    connect: async () => ({
      query: (sql: string, params: unknown[] = []) => database.query(sql, params),
      release: () => undefined
    })
  } : null,
  initializeDatabase: async () => { throw new Error('Fixture must not initialize application databases.'); },
  isDatabaseConnected: () => !connectionString || connected
}));
const databaseQuery = await import('../src/core/db/query.js');
jest.unstable_mockModule('@core/db/query.js', () => ({
  ...databaseQuery, query, transaction: async () => { throw new Error('Unexpected synthetic database transaction.'); }
}));
const jobEvents = await import('../src/core/db/repositories/jobEventRepository.js');
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  ...jobEvents,
  recordJobEvent: jest.fn(async () => undefined), recordJobEventWithClient: jest.fn()
}));
const workerBudgetRepository = await import('../src/core/db/repositories/workerBudgetRepository.js');
jest.unstable_mockModule('@core/db/repositories/workerBudgetRepository.js', () => ({
  ...workerBudgetRepository,
  reserveWorkerAiProviderAttempt: jest.fn(async () => ({ allowed: true, remaining: 100, alreadyReserved: false })),
  getWorkerBudgetWindowUsage: jest.fn()
}));
jest.unstable_mockModule('@core/scheduler/postgresAdapter.js', () => ({
  postgresQueueSchedulerAdapter: { claimNext }
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  validateAPIKeyAtStartup: () => true, reinitializeOpenAIProvider: jest.fn(),
  getOpenAIServiceHealth: () => providerRuntime, getOpenAIProviderRuntimeStatus: () => providerRuntime,
  probeOpenAIProviderHealth: async () => ({ ok: true, runtime: providerRuntime }),
  syncOpenAIProviderRuntime: () => ({ runtime: providerRuntime })
}));
jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: async () => ({ 'arcanos-core': { route: 'arcanos-core', module: 'ARCANOS:CORE' } })
}));
jest.unstable_mockModule('@routes/_core/gptDispatch.js', () => ({ routeGptRequest: dispatch }));
jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({ detectBackstageBookerIntent: () => null }));
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({ initializeModuleRegistry: jest.fn() }));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({ configureDefaultArcanosCoreRuntimeProviders: jest.fn() }));
jest.unstable_mockModule('@shared/sleep.js', () => ({ sleep: async () => { throw stopWorker; } }));

const { getOpenAIAdapter, resetOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js');
const { runWorkerConsumerSlot } = await import('../src/workers/jobRunner.js');
const { WorkerAutonomyService } = await import('../src/services/workerAutonomyService.js');
const { getJobById, updateClaimedJobTerminal, createClaimedJobFence, createJob, claimNextPendingJob } = await import('../src/core/db/repositories/jobRepository.js');
const { buildQueuedGptJobInput } = await import('../src/shared/gpt/asyncGptJob.js');
const { getGptAccessJobResult } = await import('../src/services/gptAccessGateway.js');
const { createDagNodeRunPromptBridge } = await import('../src/workers/dagNodePromptBridge.js');
const { runDagNodeJob } = await import('../src/workers/taskRunners.js');
const { buildDagNodeJobInput, buildDagQueueJobRecord } = await import('../src/jobs/jobSchema.js');
const { DAGOrchestrator } = await import('../src/dag/orchestrator.js');

beforeAll(async () => {
  if (!connectionString) return;
  database = new Client({
    connectionString, ssl: false, connectionTimeoutMillis: 5_000, statement_timeout: 10_000,
    application_name: 'arcanos-dag-claimed-accounting-e2e'
  });
  await database.connect();
  connected = true;
  const identity = await database.query(`SELECT current_setting('server_version_num') AS version, current_database() AS database`);
  expect(Math.trunc(Number(identity.rows[0]?.version) / 10_000)).toBe(18);
  expect(identity.rows[0]?.database).toBe(POSTGRES_TEST_DATABASE_NAME);
  await database.query(`CREATE SCHEMA ${quotedSchema}`);
  schemaCreated = true;
  await database.query(`SET search_path TO ${quotedSchema}, pg_catalog`);
  await database.query(`CREATE TABLE job_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), worker_id VARCHAR(255) NOT NULL,
    job_type VARCHAR(255) NOT NULL, status VARCHAR(50) NOT NULL DEFAULT 'pending',
    claim_generation BIGINT NOT NULL DEFAULT 0, input JSONB NOT NULL, output JSONB, error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 2,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, last_heartbeat_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ, priority INTEGER NOT NULL DEFAULT 100, last_worker_id VARCHAR(255),
    stats_worker_id VARCHAR(255) COLLATE "C", correlation_id TEXT, autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_fingerprint_hash TEXT, idempotency_key_hash TEXT, idempotency_scope_hash TEXT, idempotency_origin VARCHAR(32),
    retention_until TIMESTAMPTZ, idempotency_until TIMESTAMPTZ, expires_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ, cancel_reason TEXT, completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}, 30_000);
beforeEach(async () => { if (connected) await database.query('DELETE FROM job_data'); });
afterAll(async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBeforeImport[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  if (connected) {
    try {
      await database.query('RESET search_path');
      if (schemaCreated) await database.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    } finally {
      connected = false;
      await database.end();
    }
  }
}, 30_000);
afterEach(() => { resetOpenAIAdapter(); });

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const workerId = 'synthetic-accounting-worker';
const graph: DAGGraph = {
  id: 'synthetic-accounting-e2e',
  nodes: {
    first: { id: 'first', type: 'agent', dependencies: [], executionKey: 'planner' },
    dependent: { id: 'dependent', type: 'agent', dependencies: ['first'], executionKey: 'planner' }
  },
  edges: [{ from: 'first', to: 'dependent' }], entrypoints: ['first']
};

function roundTrip<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

interface SyntheticAttempt { totals: number[]; failAfterProvider?: boolean }

async function runFixture(attempts: SyntheticAttempt[], tokenCap: number) {
  const childWorkerScope = new AsyncResource('synthetic-dag-child-worker');
  const rows = new Map<string, JobData>();
  const terminalWrites: { jobId: string; status: unknown; output: unknown }[] = [];
  const children: string[] = [];
  const requests: EnqueueDagNodeJobRequest[] = [];
  const artifacts = new Map<string, unknown>();
  const artifactStore: DagArtifactStore = {
    writeArtifact: async request => {
      const key = `${request.runId}/${request.nodeId}/${request.attempt}`;
      artifacts.set(key, roundTrip(request.payload));
      return key;
    },
    readArtifact: async <T>(key: string): Promise<T> => {
      if (!artifacts.has(key)) throw new Error('Unexpected missing synthetic artifact.');
      return roundTrip(artifacts.get(key)) as T;
    }
  };
  let sequence = 0;
  async function createRow(jobType: string, input: unknown): Promise<JobData> {
    if (connected) {
      const row = await createJob('synthetic-accounting-queue', jobType, input, {
        maxRetries: jobType === 'gpt' ? 2 : 0, correlationId: 'synthetic-accounting-trace'
      });
      rows.set(row.id, row);
      return row;
    }
    const timestamp = new Date();
    const row = {
      id: `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      worker_id: 'queue', job_type: jobType, status: 'running', claim_generation: '1',
      retry_count: 0, max_retries: jobType === 'gpt' ? 2 : 0, input: roundTrip(input), output: null,
      last_worker_id: workerId, lease_expires_at: new Date(timestamp.getTime() + 60_000),
      correlation_id: 'synthetic-accounting-trace', cancel_requested_at: null, cancel_reason: null,
      created_at: timestamp, updated_at: timestamp
    } as JobData;
    rows.set(row.id, row);
    return row;
  }

  query.mockReset().mockImplementation(async (sql, params = []) => {
    if (connected) {
      const result = await database.query(sql, params);
      if (sql.startsWith('UPDATE job_data') && sql.includes('output = $2::jsonb')) {
        expect(result.rows).toHaveLength(1);
        terminalWrites.push({ jobId: result.rows[0].id, status: result.rows[0].status, output: result.rows[0].output });
      }
      for (const row of result.rows) {
        if (typeof row.id === 'string' && typeof row.job_type === 'string') rows.set(row.id, row);
      }
      return result;
    }
    if (sql.startsWith('SELECT * FROM job_data')) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [roundTrip(row)] : [] };
    }
    if (sql.startsWith('UPDATE job_data') && sql.includes('output = $2::jsonb')) {
      const row = rows.get(String(params[9]));
      if (!row) throw new Error('Unexpected terminal write target.');
      // Default offline mode verifies arguments; PostgreSQL mode above executes
      // the actual fenced SQL and captures only the returned terminal JSONB row.
      expect(params.slice(10, 12)).toEqual([workerId, '1']);
      expect(row.status).toBe('running');
      const output = JSON.parse(String(params[1]));
      Object.assign(row, {
        status: params[0], output, error_message: params[2], completed_at: new Date(), lease_expires_at: null
      });
      terminalWrites.push({ jobId: row.id, status: params[0], output: roundTrip(output) });
      return { rows: [roundTrip(row)] };
    }
    if (sql.startsWith('WITH failure_rows AS')) return { rows: [] };
    throw new Error('Unexpected synthetic repository query.');
  });

  const providerResponses = attempts.flatMap(attempt => attempt.totals);
  const fetch = jest.fn(async () => {
    if (providerResponses.length === 0) throw new Error('Unexpected extra provider transport.');
    const total = providerResponses.shift()!;
    return new Response(JSON.stringify({
      id: 'synthetic-response', object: 'response', created_at: 1, model: 'gpt-4.1-mini', status: 'completed',
      usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic answer.', annotations: [] }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  resetOpenAIAdapter();
  const adapter = getOpenAIAdapter({ apiKey: 'test-key', maxRetries: 0, fetch });

  // Real failure decision and real repository persistence; unrelated health,
  // snapshot and webhook operations are inert so no background effects escape.
  const autonomyService = Object.assign(Object.create(WorkerAutonomyService.prototype), {
    settings: { workerId, defaultMaxRetries: 2, failureWebhookThreshold: 100 },
    state: { terminalFailures: 0, deadLetterJobs: 0, scheduledRetries: 0 },
    markDispatcherStarted: jest.fn(async () => undefined), getHeartbeatIntervalMs: () => 30_000,
    getRecommendedWorkerHeartbeatDelayMs: () => 30_000, recordWorkerHeartbeat: jest.fn(async () => undefined),
    evaluateBudgetsBeforeClaim: jest.fn(async () => ({ allowed: true })),
    getWorkerAiCallBudget: () => ({ statsWorkerId: workerId, workerId, maxCallsPerHour: 120 }),
    setClaimAcceptanceState: jest.fn(async () => undefined), recordClaimAttempt: jest.fn(),
    getClaimOptions: () => ({ workerId, leaseMs: 30_000 }), recordClaimResult: jest.fn(),
    markJobStarted: jest.fn(async () => undefined), markIdle: jest.fn(async () => undefined),
    recordHeartbeat: jest.fn(async (job: Pick<JobData, 'id'>) => rows.get(job.id)),
    recordProviderCircuitBreakerReset: jest.fn(async () => undefined), markJobLeaseLost: jest.fn(async () => undefined),
    markJobCompleted: jest.fn(async () => undefined), markJobCancelled: jest.fn(async () => undefined),
    flushSnapshotPipeline: jest.fn(async () => undefined), persistSnapshot: jest.fn(async () => undefined),
    maybeSendFailureWebhook: jest.fn(async () => undefined), readCurrentHourlyStats: jest.fn(async () => ({ stats: {} }))
  });
  const workerFailure = jest.spyOn(autonomyService, 'handleJobFailure');

  dispatch.mockReset().mockImplementation(async () => {
    const attempt = attempts[children.length - 1];
    if (!attempt) throw new Error('Unexpected child attempt.');
    let finalTokens: number | undefined;
    for (let stage = 0; stage < attempt.totals.length; stage += 1) {
      const result = await adapter.responses.create({ model: 'gpt-4.1-mini', input: `Synthetic stage ${stage}.` });
      finalTokens = result.usage?.total_tokens;
    }
    if (attempt.failAfterProvider) throw new Error('Temporary failure after synthetic provider work.');
    return {
      ok: true, result: { result: 'Synthetic answer.', meta: { tokens: { total_tokens: finalTokens } }, guardInfo: { sessionTokensUsed: 4_000 } },
      _route: { module: 'ARCANOS:CORE', route: 'arcanos-core' }
    };
  });

  const gatewayReads: unknown[] = [];
  const runPrompt = createDagNodeRunPromptBridge(adapter.getClient(), {
    useGptAccess: true,
    gptAccessConfig: {
      waitForResultMs: 1_000,
      createAiJob: async body => {
        const row = await createRow('gpt', buildQueuedGptJobInput({
          gptId: body.gptId, requestPath: '/gpt-access/jobs/create', bypassIntentRouting: true,
          executionModeReason: 'gpt_access_create_ai_job',
          body: { action: 'query', prompt: body.task, payload: { input: body.input } }
        }));
        children.push(row.id);
        claimNext.mockReset().mockImplementationOnce(async () => {
          const claimed = connected ? await claimNextPendingJob({ workerId, leaseMs: 30_000, priorityQueueEnabled: false }) : row;
          expect(claimed?.id).toBe(row.id);
          if (claimed) rows.set(claimed.id, claimed);
          return { job: claimed };
        }).mockResolvedValue({ job: null });
        // A queued child executes outside the waiting parent's async context.
        // Preserve that separation even though both workers share this process.
        await expect(childWorkerScope.runInAsyncScope(() => runWorkerConsumerSlot(
          { slotIndex: 0, slotNumber: 1, workerId, statsWorkerId: workerId, isInspectorSlot: false },
          { pollMs: 1, idleBackoffMs: 1, concurrency: 1, baseWorkerId: workerId, statsWorkerId: workerId },
          autonomyService, undefined, undefined, undefined, jest.fn()
        ))).rejects.toBe(stopWorker);
        expect(rows.get(row.id)?.status).toMatch(/^(completed|failed)$/);
        return { statusCode: 202, payload: { ok: true, jobId: row.id, status: 'queued' } };
      },
      getJobResult: async (body, context) => {
        const response = await getGptAccessJobResult(body, context);
        gatewayReads.push(roundTrip(response.payload));
        return response;
      }
    }
  });
  const queue: DagJobQueue = {
    enqueueDagNodeJob: async request => {
      requests.push(request);
      return buildDagQueueJobRecord(await createRow('dag-node', buildDagNodeJobInput(request)));
    },
    requestDagJobCancellation: async () => ({ outcome: 'not_found', record: null }),
    waitForDagJobCompletion: async (jobId, options) => {
      const row = connected
        ? await claimNextPendingJob({ workerId, leaseMs: 30_000, priorityQueueEnabled: false })
        : await getJobById(jobId);
      if (!row) throw new Error('Missing synthetic parent job.');
      expect(row.id).toBe(jobId);
      const result = await runDagNodeJob(row.input as Parameters<typeof runDagNodeJob>[0], { runPrompt, artifactStore, logger });
      const terminal = await updateClaimedJobTerminal(jobId, result.status === 'failed' ? 'failed' : 'completed', {
        fence: createClaimedJobFence(workerId, row.claim_generation), output: result, errorMessage: result.errorMessage
      });
      const record = buildDagQueueJobRecord(terminal!);
      // Repeated terminal notifications must not charge one attempt twice.
      options?.onStatusChange?.(record);
      options?.onStatusChange?.(buildDagQueueJobRecord(roundTrip(terminal!)));
      return buildDagQueueJobRecord((await getJobById(jobId))!);
    }
  };
  const onNodeFailed = jest.fn();
  const onNodeRetried = jest.fn();
  const onGuardViolation = jest.fn();
  const orchestrator = new DAGOrchestrator({
    jobQueue: queue, logger,
    settings: {
      maxConcurrentNodes: 1, maxDepth: 3, maxChildrenPerNode: 5, maxRetries: 2,
      maxTokenBudgetPerDag: tokenCap, maxAiCallsPerRun: 10, nodeTimeoutMs: 5_000, pollIntervalMs: 1
    }
  });
  const summary = await orchestrator.runGraph(graph, {
    payloadByNodeId: { first: { prompt: 'Synthetic first stage.' }, dependent: { prompt: 'Synthetic descendant.' } },
    sharedState: { sessionId: 'synthetic-accounting-shared-session' },
    observer: { onNodeFailed, onNodeRetried, onGuardViolation }
  }).finally(() => childWorkerScope.emitDestroy());
  expect(autonomyService.markJobLeaseLost).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(attempts.reduce((count, attempt) => count + attempt.totals.length, 0));
  expect(providerResponses).toHaveLength(0);
  expect(dispatch).toHaveBeenCalledTimes(attempts.length);
  return { summary, requests, terminalWrites, children, gatewayReads, workerFailure, onNodeFailed, onNodeRetried, onGuardViolation };
}

describe(`DAG accounting across synthetic provider, claimed child, ${connectionString ? 'PostgreSQL 18' : 'synthetic SQL transport'}, gateway and parent`, () => {
  it('charges 107 rather than public final-stage 7, exactly once, and blocks descendants at cap 100', async () => {
    const result = await runFixture([{ totals: [11, 89, 7] }], 100);
    expect(result.summary.tokenBudgetUsed).toBe(107);
    expect(result.terminalWrites.find(write => write.jobId === result.children[0])?.output).toMatchObject({
      dagAttemptUsage: 107, result: { meta: { tokens: { total_tokens: 7 } } }
    });
    expect(result.gatewayReads[0]).toMatchObject({ result: { dagAttemptUsage: 107, result: { meta: { tokens: '[REDACTED]' } } } });
    expect(result.summary.resultsByNodeId.first).toMatchObject({ status: 'success', metrics: { attemptTokenUsage: 107 } });
    expect(result.summary.resultsByNodeId.first.metrics?.tokenUsage).toBeUndefined();
    expect(result.summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(result.requests.map(request => request.node.id)).toEqual(['first']);
    expect(result.onGuardViolation).toHaveBeenCalledWith(expect.objectContaining({ type: 'budget_exceeded' }));
  });

  it('keeps malformed first-provider usage unknown and nonretryable across terminal persistence and gateway', async () => {
    const result = await runFixture([{ totals: [-1] }], 100);
    const childOutput = result.terminalWrites.find(write => write.jobId === result.children[0])?.output;
    expect(childOutput).toEqual({ retryable: false, error: { message: 'Invalid provider token usage for execution attempt.' } });
    expect(result.gatewayReads[0]).toMatchObject({ status: 'failed', result: { retryable: false } });
    expect(result.summary.resultsByNodeId.first).toMatchObject({ status: 'failed', retryable: false });
    expect(result.summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBeUndefined();
    expect(result.summary.tokenBudgetUsed).toBe(0);
    expect(result.summary.totalRetries).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(result.workerFailure).toHaveBeenCalledWith(expect.any(Object), expect.any(String), false, childOutput);
    expect(result.onNodeRetried).not.toHaveBeenCalled();
  });

  it('charges retry-local 27 plus 43 exactly once and blocks descendants at cap 70', async () => {
    const result = await runFixture([{ totals: [27], failAfterProvider: true }, { totals: [43] }], 70);
    expect(result.summary.tokenBudgetUsed).toBe(70);
    expect(result.summary.totalRetries).toBe(1);
    expect(result.requests.map(request => [request.node.id, request.attempt])).toEqual([['first', 0], ['first', 1]]);
    expect(result.children.map(jobId => result.terminalWrites.find(write => write.jobId === jobId)?.output)).toMatchObject([
      { dagAttemptUsage: 27, retryable: true }, { dagAttemptUsage: 43 }
    ]);
    expect(result.summary.resultsByNodeId.first.status).toBe('success');
    expect(result.summary.resultsByNodeId.dependent.status).toBe('skipped');
  });

  it('charges a failed child reaching the cap before suppressing a parent retry', async () => {
    const result = await runFixture([{ totals: [100], failAfterProvider: true }], 100);
    expect(result.summary.tokenBudgetUsed).toBe(100);
    expect(result.summary.totalRetries).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.summary.resultsByNodeId.first.status).toBe('failed');
    expect(result.summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(result.onNodeFailed).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false }));
    expect(result.onNodeRetried).not.toHaveBeenCalled();
  });
});
