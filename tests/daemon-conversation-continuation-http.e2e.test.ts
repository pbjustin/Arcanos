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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JobData } from '../src/core/db/schema.js';
import type { FindOrCreateGptJobOptions, UpdateClaimedJobTerminalOptions } from '../src/core/db/repositories/jobRepository.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';
import { afterAll, expect, it, jest } from '@jest/globals';
import {
  createSyntheticDurableMemory,
  type SyntheticResponsesRequest,
} from './fixtures/session-context-e2e.js';

const durableMemory = createSyntheticDurableMemory();
const answer = 'I can explain ideas and help you plan.\n\n### Audit Summary\nRequested public report — café 雪.\n\n### COMPLIANCE STATUS\nThe supplied draft remains under review.';
const secondQuestion = 'What can you do with a second question?';
const secondAnswer = 'This answer belongs to the second original conversation.';
const terminalMessages: Record<string, string> = {
  failed: 'The original conversation job failed.',
  cancelled: 'The original conversation job was cancelled.',
  expired: 'The original conversation job has expired.',
  lost_output: 'The completed job has no retained output. The original answer is unavailable.',
  invalid_capability: 'The original conversation job is unavailable or inaccessible.',
  tampered_storage: 'Automatic conversation recovery is unavailable; protected storage and backend authentication are required.',
  different_backend: 'Automatic conversation recovery is unavailable; protected storage and backend authentication are required.',
  different_user: 'Automatic conversation recovery is unavailable; protected storage and backend authentication are required.',
};
let multipleProviderAnswers = false;
let acceptedWaitStorageOutage = false;
let acceptedWaitStorageOutages = 0;
let releaseProvider = () => {};
let providerCompletion = Promise.resolve();
let providerStatus: 'completed' | 'incomplete' = 'completed';
const responsesCreate = jest.fn(async (input: SyntheticResponsesRequest) => {
  await providerCompletion;
  return { id: 'synthetic-continuation-response', model: input.model, created_at: 1_790_000_000,
    status: providerStatus, output_text: multipleProviderAnswers && JSON.stringify(input.input).includes(secondQuestion) ? secondAnswer : answer, output: [],
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
  'GPT_PRIORITY_DIRECT_EXECUTION_CONCURRENCY',
] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
const accessToken = `synthetic-memory-${'q'.repeat(48)}`;
const daemonToken = 'synthetic-real-chain-daemon-token-1234567890';
const peerToken = 'synthetic-real-chain-control-token-1234567890';
const genericToken = 'synthetic-real-chain-writing-token-1234567890';
const secret = randomBytes(32).toString('hex');
const jobId = '51883102-2222-4222-8222-222222222222';
const secondJobId = '51883102-3333-4333-8333-333333333333';
let nextJobId = jobId;
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

// Apply this fixture's supported admission configuration before importing any
// backend module that snapshots runtime configuration.
const { issueJobReadCapability } = await import('../src/shared/jobs/jobReadCapability.js');
const { createDaemonStore } = await import('../src/routes/daemonStore.js');
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
      id: nextJobId, worker_id: options.workerId, job_type: 'gpt',
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
  getJobById: async (id: string) => {
    if (acceptedWaitStorageOutage) {
      acceptedWaitStorageOutage = false;
      acceptedWaitStorageOutages += 1;
      throw new FixtureJobRepositoryUnavailableError('Synthetic accepted-job wait storage outage');
    }
    return structuredClone(conversationJobs.get(id) ?? null);
  },
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
  const python = process.env.PYTHON_EXECUTABLE || 'python';
  const userSite = spawnSync(python, ['-c', 'import site; print(site.getusersitepackages())'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(userSite.status).toBe(0);
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
    sensitiveMarkers: [issueJobReadCapability(jobId, secret), issueJobReadCapability(secondJobId, secret),
      issueJobReadCapability(jobId, 'synthetic-invalid-job-read-key')],
    steps: [{ input: 'what can u do?' }, { input: `/resume ${jobId}` },
      { input: `/resume ${jobId}`, waitBeforeMs: 150, faultBefore: 'expire' },
      { input: `/resume ${jobId}` }, { input: '/exit' }],
    extraEnv: { BACKEND_FALLBACK_TO_LOCAL: 'true' },
  }));
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

/** Launch the existing guarded public CLI fixture without replacing HTTP, input or recovery. */
async function runAutomaticCliCase(
  python: string, userSite: string, sandbox: string, baseUrl: string,
  label: string, scenario: Record<string, unknown>,
) {
  const scenarioPath = path.join(sandbox, label + '-scenario.json');
  const receiptPath = path.join(sandbox, label + '-receipt.json');
  writeFileSync(scenarioPath, JSON.stringify({
    name: label, tty: true, heartbeat: false,
    credentials: { daemon: daemonToken, control: peerToken, gpt: genericToken },
    sensitiveMarkers: [issueJobReadCapability(jobId, secret)],
    extraEnv: { CONVERSATION_RECOVERY_ENABLED: 'true', BACKEND_FALLBACK_TO_LOCAL: 'true' },
    ...scenario,
  }));
  const launch = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ACCEPTANCE_EXTRA_PYTHON_SITE']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]),
  );
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-B', fileURLToPath(new URL('./fixtures/daemon_registry_client.py', import.meta.url)),
      '--native', fileURLToPath(new URL('../daemon-python', import.meta.url)), baseUrl, scenarioPath, receiptPath], {
      cwd: sandbox, env: { ...launch, PYTHONIOENCODING: 'utf-8', ACCEPTANCE_PYTHON_USER_SITE: userSite },
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 55_000,
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  });
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const receiptEvidence = path.resolve('tmp/automatic-continuation');
  mkdirSync(receiptEvidence, { recursive: true });
  writeFileSync(path.join(receiptEvidence, label + '-receipt.json'), JSON.stringify(receipt, null, 2));
  expect({ label, ...result, failure: receipt.failure }).toEqual({ label, code: 0, stderr: '', failure: null });
  expect(receipt.public_entrypoint).toBe(true);
  expect(receipt.transport).toBe('Windows ConPTY');
  expect(Object.values(receipt.leaks).every(value => value === false)).toBe(true);
  expect(receipt.cleanup.forced_termination).toBe(false);
  expect(receipt.final_state.terminal_handle_restored).toBe(true);
  expect(receipt.observations.filter((row: { event: string }) => row.event === 'local_generation_attempt')).toHaveLength(0);
  expect(receipt.speech).toHaveLength(0);
  return receipt;
}

/** Exercise local crash boundaries with real HTTP, DPAPI and history in fresh processes. */
async function runRecoveryFaultCase(
  python: string, userSite: string, sandbox: string, baseUrl: string, mode: string,
) {
  const launch = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ACCEPTANCE_EXTRA_PYTHON_SITE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-B', fileURLToPath(new URL('./fixtures/conversation_recovery_http_faults.py', import.meta.url)),
      '--mode', mode, '--daemon-root', fileURLToPath(new URL('../daemon-python', import.meta.url)),
      '--base-url', baseUrl, '--data-dir', path.join(sandbox, 'fault-profile')], {
      cwd: sandbox, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      env: { ...launch, PYTHONIOENCODING: 'utf-8', ACCEPTANCE_PYTHON_USER_SITE: userSite,
        ARCANOS_GPT_ACCESS_TOKEN: genericToken, ARCANOS_DAEMON_ACCESS_TOKEN: daemonToken,
        ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: peerToken },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const receipt = JSON.parse(result.stdout);
  const evidence = path.resolve('tmp/automatic-continuation');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, mode + '-fault-receipt.json'), JSON.stringify(receipt, null, 2));
  expect(receipt.no_capability_leaks).toBe(true);
  return receipt;
}

/** Observe two actual public CLI processes sharing the same Windows protected profile. */
async function runOwnershipCase(python: string, userSite: string, sandbox: string, baseUrl: string, mode: string) {
  const launch = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ACCEPTANCE_EXTRA_PYTHON_SITE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-B', fileURLToPath(new URL('./fixtures/conversation_recovery_multiprocess.py', import.meta.url)),
      '--mode', mode, '--daemon-root', fileURLToPath(new URL('../daemon-python', import.meta.url)),
      '--base-url', baseUrl, '--sandbox', sandbox], {
      cwd: sandbox, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...launch, PYTHONIOENCODING: 'utf-8', ACCEPTANCE_PYTHON_USER_SITE: userSite,
        ARCANOS_GPT_ACCESS_TOKEN: genericToken, ARCANOS_DAEMON_ACCESS_TOKEN: daemonToken,
        ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: peerToken },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const receipt = JSON.parse(result.stdout);
  const evidence = path.resolve('tmp/automatic-continuation');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'process-owner-' + mode + '-receipt.json'), JSON.stringify(receipt, null, 2));
  expect(receipt.failure).toBeNull();
  expect(receipt.credential_leaks).toBe(false);
  expect(JSON.stringify(receipt)).not.toContain(issueJobReadCapability(jobId, secret));
  return receipt;
}

(process.platform === 'win32' ? it : it.skip).each([
  'automatic', 'restart', 'temporary_503', 'wait_storage_outage', 'backend_restart', 'multiple',
  'failed', 'cancelled', 'expired', 'lost_output', 'invalid_capability',
  'tampered_storage', 'different_backend',
  'duplicate_worker', 'before_commit', 'after_commit', 'partial_render',
  'synchronous', 'offline',
  'different_user',
  'process_owner_live', 'process_owner_same_session', 'process_owner_exit', 'process_owner_crash', 'process_owner_restart',
  'quota_pending',
] as const)(
  'delivers the original answer automatically with %s recovery and no resume command', async mode => {
    const python = process.env.PYTHON_EXECUTABLE || 'python';
    const userSite = spawnSync(python, ['-c', 'import site; print(site.getusersitepackages())'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    expect(userSite.status).toBe(0);
    providerStatus = 'completed'; responsesCreate.mockClear(); conversationJobs.clear(); durableMemory.reset();
    nextJobId = jobId;
    acceptedWaitStorageOutage = mode === 'wait_storage_outage';
    acceptedWaitStorageOutages = 0;
    multipleProviderAnswers = mode === 'multiple';
    process.env.GPT_PRIORITY_DIRECT_EXECUTION_CONCURRENCY = mode === 'multiple' ? '2' : '1';
    providerCompletion = mode === 'synchronous' ? Promise.resolve() : new Promise<void>(resolve => { releaseProvider = resolve; });
    const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-automatic-continuation-'));
    const observed: Array<{ method: string; path: string; status?: number; capabilityBound?: boolean }> = [];
    const startupSnapshots: Record<string, unknown> = {};
    let restartedBackend: ReturnType<typeof spawn> | undefined;
    const restartedStartupReads: Array<{ path: string; status: number }> = [];
    let alternateBackend: ReturnType<typeof app.listen> | undefined;
    let backendStartupError = '';
    let freshBackendPid: number | undefined;
    let childFinalCounters: { generationRequests: number; providerCalls: number; resultReads: number } | undefined;
    let resultReads = 0;
    let generationRequests = 0;
    let overlappingAcceptedJobs = false;
    let offlineRestart: ReturnType<typeof setTimeout> | undefined;
    let offlineReadOutage = false;
    const ownershipMode = mode.startsWith('process_owner_');
    const ownerRelease = (ownershipMode && !['process_owner_live', 'process_owner_same_session'].includes(mode)) || mode === 'quota_pending' ? setInterval(() => {
      if (existsSync(path.join(sandbox, 'owner-provider-release'))) releaseProvider();
    }, 20) : undefined;
    const app = express();
    app.use(requestContext); app.use(express.json());
    app.use((req, res, next) => {
      const row: (typeof observed)[number] = { method: req.method, path: req.path };
      observed.push(row);
      if (req.method === 'POST' && req.path.startsWith('/gpt/')) {
        generationRequests += 1;
        nextJobId = generationRequests === 2 ? secondJobId : jobId;
        if (mode === 'multiple' && generationRequests === 2) res.once('finish', () => {
          overlappingAcceptedJobs = [jobId, secondJobId].every(id => conversationJobs.get(id)?.status === 'running');
          releaseProvider();
        });
        if (mode === 'invalid_capability') {
          const json = res.json.bind(res);
          res.json = body => json(res.statusCode === 202
            ? { ...body, jobReadToken: issueJobReadCapability(jobId, 'synthetic-invalid-job-read-key') } : body);
        }
      }
      if (req.path === '/api/daemon/registry' || req.path === '/system-state') {
        const json = res.json.bind(res);
        res.json = body => { startupSnapshots[req.path] = structuredClone(body); return json(body); };
      }
      res.once('finish', () => { row.status = res.statusCode; });
      if (req.path.startsWith('/jobs/')) {
        resultReads += 1;
        const requestJobId = req.path.split('/')[2];
        row.capabilityBound = [jobId, secondJobId].includes(requestJobId)
          && req.get('x-arcanos-job-read-token') === issueJobReadCapability(requestJobId, secret)
          && req.originalUrl === `/jobs/${requestJobId}/result` && !req.get('x-arcanos-daemon-token');
        if (!['restart', 'backend_restart', 'tampered_storage', 'different_backend', 'different_user', 'multiple',
          'process_owner_exit', 'process_owner_crash', 'process_owner_restart', 'quota_pending'].includes(mode)) res.once('finish', releaseProvider);
        if (mode === 'temporary_503' && resultReads <= 2) {
          res.status(503).json({ error: 'JOB_REPOSITORY_UNAVAILABLE' });
          return;
        }
        const stored = conversationJobs.get(requestJobId);
        if (stored?.status === 'completed' && terminalMessages[mode]) {
          if (mode === 'failed' || mode === 'cancelled' || mode === 'expired') stored.status = mode;
          if (mode === 'lost_output') stored.output = null;
        }
        if (mode === 'offline' && resultReads === 1) res.once('finish', () => {
          server.closeAllConnections();
          server.close(() => {
            offlineReadOutage = true;
            offlineRestart = setTimeout(() => server.listen(address.port, '127.0.0.1'), 4_000);
          });
        });
      }
      next();
    });
    app.use(apiDaemonRouter); app.use(systemStateRouter); app.use('/gpt', gptRouter); app.use(jobsRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      let receipt;
      let beforeRestartReads = 0;
      const recoveryBlocked = ['tampered_storage', 'different_backend', 'different_user'].includes(mode);
      const faultMode = ['duplicate_worker', 'before_commit', 'after_commit', 'partial_render'].includes(mode);
      if (mode === 'quota_pending') {
        const quota = await runOwnershipCase(python, userSite.stdout.trim(), sandbox, baseUrl, 'quota');
        const origin = quota.processes.origin;
        const pending = origin.events.filter((event: { event: string }) => event.event === 'quota_observation');
        expect(quota.actual_conpty_processes).toBe(1);
        expect(pending).toHaveLength(2);
        for (const observation of pending) {
          expect(observation.usage.requests_this_hour).toBe(1);
          expect(observation.usage.tokens_today).toBe(0);
          expect(observation.usage.cost_today).toBe(0);
          expect(observation.history_count).toBe(0);
        }
        expect(origin.stdout).toContain('Hourly request limit reached (1)');
        expect(origin.answer_displayed).toBe(true);
        expect(quota.history).toHaveLength(1);
        expect(quota.durable_successes).toBe(1);
        writeFileSync(path.resolve('tmp/automatic-continuation', mode + '-counters.json'), JSON.stringify({
          generationRequests, providerCalls: responsesCreate.mock.calls.length, resultReads, observed,
        }, null, 2));
        receipt = { history: quota.history, rendered_terminal: origin.stdout, audits: origin.audits };
      } else if (ownershipMode) {
        const ownership = await runOwnershipCase(python, userSite.stdout.trim(), sandbox, baseUrl, mode.replace('process_owner_', ''));
        writeFileSync(path.resolve('tmp/automatic-continuation', mode + '-counters.json'), JSON.stringify({
          generationRequests, providerCalls: responsesCreate.mock.calls.length, resultReads, observed,
        }, null, 2));
        const origin = ownership.processes.origin;
        const observer = ownership.processes.observer;
        const originIdentity = origin.events.find((event: { event: string }) => event.event === 'owner_identity');
        const observerIdentity = observer.events.find((event: { event: string }) => event.event === 'owner_identity');
        expect(originIdentity.pid).not.toBe(observerIdentity.pid);
        if (mode === 'process_owner_same_session') expect(originIdentity.session_hash).toBe(observerIdentity.session_hash);
        else expect(originIdentity.session_hash).not.toBe(observerIdentity.session_hash);
        expect(originIdentity.sid_hash).toBe(observerIdentity.sid_hash);
        expect(ownership.history).toHaveLength(1);
        expect(ownership.history[0].session_hash).toBe(originIdentity.session_hash);
        expect(ownership.durable_successes).toBe(1);
        const originAlive = mode === 'process_owner_live' || mode === 'process_owner_same_session';
        expect(origin.answer_displayed).toBe(originAlive);
        expect(observer.answer_displayed).toBe(mode === 'process_owner_exit' || mode === 'process_owner_crash');
        if (originAlive) expect(observer.job_reads).toBe(0);
        if (mode === 'process_owner_exit') {
          const stopped = origin.events.find((event: { event: string }) => event.event === 'owner_stop_started');
          expect(observer.events.filter((event: { event: string }) => event.event === 'job_read_started')
            .every((event: { at: number }) => event.at >= stopped.at)).toBe(true);
        }
        if (mode === 'process_owner_restart') expect(ownership.processes.restarted.answer_displayed).toBe(true);
        const processes = Object.values(ownership.processes) as Array<{ stdout: string; audits: Array<{ event: string; command?: string }> }>;
        receipt = { history: ownership.history, rendered_terminal: processes.map(item => item.stdout).join('\n'),
          audits: processes.flatMap(item => item.audits) };
      } else if (faultMode) {
        const first = await runRecoveryFaultCase(python, userSite.stdout.trim(), sandbox, baseUrl, mode);
        expect(first.generation_posts).toBe(1);
        if (mode === 'duplicate_worker') expect(first.second_worker_gets).toBe(0);
        else expect(first.fault_triggered).toBe(true);
        const recovered = mode === 'duplicate_worker' ? first
          : await runRecoveryFaultCase(python, userSite.stdout.trim(), sandbox, baseUrl, 'recover');
        expect(recovered.generation_posts).toBe(mode === 'duplicate_worker' ? 1 : 0);
        expect(recovered.history).toHaveLength(1);
        expect(recovered.pending_count).toBe(0);
        expect(recovered.durable_completion_audits).toBe(1);
        expect(recovered.limiter_tokens_today).toBe(144);
        expect(recovered.limiter_cost_today).toBe(0);
        if (mode !== 'duplicate_worker') expect(recovered.process_id).not.toBe(first.process_id);
        receipt = { ...recovered, rendered_terminal: mode === 'duplicate_worker' ? first.rendered_output
          : first.rendered_output + '\n' + recovered.rendered_output };
      } else if (mode === 'restart' || mode === 'backend_restart' || recoveryBlocked) {
        const first = await runAutomaticCliCase(python, userSite.stdout.trim(), sandbox, baseUrl, mode + '-before', {
          persistentProfile: 'restart', steps: [{ input: 'what can u do?' }, { input: '/exit' }],
        });
        expect(first.history).toHaveLength(0);
        beforeRestartReads = resultReads;
        const profile = path.join(sandbox, 'native-profile-restart');
        const files = readdirSync(profile);
        expect(files.length).toBeGreaterThan(0);
        const memoryPath = path.join(profile, 'memory.json');
        const memory = JSON.parse(readFileSync(memoryPath, 'utf8'));
        memory.settings.instance_id = 'fresh-process-instance-after-system-restart';
        writeFileSync(memoryPath, JSON.stringify(memory));
        releaseProvider();
        for (let attempt = 0; attempt < 50 && conversationJobs.get(jobId)?.status !== 'completed'; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(conversationJobs.get(jobId)?.status).toBe('completed');
        let recoveryBaseUrl = baseUrl;
        if (mode === 'tampered_storage') {
          const encryptedPath = path.join(profile, 'conversation-recovery/pending.dpapi');
          const encrypted = readFileSync(encryptedPath);
          encrypted[encrypted.length - 1] ^= 1;
          writeFileSync(encryptedPath, encrypted);
        }
        if (mode === 'different_backend') {
          alternateBackend = app.listen(0, '127.0.0.1');
          await new Promise<void>((resolve, reject) => { alternateBackend!.once('listening', resolve); alternateBackend!.once('error', reject); });
          const alternateAddress = alternateBackend.address();
          if (!alternateAddress || typeof alternateAddress === 'string') throw new Error('Expected alternate loopback backend');
          recoveryBaseUrl = `http://127.0.0.1:${alternateAddress.port}`;
          expect(recoveryBaseUrl).not.toBe(baseUrl);
        }
        if (mode === 'backend_restart') {
          // Persist only the controlled repository row and synthetic startup
          // responses. Bearer capabilities remain solely in the CLI DPAPI file.
          const storagePath = path.join(sandbox, 'persisted-backend-job.json');
          const persisted = {
            job: conversationJobs.get(jobId), registry: startupSnapshots['/api/daemon/registry'],
            systemState: startupSnapshots['/system-state'],
          };
          expect(JSON.stringify(persisted)).not.toContain(issueJobReadCapability(jobId, secret));
          writeFileSync(storagePath, JSON.stringify(persisted));
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          conversationJobs.clear();
          const childEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT']
            .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
          restartedBackend = spawn(process.execPath, [
            '--import', pathToFileURL(path.resolve('scripts/register-esm-loader.mjs')).href,
            fileURLToPath(new URL('./fixtures/continuation-result-backend-child.mjs', import.meta.url)),
            storagePath, String(address.port),
          ], {
            cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: { ...childEnvironment, NODE_ENV: 'test', ARCANOS_JOB_READ_CAPABILITY_SECRET: secret,
              ARCANOS_DAEMON_ACCESS_TOKEN: daemonToken, ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: peerToken },
          });
          const backend = restartedBackend;
          backend.stderr?.on('data', chunk => { backendStartupError = (backendStartupError + chunk.toString()).slice(-4000); });
          await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Fresh backend process readiness timed out')), 15_000);
            backend.on('message', message => {
              const data = message as { event: string; pid?: number; method: string; path: string; status: number;
                capabilityBound?: boolean; generationRequests: number; providerCalls: number; resultReads: number };
              if (data.event === 'ready') { freshBackendPid = data.pid; clearTimeout(deadline); resolve(); }
              if (data.event === 'request') {
                observed.push({ method: data.method, path: data.path, status: data.status,
                  ...(data.path.startsWith('/jobs/') ? { capabilityBound: data.capabilityBound } : {}) });
                if (data.path.startsWith('/jobs/')) resultReads += 1;
                if (data.path === '/api/daemon/registry' || data.path === '/system-state') {
                  restartedStartupReads.push({ path: data.path, status: data.status });
                }
              }
              if (data.event === 'closed') childFinalCounters = data;
            });
            backend.once('error', error => { clearTimeout(deadline); reject(error); });
            backend.once('exit', code => { clearTimeout(deadline); if (code !== 0) reject(new Error('Fresh backend process failed: ' + backendStartupError)); });
          });
          expect(freshBackendPid).not.toBe(process.pid);
        }
        receipt = await runAutomaticCliCase(python, userSite.stdout.trim(), sandbox, recoveryBaseUrl, mode + '-after', {
          persistentProfile: 'restart', differentRecoveryOwner: mode === 'different_user',
          steps: [{ input: '/exit', ...(recoveryBlocked ? {} : { waitForText: answer }) }],
        });
        const readsAfterDelivery = resultReads;
        const replay = await runAutomaticCliCase(python, userSite.stdout.trim(), sandbox, recoveryBaseUrl, mode + '-replay', {
          persistentProfile: 'restart', differentRecoveryOwner: mode === 'different_user', steps: [{ input: '/exit' }],
        });
        expect(replay.history).toHaveLength(recoveryBlocked ? 0 : 1);
        expect(resultReads).toBe(readsAfterDelivery);
        if (restartedBackend) {
          const backend = restartedBackend;
          await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Fresh backend process shutdown timed out')), 10_000);
            backend.once('exit', code => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error('Fresh backend process failed')); });
            backend.send('close');
          });
          expect(childFinalCounters).toMatchObject({ generationRequests: 0, providerCalls: 0, resultReads: 1 });
          expect(restartedStartupReads).toEqual([
            { path: '/api/daemon/registry', status: 200 }, { path: '/system-state', status: 200 },
            { path: '/api/daemon/registry', status: 200 }, { path: '/system-state', status: 200 },
          ]);
        }
      } else if (terminalMessages[mode]) {
        receipt = await runAutomaticCliCase(python, userSite.stdout.trim(), sandbox, baseUrl, mode, {
          persistentProfile: mode,
          steps: [{ input: 'what can u do?' }, { input: '/exit', waitForText: terminalMessages[mode] }],
        });
      } else if (mode === 'multiple') {
        receipt = await runAutomaticCliCase(python, userSite.stdout.trim(), sandbox, baseUrl, mode, {
          persistentProfile: mode,
          steps: [{ input: 'what can u do?' }, { input: secondQuestion },
            { typeBeforeWait: '/sta', waitForText: [answer, secondAnswer], input: 'tus' }, { input: '/exit' }],
        });
        expect(overlappingAcceptedJobs).toBe(true);
        expect(receipt.rendered_terminal).toContain(secondAnswer);
      } else {
        receipt = await runAutomaticCliCase(python, userSite.stdout.trim(), sandbox, baseUrl, mode, {
          persistentProfile: mode,
          // The user starts typing a real slash command before recovery prints;
          // completing it afterward proves the active input line remains intact.
          steps: [{ input: 'what can u do?' }, { typeBeforeWait: '/sta', waitForText: answer, input: 'tus' }, { input: '/exit' }],
        });
        expect(receipt.rendered_terminal).toContain('Daemon trust (local):');
      }
      if (terminalMessages[mode]) expect(receipt.rendered_terminal).not.toContain(answer);
      else expect(receipt.rendered_terminal).toContain(answer);
      const originalRequests = mode === 'multiple' ? 2 : 1;
      expect(receipt.history).toHaveLength(terminalMessages[mode] ? 0 : originalRequests);
      if (!terminalMessages[mode]) expect(receipt.history).toEqual(expect.arrayContaining([expect.objectContaining({ user: 'what can u do?', ai: answer })]));
      if (mode === 'multiple') expect(receipt.history).toEqual(expect.arrayContaining([expect.objectContaining({ user: secondQuestion, ai: secondAnswer })]));
      expect(observed.filter(row => row.method === 'POST' && row.path.startsWith('/gpt/'))).toEqual(
        Array.from({ length: originalRequests }, () => expect.objectContaining({ status: mode === 'synchronous' ? 200 : 202 })),
      );
      expect(responsesCreate).toHaveBeenCalledTimes(originalRequests);
      expect(acceptedWaitStorageOutages).toBe(mode === 'wait_storage_outage' ? 1 : 0);
      expect(generationRequests).toBe(originalRequests);
      expect(observed.filter(row => row.path.startsWith('/jobs/')).every(row => row.capabilityBound)).toBe(mode !== 'invalid_capability');
      if (!faultMode) expect(receipt.audits.filter((row: { event: string; command?: string }) => row.command === 'conversation_recovery' && row.event === 'execute_success'))
        .toHaveLength(terminalMessages[mode] || mode === 'synchronous' ? 0 : originalRequests);
      if (recoveryBlocked || mode === 'synchronous') expect(resultReads).toBe(beforeRestartReads);
      else expect(resultReads).toBeGreaterThan(beforeRestartReads);
      expect(resultReads).toBeLessThanOrEqual(8);
      if (mode === 'temporary_503') expect(observed.filter(row => row.status === 503)).toHaveLength(2);
      if (mode === 'offline') {
        expect(offlineReadOutage).toBe(true);
        expect(receipt.rendered_terminal).toContain('Conversation recovery is waiting');
      }
      const evidence = path.resolve('tmp/automatic-continuation');
      mkdirSync(evidence, { recursive: true });
      writeFileSync(path.join(evidence, mode + '-proof.json'), JSON.stringify({
        mode, observed, generationRequests, providerCalls: responsesCreate.mock.calls.length, overlappingAcceptedJobs,
        resultReads, beforeRestartReads, offlineReadOutage, acceptedWaitStorageOutages, history: receipt.history, noLeaks: true,
        actualConPTY: !faultMode, realPythonHttp: true, automatic: true, resumeCommands: 0,
        freshProcessIdentity: mode === 'restart' || mode === 'backend_restart', freshBackendPid, childFinalCounters,
        ...(mode === 'different_user' ? { isolationEvidence: 'Injected different recovery-owner SID; real Windows account unchanged' } : {}),
      }, null, 2));
    } finally {
      releaseProvider(); server.closeAllConnections();
      if (ownerRelease) clearInterval(ownerRelease);
      if (offlineRestart) clearTimeout(offlineRestart);
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (restartedBackend && restartedBackend.exitCode === null) restartedBackend.kill();
      if (alternateBackend) await new Promise<void>((resolve, reject) => alternateBackend!.close(error => error ? reject(error) : resolve()));
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 100_000,
);
