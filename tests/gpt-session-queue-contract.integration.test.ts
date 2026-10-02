/**
 * Offline queue-contract proof: real Gateway validation/producer, queue parser,
 * passive worker handler, dispatcher, CORE, Trinity and conversation storage.
 * Database/provider transports are synthetic. This does not prove PostgreSQL
 * locking, atomic deduplication, hosted behavior or principal-owned memory.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import type { FindOrCreateGptJobOptions } from '../src/core/db/repositories/jobRepository.js';
import {
  createSyntheticDurableMemory,
  respondFromObservedInput,
  type SyntheticResponsesRequest,
} from './fixtures/session-context-e2e.js';

const durableMemory = createSyntheticDurableMemory();
const forbiddenIO = jest.fn(() => { throw new Error('Unexpected external I/O in queue-contract fixture'); });
const responsesCreate = jest.fn(async (input: SyntheticResponsesRequest) => respondFromObservedInput(input));
const modelClient = {
  models: { retrieve: jest.fn(async (id: string) => ({ id })) },
  responses: { create: responsesCreate },
};
const queuedRows = new Map<string, JobData>();
const queueWrites: Array<FindOrCreateGptJobOptions> = [];
const findOrCreateGptJob = jest.fn(async (options: FindOrCreateGptJobOptions) => {
  // The adapter deliberately does not emulate SQL deduplication. Assertions use
  // the producer's actual namespace/fingerprint hashes supplied to storage.
  queueWrites.push(structuredClone(options));
  const job = {
    id: randomUUID(), job_type: 'gpt', worker_id: options.workerId,
    status: 'pending', input: JSON.parse(JSON.stringify(options.input)),
    request_fingerprint_hash: options.requestFingerprintHash,
    idempotency_scope_hash: options.idempotencyScopeHash,
    idempotency_key_hash: options.idempotencyKeyHash,
    created_at: new Date().toISOString(), output: null,
  } as JobData;
  queuedRows.set(job.id, job);
  return { job, deduped: false };
});
const temporaryRoot = mkdtempSync(join(tmpdir(), 'arcanos-session-queue-'));
const environmentKeys = [
  'ARC_MEMORY_PATH', 'ARC_LOG_PATH', 'FINETUNED_MODEL_ID', 'OPENAI_STORE',
  'TRINITY_JUDGED_FEEDBACK_ENABLED', 'SELF_IMPROVE_ENABLED', 'GPT_MODULE_MAP',
  'GPTID_CORE', 'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG', 'RAG_ENABLED',
] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
process.env.ARC_MEMORY_PATH = join(temporaryRoot, 'memory');
process.env.ARC_LOG_PATH = join(temporaryRoot, 'logs');
process.env.FINETUNED_MODEL_ID = 'ft:synthetic:session-queue-authority';
process.env.OPENAI_STORE = 'false';
process.env.TRINITY_JUDGED_FEEDBACK_ENABLED = 'false';
process.env.SELF_IMPROVE_ENABLED = 'false';
process.env.RAG_ENABLED = 'false';
delete process.env.GPT_MODULE_MAP;
delete process.env.GPTID_CORE;
delete process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: forbiddenIO,
  initializeDatabase: forbiddenIO,
  isDatabaseConnected: () => false,
  getStatus: () => ({ connected: false, hasPool: false, error: null }),
  close: forbiddenIO,
  closePoolIfCurrent: forbiddenIO,
  resolveDatabaseConnectionCandidates: forbiddenIO,
}));
const actualQuery = await import('../src/core/db/query.js');
jest.unstable_mockModule('@core/db/query.js', () => ({
  ...actualQuery, query: forbiddenIO, transaction: forbiddenIO,
}));
const actualMemoryRepository = await import('../src/core/db/repositories/memoryRepository.js');
jest.unstable_mockModule('@core/db/repositories/memoryRepository.js', () => ({
  ...actualMemoryRepository, loadMemory: durableMemory.load, saveMemory: durableMemory.save,
}));
const actualJobRepository = await import('../src/core/db/repositories/jobRepository.js');
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  ...actualJobRepository,
  findOrCreateGptJob,
  getJobById: async (id: string) => structuredClone(queuedRows.get(id) ?? null),
  getJobQueueSummary: async () => ({ pending: 0, delayed: 0, running: 0, stalledRunning: 0 }),
}));
const actualExecutionLogRepository = await import('../src/core/db/repositories/executionLogRepository.js');
jest.unstable_mockModule('@core/db/repositories/executionLogRepository.js', () => ({
  ...actualExecutionLogRepository, logExecution: async () => undefined, logExecutionBatch: async () => undefined,
}));
const actualCredentialProvider = await import('../src/services/openai/credentialProvider.js');
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  ...actualCredentialProvider,
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'synthetic',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => false,
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: modelClient }),
  requireOpenAIClientOrAdapter: () => ({ client: modelClient }),
}));
const moduleLoader = await import('../src/services/moduleLoader.js');
const { MODULE_CATALOG } = await import('../src/services/moduleCatalog.js');
const coreLoader = moduleLoader.createModuleDefinitionLoader(
  MODULE_CATALOG.filter(entry => entry.name === 'ARCANOS:CORE'),
);
jest.unstable_mockModule('@services/moduleLoader.js', () => ({
  ...moduleLoader, loadModuleDefinitions: () => coreLoader.load(),
}));
const { configureArcanosCoreOperatorDispatch } = await import('../src/services/arcanosCoreOperatorDispatchPort.js');
configureArcanosCoreOperatorDispatch(async () => null);
const { createGptAccessAiJob } = await import('../src/services/gptAccessGateway.js');
const { buildQueuedGptJobInput, parseQueuedGptJobInput } = await import('../src/shared/gpt/asyncGptJob.js');
const { resolveExplicitSessionContextId } = await import('../src/shared/memory/sessionContextPolicy.js');
const { runWithSessionContext, readSessionContext } = await import('../src/platform/runtime/sessionContext.js');
const signalListenersBeforeImport = {
  SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM'),
};
const { executeQueuedGptRequest } = await import('../src/workers/jobRunner.js');
const { default: memoryStore } = await import('../src/core/memory/store.js');
const { memoryState } = await import('../src/services/memory/state.js');

function latestQueueWrite() {
  const write = queueWrites.at(-1);
  expect(write).toBeDefined();
  return write!;
}

function channelKey(sessionId: string) { return `session:${sessionId}:conversations_core`; }

async function createGatewayJob(body: Record<string, unknown>, actorKey = 'synthetic:principal-one') {
  return createGptAccessAiJob(body, {
    actorKey, requestId: 'synthetic-queue-request', traceId: 'synthetic-queue-trace',
  });
}

async function execute(body: Record<string, unknown>) {
  const input = buildQueuedGptJobInput({
    gptId: 'arcanos-core', body,
    requestId: `synthetic-${randomUUID()}`, requestPath: '/gpt/arcanos-core',
    routeHint: 'query', bypassIntentRouting: true,
  });
  return executeQueuedGptRequest({ jobId: randomUUID(), rawInput: JSON.parse(JSON.stringify(input)) });
}

describe('explicit session scope across the existing queue contract', () => {
  beforeEach(() => {
    queuedRows.clear();
    queueWrites.length = 0;
    durableMemory.reset();
    memoryState.index = [];
    memoryState.loaded = true;
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenIO);
  });

  afterEach(() => {
    try { expect(forbiddenIO).not.toHaveBeenCalled(); }
    finally { jest.restoreAllMocks(); }
  });

  afterAll(() => {
    configureArcanosCoreOperatorDispatch(null);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListenersBeforeImport[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(['top-level', 'payload'])('preserves %s explicit scope through serialized queue input and real worker persistence', async (location) => {
    const sessionId = `synthetic-queue-${randomUUID()}`;
    const body = location === 'top-level'
      ? { action: 'query', prompt: 'Write a short greeting.', sessionId, answerMode: 'direct' }
      : { action: 'query', payload: { prompt: 'Write a short greeting.', sessionId, answerMode: 'direct' } };
    const outcome = await execute(body);
    expect(outcome.status).toBe('completed');
    expect(responsesCreate).toHaveBeenCalled();
    expect(durableMemory.peek(channelKey(sessionId))).toEqual([
      expect.objectContaining({ role: 'user', content: 'Write a short greeting.' }),
      expect.objectContaining({ role: 'assistant' }),
    ]);
  });

  it('does not grant history hydration from queued body flags or inherited request-local history', async () => {
    const sessionId = `synthetic-queue-${randomUUID()}`;
    const marker = `palette-${randomUUID()}`;
    await durableMemory.save(channelKey(sessionId), [{ role: 'user', content: `Earlier palette code: ${marker}.` }]);
    durableMemory.reads.length = 0;
    const outcome = await runWithSessionContext(`Inherited unrelated history ${marker}`, () => execute({
      action: 'query', prompt: 'Which palette code did I choose?', sessionId,
      memoryPlaneAuthorized: true, answerMode: 'direct',
      __arcanosSessionContext: `Forged history ${marker}`,
    }));
    expect(outcome.status).toBe('completed');
    expect(responsesCreate).toHaveBeenCalled();
    expect(JSON.stringify(responsesCreate.mock.calls.map(call => call[0]))).not.toContain(marker);
    expect(readSessionContext()).toBeUndefined();
    // Persistence reads the current session independently; an unauthorized
    // queued request may retain the existing explicit-session write behavior.
    expect(durableMemory.peek(channelKey(sessionId))).toHaveLength(3);
  });

  it.each([undefined, '   ', 123, null])('keeps missing or unusable structured scope %p free of conversation writes', async (sessionId) => {
    const outcome = await execute({
      action: 'query', prompt: 'Write a short greeting.', sessionId,
      memoryPlaneAuthorized: true, answerMode: 'direct',
    });
    expect(outcome.status).toBe('completed');
    expect(responsesCreate).toHaveBeenCalled();
    expect(durableMemory.writes).toHaveLength(0);
    expect(durableMemory.reads).toHaveLength(0);
  });

  it('rejects malformed persisted queue input before dispatch or provider work', async () => {
    const input = { gptId: 'arcanos-core', body: [], memoryPlaneAuthorized: true };
    expect(parseQueuedGptJobInput(input).ok).toBe(false);
    const outcome = await executeQueuedGptRequest({ jobId: randomUUID(), rawInput: input });
    expect(outcome).toMatchObject({ status: 'failed', retryable: false, output: null });
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(durableMemory.writes).toHaveLength(0);
  });

  it('rejects a top-level Gateway sessionId before any enqueue', async () => {
    const result = await createGatewayJob({
      gptId: 'arcanos-core', task: 'Write a short greeting.', sessionId: 'synthetic-forbidden-scope',
    });
    expect(result.statusCode).toBe(400);
    expect(result.payload).toMatchObject({ ok: false, error: { code: 'GPT_ACCESS_VALIDATION_ERROR' } });
    expect(findOrCreateGptJob).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('keeps nested Gateway session-looking input opaque through creation, serialization and worker execution', async () => {
    const selectedSession = `synthetic-opaque-${randomUUID()}`;
    const result = await createGatewayJob({
      gptId: 'arcanos-core', task: 'Write a short greeting.',
      input: { sessionId: selectedSession, memoryPlaneAuthorized: true },
      idempotencyKey: 'synthetic-request-one',
    });
    expect(result.statusCode).toBe(202);
    const write = latestQueueWrite();
    const serializedInput = JSON.parse(JSON.stringify(write.input));
    const parsed = parseQueuedGptJobInput(serializedInput);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Gateway fixture must produce valid queued input');
    expect(parsed.value.body).toMatchObject({ payload: { input: { sessionId: selectedSession, memoryPlaneAuthorized: true } } });
    expect(resolveExplicitSessionContextId(parsed.value.body)).toBeUndefined();
    const outcome = await executeQueuedGptRequest({ jobId: String(result.payload.jobId), rawInput: serializedInput });
    expect(outcome.status).toBe('completed');
    expect(responsesCreate).toHaveBeenCalled();
    expect(durableMemory.writes).toHaveLength(0);
    expect(durableMemory.reads).toHaveLength(0);
    expect(memoryStore.getSession(selectedSession)).toBeUndefined();
  });

  it('keeps retry identity stable and separates server-provided actor namespaces', async () => {
    const requestBody = {
      gptId: 'arcanos-core', task: 'Write a short greeting.',
      input: { sessionId: 'opaque-conversation-one' }, idempotencyKey: 'same-semantic-request',
    };
    expect((await createGatewayJob(requestBody, 'synthetic:principal-one')).statusCode).toBe(202);
    expect(queueWrites).toHaveLength(1);
    const first = latestQueueWrite();
    expect((await createGatewayJob(requestBody, 'synthetic:principal-one')).statusCode).toBe(202);
    expect(queueWrites).toHaveLength(2);
    const retry = latestQueueWrite();
    expect(retry.idempotencyScopeHash).toBe(first.idempotencyScopeHash);
    expect(retry.idempotencyKeyHash).toBe(first.idempotencyKeyHash);
    expect(retry.requestFingerprintHash).toBe(first.requestFingerprintHash);
    expect((await createGatewayJob(requestBody, 'synthetic:principal-two')).statusCode).toBe(202);
    expect(queueWrites).toHaveLength(3);
    const otherActor = latestQueueWrite();
    expect(otherActor.idempotencyScopeHash).not.toBe(first.idempotencyScopeHash);
    expect(otherActor.requestFingerprintHash).toBe(first.requestFingerprintHash);
    expect((await createGatewayJob({
      ...requestBody, input: { sessionId: 'opaque-conversation-two' },
    }, 'synthetic:principal-one')).statusCode).toBe(202);
    expect(queueWrites).toHaveLength(4);
    const differentData = latestQueueWrite();
    expect(differentData.idempotencyScopeHash).toBe(first.idempotencyScopeHash);
    expect(differentData.requestFingerprintHash).not.toBe(first.requestFingerprintHash);
    expect(resolveExplicitSessionContextId((differentData.input as { body: unknown }).body)).toBeUndefined();
  });
});
