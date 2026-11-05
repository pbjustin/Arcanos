/**
 * Native Windows CLI -> real HTTP, GPT router, dispatcher, registry, CORE,
 * Trinity DIRECT_ANSWER, Responses mapper, reserved job execution and job reads.
 * Reuses the session-context E2E provider/KV isolation and the native CLI fixture.
 * Provider transport, database I/O and optional side effects are synthetic.
 * This is not live-provider, PostgreSQL, full-startup or production evidence.
 */
import express from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobData } from '../src/core/db/schema.js';
import type { FindOrCreateGptJobOptions, UpdateClaimedJobTerminalOptions } from '../src/core/db/repositories/jobRepository.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';
import { issueJobReadCapability } from '../src/shared/jobs/jobReadCapability.js';
import { createDaemonStore } from '../src/routes/daemonStore.js';
import { afterAll, expect, it, jest } from '@jest/globals';
import {
  createSyntheticDurableMemory,
  type SyntheticResponsesRequest,
} from './fixtures/session-context-e2e.js';

const durableMemory = createSyntheticDurableMemory();
const answer = 'I can explain ideas and help you plan.\n\n### Audit Summary\nRequested public report — café 雪.\n\n### COMPLIANCE STATUS\nThe supplied draft remains under review.';
let releaseProvider = () => {};
let providerCompletion = Promise.resolve();
let providerStatus: 'completed' | 'incomplete' = 'completed';
const responsesCreate = jest.fn(async (input: SyntheticResponsesRequest) => {
  await providerCompletion;
  return { id: 'synthetic-continuation-response', model: input.model, created_at: 1_790_000_000,
    status: providerStatus, output_text: answer, output: [],
    ...(providerStatus === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144 } };
});
const forbiddenIO = jest.fn(() => { throw new Error('Unexpected external/queue I/O in session fixture'); });
const recordConversationSnippet = jest.fn(async () => undefined);
const modelClient = {
  models: { retrieve: jest.fn(async (id: string) => ({ id })) },
  responses: { create: responsesCreate },
};
const environmentKeys = [
  ...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES, 'GPT_ASYNC_HEAVY_PROMPT_CHARS',
  'GPT_ROUTE_ASYNC_CORE_DEFAULT', 'GPT_DIRECT_EXECUTION_THRESHOLD_MS', 'GPT_ASYNC_WAIT_POLL_MS',
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID', 'ARCANOS_CONTROL_PLANE_SCOPES', 'DAEMON_REGISTRY_RATE_LIMIT_MAX',
  'PRIORITY_QUEUE_ENABLED', 'GPT_MODULE_MAP', 'GPTID_CORE', 'GPT_FAST_PATH_ENABLED',
  'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG', 'PUBLIC_PROVIDER_RATE_LIMIT_MAX',
  'PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX', 'OPENAI_STORE',
  'FINETUNED_MODEL_ID',
] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const accessToken = `synthetic-memory-${'q'.repeat(48)}`;
const daemonToken = 'synthetic-real-chain-daemon-token-1234567890';
const peerToken = 'synthetic-real-chain-control-token-1234567890';
const genericToken = 'synthetic-real-chain-writing-token-1234567890';
const secret = randomBytes(32).toString('hex');
const jobId = '51883102-2222-4222-8222-222222222222';
for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) delete process.env[name];
process.env.ARCANOS_MEMORY_ACCESS_TOKEN = accessToken;
process.env.GPT_ASYNC_HEAVY_PROMPT_CHARS = '1200';
process.env.PRIORITY_QUEUE_ENABLED = 'true';
process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'true';
process.env.GPT_DIRECT_EXECUTION_THRESHOLD_MS = '250';
process.env.GPT_ASYNC_WAIT_POLL_MS = '50';
process.env.GPT_FAST_PATH_ENABLED = 'false';
process.env.ARCANOS_DAEMON_ACCESS_TOKEN = daemonToken;
process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = peerToken;
process.env.ARCANOS_GPT_ACCESS_TOKEN = genericToken;
process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = secret;
process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'real-chain-fixture';
process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
process.env.DAEMON_REGISTRY_RATE_LIMIT_MAX = '200';
process.env.PUBLIC_PROVIDER_RATE_LIMIT_MAX = '1000';
process.env.PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX = '999';
process.env.OPENAI_STORE = 'false';
process.env.FINETUNED_MODEL_ID = 'ft:synthetic:session-context-authority';
delete process.env.GPT_MODULE_MAP;
delete process.env.GPTID_CORE;
delete process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;

const { AUDITED_TRANSIENT_READ_QUERIES } = await import('../src/core/db/transientReadRegistry.js');
jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  loadMemory: durableMemory.load,
  saveMemory: durableMemory.save,
  ...Object.fromEntries([
    'applyBackstageRosterMutation', 'applyBackstageStorylineMutation', 'close',
    'createJob', 'deleteMemory', 'getLatestJob', 'getMemoryRecordByKey',
    'getMemoryRecordByLegacyRowId', 'getMemoryRecordByRecordId', 'getPool',
    'initializeDatabase', 'initializeDatabaseWithSchema', 'loadMemoryRecordById',
    'logExecution', 'logExecutionBatch', 'query', 'saveRagDoc', 'transaction', 'updateJob',
  ].map(name => [name, forbiddenIO])),
  getStatus: () => ({ connected: false, hasPool: false, error: null }),
  isDatabaseConnected: () => false,
  isDatabaseSchemaReady: () => false,
  isTransactionCommitAmbiguousError: () => false,
  loadAllRagDocs: async () => [],
  loadRagDocsByIds: async () => [],
}));
const actualCredentialProvider = await import('../src/services/openai/credentialProvider.js');
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  ...actualCredentialProvider,
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'synthetic',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true,
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: modelClient }),
  requireOpenAIClientOrAdapter: () => ({ client: modelClient }),
}));
jest.unstable_mockModule('@services/webRag.js', () => ({
  recordConversationSnippet,
  queryRag: forbiddenIO,
  queryRagWithDiagnostics: forbiddenIO,
  queryRagDocuments: forbiddenIO,
  recordPersistentMemorySnippet: forbiddenIO,
  ingestContent: forbiddenIO,
  ingestUrl: forbiddenIO,
  answerQuestion: forbiddenIO,
}));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern: jest.fn(),
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn(),
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: async () => ({ enabled: false, attempted: false, reason: 'synthetic' }),
}));
const conversationJobs = new Map<string, JobData>();

class FixtureJobRepositoryUnavailableError extends Error {}
jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: class extends Error {},
  JobRepositoryUnavailableError: FixtureJobRepositoryUnavailableError,
  findOrCreateGptJob: async (options: FindOrCreateGptJobOptions) => {
    const now = new Date();
    const job: JobData = {
      id: jobId, worker_id: options.workerId, job_type: 'gpt',
      status: options.createOptions.status ?? 'pending', claim_generation: '1',
      input: structuredClone(options.input), output: null, created_at: now, updated_at: now,
      last_worker_id: options.createOptions.lastWorkerId,
      lease_expires_at: new Date(Date.now() + 30_000),
      idempotency_scope_hash: options.idempotencyScopeHash,
      retention_until: new Date(Date.now() + 60_000),
    };
    conversationJobs.set(job.id, job);
    return { job, created: true, deduped: false, dedupeReason: 'new_job' };
  },
  getJobById: async (id: string) => structuredClone(conversationJobs.get(id) ?? null),
  createClaimedJobFence: (workerId: string, claimGeneration: string) => ({ workerId, claimGeneration }),
  recordJobHeartbeat: async (id: string) => conversationJobs.get(id) ?? null,
  updateClaimedJobTerminal: async (id: string, status: string, options: UpdateClaimedJobTerminalOptions) => {
    const job = conversationJobs.get(id);
    if (!job || job.last_worker_id !== options.fence.workerId || job.claim_generation !== options.fence.claimGeneration) return null;
    job.status = status; job.output = structuredClone(options.output); job.completed_at = new Date();
    job.updated_at = new Date();
    if (options.errorMessage) job.error_message = options.errorMessage;
    return job;
  },
  normalizeJobClaimGeneration: (value: string) => value,
  requestJobCancellation: jest.fn(), createJob: jest.fn(), updateJob: jest.fn(),
  claimNextPendingJob: jest.fn(), claimNextPendingJobWithAdmission: jest.fn(),
  failPendingJobIfUnclaimed: jest.fn(), scheduleJobRetry: jest.fn(),
  deferJobForProviderRecovery: jest.fn(), recoverStaleJobs: jest.fn(),
  recoverStalledJobsForWorkers: jest.fn(), resolveJobWorkerStaleAfterMs: () => 45_000,
  getLatestJob: jest.fn(), listFailedJobs: async () => [], requeueFailedJob: jest.fn(),
  getJobQueueSummary: jest.fn(), getJobExecutionStatsSince: jest.fn(),
  cleanupExpiredGptJobs: async () => ({ expiredPending: 0, expiredTerminal: 0, deletedExpired: 0 }),
}));
jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: async () => ({ status: 'pending', planningReasons: ['controlled-http-fixture'] }),
  getWorkerAutonomyHealthReport: async () => ({ status: 'ok', workers: [] }),
  getWorkerAutonomySettings: () => ({ enabled: false, mode: 'off' }),
}));

const auditSafe = await import('../src/services/auditSafe.js');
jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...auditSafe, logAITaskLineage: jest.fn() }));
const moduleLoader = await import('../src/services/moduleLoader.js');
const { MODULE_CATALOG } = await import('../src/services/moduleCatalog.js');
const coreLoader = moduleLoader.createModuleDefinitionLoader(
  MODULE_CATALOG.filter(entry => entry.name === 'ARCANOS:CORE'),
);
jest.unstable_mockModule('@services/moduleLoader.js', () => ({ ...moduleLoader, loadModuleDefinitions: () => coreLoader.load() }));

const daemonStore = createDaemonStore({
  fs: { existsSync: () => false, readFileSync, writeFileSync: () => undefined, mkdirSync: () => undefined },
  path: { dirname: path.dirname }, tokensFilePath: 'unused-real-chain-daemon-store.json',
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, now: () => new Date(),
});
jest.unstable_mockModule('@routes/api-daemon/context.js', () => ({ daemonStore }));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({ recordJobEvent: async () => undefined }));

const { configureArcanosCoreOperatorDispatch } = await import('../src/services/arcanosCoreOperatorDispatchPort.js');
configureArcanosCoreOperatorDispatch(async () => null);
const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { default: apiDaemonRouter } = await import('../src/routes/api-daemon.js');
const { default: systemStateRouter } = await import('../src/routes/system-state.js');
const { default: jobsRouter } = await import('../src/routes/jobs.js');
const { default: errorHandler } = await import('../src/transport/http/middleware/errorHandler.js');

afterAll(() => {
  releaseProvider();
  configureArcanosCoreOperatorDispatch(null);
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

(process.platform === 'win32' ? it : it.skip).each(['completed', 'incomplete'] as const)(
  'handles a %s real CORE DIRECT_ANSWER over HTTP 202 continuation in native Windows', async status => {
  providerStatus = status; responsesCreate.mockClear(); conversationJobs.clear(); durableMemory.reset();
  providerCompletion = new Promise<void>(resolve => { releaseProvider = resolve; });
  const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-real-continuation-'));
  const evidence = path.resolve('tmp/conversation-continuation');
  mkdirSync(evidence, { recursive: true });
  const observed: Array<{ method: string; path: string; status?: number; reason?: string; capabilityBound?: boolean }> = [];
  let originalBody: Record<string, unknown> | undefined;
  const app = express();
  app.use(requestContext); app.use(express.json());
  app.use((req, res, next) => {
    const row: (typeof observed)[number] = { method: req.method, path: req.path };
    observed.push(row);
    if (req.path === '/gpt/arcanos-daemon') originalBody = req.body;
    if (req.path.startsWith('/jobs/')) {
      row.capabilityBound = req.get('x-arcanos-job-read-token') === issueJobReadCapability(jobId, secret)
        && req.originalUrl === `/jobs/${jobId}/result` && !req.get('x-arcanos-daemon-token');
      res.once('finish', releaseProvider);
    }
    res.once('finish', () => {
      row.status = res.statusCode;
      if (row.path.startsWith('/gpt/')) row.reason = String(res.getHeader('x-gpt-route-decision-reason'));
    });
    next();
  });
  app.use(apiDaemonRouter); app.use(systemStateRouter); app.use('/gpt', gptRouter); app.use(jobsRouter); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  const scenarioPath = path.join(sandbox, 'scenario.json');
  const receiptPath = path.join(evidence, `native-real-core-${status}.json`);
  writeFileSync(scenarioPath, JSON.stringify({
    name: 'real dispatcher CORE Trinity Responses continuation', tty: true, heartbeat: false,
    credentials: { daemon: daemonToken, control: peerToken, gpt: genericToken },
    sensitiveMarkers: [issueJobReadCapability(jobId, secret)],
    steps: [{ input: 'what can u do?' }, { input: `/resume ${jobId}` },
      { input: `/resume ${jobId}`, waitBeforeMs: 150, faultBefore: 'expire' },
      { input: `/resume ${jobId}` }, { input: '/exit' }],
    extraEnv: { BACKEND_FALLBACK_TO_LOCAL: 'true' },
  }));
  const python = process.env.PYTHON_EXECUTABLE || 'python';
  const userSite = spawnSync(python, ['-c', 'import site; print(site.getusersitepackages())'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(userSite.status).toBe(0);
  const launch = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenIO);
  try {
    const processResult = await new Promise<{ exit: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(python, ['-B', fileURLToPath(new URL('./fixtures/daemon_registry_client.py', import.meta.url)),
        '--native', fileURLToPath(new URL('../daemon-python', import.meta.url)), `http://127.0.0.1:${address.port}`, scenarioPath, receiptPath], {
        cwd: sandbox, env: { ...launch, PYTHONIOENCODING: 'utf-8', ACCEPTANCE_PYTHON_USER_SITE: userSite.stdout.trim() },
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 50_000,
      });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject); child.once('close', exit => resolve({ exit, stderr }));
    });
    expect(processResult).toEqual({ exit: 0, stderr: '' });
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const output = conversationJobs.get(jobId)?.output as Record<string, unknown> | undefined;
    const storedInput = conversationJobs.get(jobId)?.input as Record<string, unknown> | undefined;
    const result = output?.result as { result?: string; meta?: { auditFlags?: string[] } } | undefined;
    const proof = {
      routing: 'real gptRouter -> real dispatcher/registry/CORE -> Trinity -> Responses mapper',
      observed, generationRequests: observed.filter(row => row.method === 'POST' && row.path.startsWith('/gpt/')).length,
      responsesProviderCalls: responsesCreate.mock.calls.length, storedStatus: conversationJobs.get(jobId)?.status,
      asyncSelectionReason: storedInput?.executionModeReason,
      originalShape: originalBody?.prompt === 'what can u do?' && originalBody?.action === undefined && originalBody?.executionMode === undefined,
      outerPresentation: output?.presentation, storedAnswer: result?.result,
      fullDisplayed: receipt.printed_output.includes(answer), historyCount: receipt.history.length,
      finalTrust: receipt.final_state.trust, noLeaks: Object.values(receipt.leaks).every(value => value === false),
    };
    writeFileSync(path.join(evidence, `real-core-${status}-proof.json`), JSON.stringify(proof, null, 2));
    console.log('[ARCANOS_REAL_CORE_CONTINUATION] ' + JSON.stringify(proof));
    expect(proof.generationRequests).toBe(1); expect(proof.responsesProviderCalls).toBe(1);
    expect(proof.originalShape).toBe(true); expect(proof.noLeaks).toBe(true); expect(proof.finalTrust).toBe('DEGRADED');
    if (status === 'completed') {
      expect(proof.storedStatus).toBe('completed'); expect(proof.outerPresentation).toBe('public-answer-v1');
      expect(proof.storedAnswer).toBe(answer); expect(proof.fullDisplayed).toBe(true);
      expect(receipt.history).toHaveLength(1); expect(receipt.history[0]).toMatchObject({ user: 'what can u do?', ai: answer });
    } else {
      expect(proof.storedStatus).toBe('failed'); expect(proof.outerPresentation).toBeUndefined();
      expect(proof.fullDisplayed).toBe(false); expect(receipt.history).toHaveLength(0);
    }
    expect(observed.filter(row => row.path.startsWith('/gpt/'))).toMatchObject([{ status: 202 }]);
    expect(proof.asyncSelectionReason).toBe('core_query_async_default');
    expect(responsesCreate.mock.calls[0][0]).toMatchObject({ model: 'ft:synthetic:session-context-authority', max_output_tokens: 1000 });
    expect(observed.filter(row => row.path.startsWith('/jobs/'))).toEqual([
      { method: 'GET', path: `/jobs/${jobId}/result`, status: 200, capabilityBound: true },
      { method: 'GET', path: `/jobs/${jobId}/result`, status: 200, capabilityBound: true },
    ]);
    expect(receipt.observations.filter((row: { event: string }) => row.event === 'job_read_response'))
      .toMatchObject([{ status: 'pending', has_result: false }, { status: status === 'completed' ? 'completed' : 'failed', has_result: true }]);
    expect(receipt.audits.filter((row: { event: string }) => row.event === 'execute_success')).toHaveLength(status === 'completed' ? 1 : 0);
    expect(receipt.observations.filter((row: { event: string }) => row.event === 'local_generation_attempt')).toHaveLength(0);
    expect(forbiddenIO).not.toHaveBeenCalled();
  } finally {
    releaseProvider(); fetchSpy.mockRestore(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 70_000);
