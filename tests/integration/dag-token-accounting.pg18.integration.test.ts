import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from 'pg';

import type { DAGGraph } from '../../src/dag/dagGraph.js';
import type { DagArtifactStore } from '../../src/dag/artifactStore.js';
import type { EnqueueDagNodeJobRequest, WaitForDagJobCompletionOptions } from '../../src/jobs/jobQueue.js';
import type { DagQueueJobRecord } from '../../src/jobs/jobSchema.js';
import type { DagTaskRunnerDependencies } from '../../src/workers/taskRunners.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (connectionString) {
  assertDisposablePostgresTestDatabaseUrl(connectionString, TEST_DATABASE_ENV);
}
const describeWithDatabase = connectionString ? describe : describe.skip;
const schemaName = `dag_token_accounting_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
let client: Client;
let connected = false;
let schemaCreated = false;

// Repository SQL, JSONB conversion, claims, terminal fences, queue polling,
// worker accounting and orchestration stay real. Only connection ownership and
// the unrelated event sink are redirected into this disposable schema.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => ({
    connect: async () => ({
      query: (text: string, params: unknown[] = []) => client.query(text, params),
      release: () => undefined
    })
  }),
  isDatabaseConnected: () => connected,
  getStatus: () => ({ connected }),
  initializeDatabase: async () => {
    throw new Error('DAG accounting fixture must not initialize an application database.');
  },
  close: async () => undefined,
  closePoolIfCurrent: async () => undefined,
  resolveDatabaseConnectionCandidates: () => []
}));
const queryModule = await import('../../src/core/db/query.js');
jest.unstable_mockModule('@core/db/query.js', () => ({
  ...queryModule,
  query: (text: string, params: unknown[] = []) => client.query(text, params)
}));
const jobEventModule = await import('../../src/core/db/repositories/jobEventRepository.js');
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
  ...jobEventModule,
  recordJobEvent: async () => ({ inserted: true }),
  recordJobEventWithClient: async () => ({ inserted: true })
}));

const {
  claimNextPendingJob,
  createClaimedJobFence,
  createJob,
  getJobById,
  updateClaimedJobTerminal
} = await import('../../src/core/db/repositories/jobRepository.js');
const { DatabaseBackedDagJobQueue } = await import('../../src/jobs/jobQueue.js');
const { parseDagNodeJobInput } = await import('../../src/jobs/jobSchema.js');
const { DAGOrchestrator } = await import('../../src/dag/orchestrator.js');
const { runDagNodeJob } = await import('../../src/workers/taskRunners.js');
const { instrumentOpenAIOperation } = await import('../../src/core/adapters/openai.adapter.js');
const { createDagMetricsRecorder } = await import('../../src/utils/metrics.js');
const { runWithDagChildAccounting } = await import('../../src/workers/dagChildAccounting.js');
const { createDagNodeRunPromptBridge } = await import('../../src/workers/dagNodePromptBridge.js');
const { buildGptJobResultLookupPayload } = await import('../../src/shared/gpt/gptJobResult.js');
const { sanitizeGptAccessPayload } = await import('../../src/services/gptAccessSanitization.js');

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

async function providerStage(totalTokens: unknown): Promise<void> {
  await instrumentOpenAIOperation({
    operation: 'responses_create',
    model: 'synthetic-postgres-dag-accounting',
    callback: async () => ({ usage: { total_tokens: totalTokens } })
  });
}

function publicOutput(totalTokens: number): Record<string, unknown> {
  return {
    result: 'Synthetic PostgreSQL accounting answer.',
    meta: { tokens: { total_tokens: totalTokens } },
    guardInfo: { sessionTokensUsed: 900 }
  };
}

function createMemoryArtifacts(): DagArtifactStore {
  const artifacts = new Map<string, string>();
  return {
    async writeArtifact(request) {
      const reference = `${request.runId}/${request.nodeId}/${request.attempt}/${request.artifactKind}`;
      artifacts.set(reference, JSON.stringify(request.payload));
      return reference;
    },
    async readArtifact<T>(reference: string): Promise<T> {
      const stored = artifacts.get(reference);
      if (stored === undefined) throw new Error('Unknown disposable DAG artifact.');
      return JSON.parse(stored) as T;
    }
  };
}

class FiniteDatabaseWorkerQueue extends DatabaseBackedDagJobQueue {
  readonly requests: EnqueueDagNodeJobRequest[] = [];
  readonly records: DagQueueJobRecord[] = [];

  constructor(
    private readonly runPrompt: DagTaskRunnerDependencies['runPrompt'],
    private readonly workerArtifacts = createMemoryArtifacts()
  ) {
    super('dag-accounting-disposable-queue', workerArtifacts);
  }

  override async enqueueDagNodeJob(request: EnqueueDagNodeJobRequest): Promise<DagQueueJobRecord> {
    this.requests.push(request);
    return super.enqueueDagNodeJob(request);
  }

  override async waitForDagJobCompletion(
    jobId: string,
    options: WaitForDagJobCompletionOptions = {}
  ): Promise<DagQueueJobRecord> {
    const claimed = await claimNextPendingJob({
      workerId: 'dag-accounting-disposable-worker',
      leaseMs: 30_000,
      priorityQueueEnabled: false
    });
    expect(claimed?.id).toBe(jobId);
    if (!claimed) throw new Error('Disposable DAG claim was missing.');
    const parsed = parseDagNodeJobInput(claimed.input);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = await runDagNodeJob(parsed.value, {
      runPrompt: this.runPrompt,
      artifactStore: this.workerArtifacts,
      metrics: createDagMetricsRecorder(),
      logger
    });
    const persisted = await updateClaimedJobTerminal(
      jobId,
      result.status === 'failed' ? 'failed' : 'completed',
      {
        fence: createClaimedJobFence(claimed.last_worker_id!, claimed.claim_generation),
        output: result,
        errorMessage: result.errorMessage
      }
    );
    expect(persisted).not.toBeNull();

    // Every observation is a fresh production repository SELECT and JSONB read.
    // Repeated terminal notifications must not charge the same attempt again.
    const record = await super.waitForDagJobCompletion(jobId, options);
    await super.waitForDagJobCompletion(jobId, options);
    await super.waitForDagJobCompletion(jobId, options);
    this.records.push(record);
    return record;
  }
}

function runGraph(queue: FiniteDatabaseWorkerQueue, tokenCap: number, maxRetries = 0) {
  const graph: DAGGraph = {
    id: `pg18-accounting-${randomUUID()}`,
    nodes: {
      first: { id: 'first', type: 'agent', executionKey: 'planner', dependencies: [] },
      dependent: { id: 'dependent', type: 'agent', executionKey: 'planner', dependencies: ['first'] }
    },
    edges: [{ from: 'first', to: 'dependent' }],
    entrypoints: ['first']
  };
  return new DAGOrchestrator({
    jobQueue: queue,
    logger,
    settings: {
      maxConcurrentNodes: 1,
      maxDepth: 3,
      maxChildrenPerNode: 5,
      maxRetries,
      maxTokenBudgetPerDag: tokenCap,
      maxAiCallsPerRun: 10,
      nodeTimeoutMs: 5_000,
      pollIntervalMs: 1
    }
  }).runGraph(graph, {
    sharedState: { sessionId: 'disposable-dag-accounting-session' },
    payloadByNodeId: {
      first: { prompt: 'Run the controlled PostgreSQL accounting fixture.' },
      dependent: { prompt: 'This dependent must not run.' }
    }
  });
}

function childPrompt(mode: 'invalid' | 'cancelled') {
  return createDagNodeRunPromptBridge({} as never, {
    useGptAccess: true,
    gptAccessConfig: {
      waitForResultMs: 1_000,
      createAiJob: async body => {
        const input = { requestPath: '/gpt-access/jobs/create', body: { payload: body } };
        const row = await createJob('dag-accounting-child-queue', 'gpt', input, { maxRetries: 0 });
        const claimed = await claimNextPendingJob({
          workerId: 'dag-accounting-child-worker',
          leaseMs: 30_000,
          priorityQueueEnabled: false
        });
        expect(claimed?.id).toBe(row.id);
        if (!claimed) throw new Error('Disposable child claim was missing.');
        let output: unknown;
        let status: 'failed' | 'cancelled';
        try {
          const outcome = await runWithDagChildAccounting(claimed.input, async () => {
            await providerStage(mode === 'invalid' ? 'not-a-token-count' : 39);
            return {
              status: 'cancelled' as const,
              output: { retryable: false, result: null }
            };
          });
          output = outcome.output;
          status = outcome.status;
        } catch (error) {
          status = 'failed';
          output = {
            retryable: error && typeof error === 'object' ? Reflect.get(error, 'retryable') : undefined,
            error: { message: error instanceof Error ? error.message : String(error) }
          };
        }
        const persisted = await updateClaimedJobTerminal(row.id, status, {
          fence: createClaimedJobFence(claimed.last_worker_id!, claimed.claim_generation),
          output,
          errorMessage: 'Controlled child terminal outcome.'
        });
        expect(persisted).not.toBeNull();
        return { statusCode: 202, payload: { ok: true, jobId: row.id, status: 'queued' } };
      },
      getJobResult: async body => {
        const row = await getJobById(body.jobId);
        expect(row).not.toBeNull();
        return {
          statusCode: 200,
          payload: sanitizeGptAccessPayload({
            ok: true,
            ...buildGptJobResultLookupPayload(body.jobId, row)
          })
        };
      }
    }
  });
}

describeWithDatabase('DAG aggregate accounting across PostgreSQL 18 queue persistence', () => {
  beforeAll(async () => {
    client = new Client({
      connectionString,
      ssl: false,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      application_name: 'arcanos-dag-token-accounting-pg18-test'
    });
    await client.connect();
    connected = true;
    const version = await client.query<{ version: string; database: string }>(
      `SELECT current_setting('server_version_num') AS version, current_database() AS database`
    );
    expect(Math.trunc(Number(version.rows[0]?.version) / 10_000)).toBe(18);
    expect(version.rows[0]?.database).toBe(POSTGRES_TEST_DATABASE_NAME);
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await client.query(`SET search_path TO ${quotedSchema}, pg_catalog`);
    await client.query(`CREATE TABLE job_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      worker_id VARCHAR(255) NOT NULL,
      job_type VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      claim_generation BIGINT NOT NULL DEFAULT 0,
      input JSONB NOT NULL,
      output JSONB,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ,
      priority INTEGER NOT NULL DEFAULT 100,
      last_worker_id VARCHAR(255),
      stats_worker_id VARCHAR(255) COLLATE "C",
      correlation_id TEXT,
      autonomy_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_fingerprint_hash TEXT,
      idempotency_key_hash TEXT,
      idempotency_scope_hash TEXT,
      idempotency_origin VARCHAR(32),
      retention_until TIMESTAMPTZ,
      idempotency_until TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ,
      cancel_reason TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }, 30_000);

  beforeEach(async () => {
    await client.query('DELETE FROM job_data');
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await client.query('RESET search_path');
      if (schemaCreated) await client.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    } finally {
      connected = false;
      await client.end();
    }
  }, 30_000);

  test('round-trips aggregate 107 and public final usage 7, blocking descendants at cap 100', async () => {
    const queue = new FiniteDatabaseWorkerQueue(async () => {
      await providerStage(30);
      await providerStage(70);
      await providerStage(7);
      return publicOutput(7);
    });
    const summary = await runGraph(queue, 100);
    expect(summary.tokenBudgetUsed).toBe(107);
    expect(summary.resultsByNodeId.first.metrics).toMatchObject({ attemptTokenUsage: 107, tokenUsage: 7 });
    expect(summary.resultsByNodeId.first.output).toMatchObject({ meta: { tokens: { total_tokens: 7 } } });
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(queue.requests).toHaveLength(1);
    const rows = await client.query(`SELECT output, claim_generation::text FROM job_data`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      claim_generation: '1',
      output: { metrics: { attemptTokenUsage: 107, tokenUsage: 7 } }
    });
  });

  test('charges persisted failed and successful attempts 27 plus 43 exactly once before retry and descendant admission', async () => {
    const queue = new FiniteDatabaseWorkerQueue(async (_prompt, options) => {
      if (options.attempt === 0) {
        await providerStage(27);
        throw new Error('Controlled transient failure after provider work.');
      }
      await providerStage(43);
      return publicOutput(3);
    });
    const summary = await runGraph(queue, 70, 2);
    expect(summary.tokenBudgetUsed).toBe(70);
    expect(summary.totalRetries).toBe(1);
    expect(queue.requests.map(request => [request.node.id, request.attempt])).toEqual([['first', 0], ['first', 1]]);
    expect(queue.records.map(record => record.output?.metrics?.attemptTokenUsage)).toEqual([27, 43]);
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
    const rows = await client.query(`SELECT status, output FROM job_data ORDER BY created_at`);
    expect(rows.rows.map(row => [row.status, row.output.metrics.attemptTokenUsage])).toEqual([
      ['failed', 27], ['completed', 43]
    ]);
  });

  test('preserves a malformed child usage failure and its non-retryable hint across JSONB and the result gateway', async () => {
    const queue = new FiniteDatabaseWorkerQueue(childPrompt('invalid'));
    const summary = await runGraph(queue, 100, 2);
    expect(summary.tokenBudgetUsed).toBe(0);
    expect(summary.totalRetries).toBe(0);
    expect(summary.resultsByNodeId.first).toMatchObject({ status: 'failed', retryable: false });
    expect(summary.resultsByNodeId.first.metrics?.attemptTokenUsage).toBeUndefined();
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(queue.requests).toHaveLength(1);
    const rows = await client.query(`SELECT status, output FROM job_data WHERE job_type = 'gpt'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: 'failed', output: { retryable: false } });
    expect(rows.rows[0].output.dagAttemptUsage).toBeUndefined();
  });

  test('retains cancelled child usage and charges it once through repeated durable terminal observations', async () => {
    const queue = new FiniteDatabaseWorkerQueue(childPrompt('cancelled'));
    const summary = await runGraph(queue, 100, 2);
    expect(summary.tokenBudgetUsed).toBe(39);
    expect(summary.totalRetries).toBe(0);
    expect(summary.resultsByNodeId.first).toMatchObject({
      status: 'failed', retryable: false, metrics: { attemptTokenUsage: 39 }
    });
    expect(summary.resultsByNodeId.dependent.status).toBe('skipped');
    expect(queue.requests).toHaveLength(1);
    const rows = await client.query(`SELECT status, output FROM job_data WHERE job_type = 'gpt'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      status: 'cancelled', output: { retryable: false, dagAttemptUsage: 39 }
    });
  });
});
