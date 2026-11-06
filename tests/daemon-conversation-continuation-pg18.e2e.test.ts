/**
 * Native Windows CLI -> real HTTP, GPT router, dispatcher, registry, CORE,
 * Trinity DIRECT_ANSWER, Responses mapper, reserved job execution and job reads.
 * Reuses the session-context E2E provider/KV isolation and the native CLI fixture.
 * Uses real disposable PostgreSQL job transactions and unchanged repository SQL.
 * Only paid provider transport and unrelated infrastructure are synthetic.
 */
import express from 'express';
import { Client, Pool } from 'pg';
import { assertDisposablePostgresTestDatabaseUrl, resolvePostgresTestDatabaseUrl } from './integration/postgresTestDatabase.js';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';
import { afterAll, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import {
  createSyntheticDurableMemory,
  type SyntheticResponsesRequest,
} from './fixtures/session-context-e2e.js';

const durableMemory = createSyntheticDurableMemory();
const answer = 'I can explain ideas and help you plan.\n\n### Audit Summary\nRequested public report — café 雪.\n\n### COMPLIANCE STATUS\nThe supplied draft remains under review.';
let releaseProvider = () => {};
let providerCompletion = Promise.resolve();
let controlledProviderInvocations = 0;
const httpEvidence: Array<{ scenario: string; requests: Array<{ method: string; path: string; status?: number; capabilityBound?: boolean }> }> = [];
const responsesCreate = jest.fn(async (input: SyntheticResponsesRequest) => {
  controlledProviderInvocations += 1;
  await providerCompletion;
  return { id: 'synthetic-continuation-response', model: input.model, created_at: 1_790_000_000,
    status: 'completed', output_text: answer, output: [],
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
const databaseEnvironment = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(databaseEnvironment);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, databaseEnvironment);
const withDatabase = connectionString ? it : it.skip;
const nativeWithDatabase = connectionString && process.platform === 'win32' ? it : it.skip;
const schemaName = 'daemon_pg_' + randomUUID().replaceAll('-', '');
let databasePool: Pool;
let administrator: Client;
let schemaCreated = false;
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => databasePool,
  isDatabaseConnected: () => Boolean(databasePool),
  getStatus: () => ({ connected: Boolean(databasePool), hasPool: Boolean(databasePool), error: null }),
  initializeDatabase: forbiddenIO, close: forbiddenIO, closePoolIfCurrent: forbiddenIO,
}));
const actualDatabase = await import('../src/core/db/index.js');
jest.unstable_mockModule('@core/db/index.js', () => ({
  ...actualDatabase, loadMemory: durableMemory.load, saveMemory: durableMemory.save,
  loadAllRagDocs: async () => [], loadRagDocsByIds: async () => [],
  isDatabaseSchemaReady: () => true,
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
const actualWebRag = await import('../src/services/webRag.js');
jest.unstable_mockModule('@services/webRag.js', () => ({
  ...actualWebRag,
  recordConversationSnippet,
  queryRag: forbiddenIO,
  queryRagWithDiagnostics: forbiddenIO,
  queryRagDocuments: forbiddenIO,
  recordPersistentMemorySnippet: forbiddenIO,
  ingestContent: forbiddenIO,
  ingestUrl: forbiddenIO,
  answerQuestion: forbiddenIO,
}));
const actualMemoryAware = await import('../src/services/memoryAware.js');
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  ...actualMemoryAware,
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern: jest.fn(),
}));
const actualSelfImprove = await import('../src/services/selfImprove/controller.js');
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ ...actualSelfImprove, runSelfImproveCycle: jest.fn() }));
const actualSelfHealing = await import('../src/services/selfImprove/selfHealingV2.js');
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  ...actualSelfHealing,
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn(),
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: async () => ({ enabled: false, attempted: false, reason: 'synthetic' }),
}));
const actualWorkerAutonomy = await import('../src/services/workerAutonomyService.js');
jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  ...actualWorkerAutonomy,
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

const { configureArcanosCoreOperatorDispatch } = await import('../src/services/arcanosCoreOperatorDispatchPort.js');
configureArcanosCoreOperatorDispatch(async () => null);
const { createApp } = await import('../src/app.js');
const jobs = await import('../src/core/db/repositories/jobRepository.js');

afterAll(() => {
  releaseProvider();
  configureArcanosCoreOperatorDispatch(null);
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

beforeAll(async () => {
  if (!connectionString) return;
  administrator = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
  await administrator.connect();
  // The guarded client URL is loopback. Docker port forwarding can give the
  // server a bridge address, so it is not evidence of the client's target.
  const verified = await administrator.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version");
  expect(verified.rows[0]).toMatchObject({ database: 'arcanos_audit_pg18_20260727' });
  expect(verified.rows[0].version).toBeGreaterThanOrEqual(180_000);
  expect(verified.rows[0].version).toBeLessThan(190_000);
  mkdirSync(path.resolve('tmp/full-system-postgres'), { recursive: true });
  await administrator.query(`CREATE SCHEMA "${schemaName}"`);
  schemaCreated = true;
  await administrator.query(`SET search_path TO "${schemaName}"`);
  databasePool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 1_000,
    options: `-c search_path=${schemaName} -c statement_timeout=3000 -c lock_timeout=2500`, application_name: schemaName });
  databasePool.on('error', () => {}); // Owned outage tests intentionally terminate connections.
  const { TABLE_DEFINITIONS } = await import('../src/core/db/schema.js');
  for (const table of ['job_data', 'job_events']) {
    const definition = TABLE_DEFINITIONS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
    expect(definition).toBeDefined();
    await administrator.query(definition!);
  }
  const migration = readFileSync(path.resolve('migrations/20260727_job_claim_generation_v1.sql'), 'utf8');
  await administrator.query(migration);
  await administrator.query(migration); // Existing migration is idempotent on the actual runtime schema.
  for (const sql of TABLE_DEFINITIONS.filter(sql => sql.startsWith('CREATE INDEX IF NOT EXISTS idx_job_data_'))) {
    await administrator.query(sql);
  }
  await administrator.query('CREATE TABLE fixture_controls (block_accept boolean NOT NULL DEFAULT false, fail_completed boolean NOT NULL DEFAULT false)');
  await administrator.query('INSERT INTO fixture_controls DEFAULT VALUES');
  await administrator.query(`CREATE FUNCTION hold_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF (SELECT block_accept FROM fixture_controls) THEN PERFORM pg_advisory_xact_lock(1589182026); END IF; RETURN NEW; END $$`);
  await administrator.query('CREATE TRIGGER fixture_acceptance BEFORE INSERT ON job_data FOR EACH ROW EXECUTE FUNCTION hold_acceptance()');
  await administrator.query(`CREATE FUNCTION reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='completed' AND (SELECT fail_completed FROM fixture_controls) THEN
      RAISE EXCEPTION 'Synthetic durable completion write failure'; END IF; RETURN NEW; END $$`);
  await administrator.query('CREATE TRIGGER fixture_completion BEFORE UPDATE ON job_data FOR EACH ROW EXECUTE FUNCTION reject_completion()');
}, 20_000);

beforeEach(async () => {
  if (!connectionString) return;
  releaseProvider();
  await administrator.query('TRUNCATE job_data,job_events');
  await administrator.query('UPDATE fixture_controls SET block_accept=false,fail_completed=false');
  responsesCreate.mockClear(); durableMemory.reset();
});

afterAll(async () => {
  releaseProvider();
  if (connectionString) {
    mkdirSync(path.resolve('tmp/full-system-postgres'), { recursive: true });
    const requests = httpEvidence.flatMap(item => item.requests);
    writeFileSync(path.resolve('tmp/full-system-postgres/http-ledger.json'), JSON.stringify({
      realPostgres: true, actualCreateApp: true, runtimeCasesWithHttp: httpEvidence.length,
      httpRequests: requests.length, generationPosts: requests.filter(row => row.method === 'POST').length,
      resultReads: requests.filter(row => row.path.startsWith('/jobs/')).length,
      controlledProviderInvocations, paidProviderCalls: 0, cases: httpEvidence,
    }, null, 2));
  }
  await databasePool?.end();
  if (administrator) {
    if (schemaCreated) {
      await administrator.query('RESET search_path');
      await administrator.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
    await administrator.end();
  }
});

/** Use the established real ConPTY entrypoint fixture and its protected synthetic profile. */
async function nativeCli(sandbox: string, baseUrl: string, label: string, scenario: Record<string, unknown>) {
  const scenarioPath = path.join(sandbox, label + '-scenario.json');
  const receiptPath = path.join(sandbox, label + '-receipt.json');
  writeFileSync(scenarioPath, JSON.stringify({ name: label, tty: true, heartbeat: false,
    credentials: { daemon: daemonToken, control: peerToken, gpt: genericToken },
    extraEnv: { CONVERSATION_RECOVERY_ENABLED: 'true', BACKEND_FALLBACK_TO_LOCAL: 'false' }, ...scenario }));
  const python = process.env.PYTHON_EXECUTABLE || 'python';
  const userSite = spawnSync(python, ['-c', 'import site; print(site.getusersitepackages())'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(userSite.status).toBe(0);
  const childEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ACCEPTANCE_EXTRA_PYTHON_SITE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-B', fileURLToPath(new URL('./fixtures/daemon_registry_client.py', import.meta.url)),
      '--native', path.resolve('daemon-python'), baseUrl, scenarioPath, receiptPath], {
      cwd: sandbox, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 55_000,
      env: { ...childEnv, PYTHONIOENCODING: 'utf-8', ACCEPTANCE_PYTHON_USER_SITE: userSite.stdout.trim() },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  });
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  mkdirSync(path.resolve('tmp/full-system-postgres'), { recursive: true });
  writeFileSync(path.resolve('tmp/full-system-postgres', label + '-receipt.json'), JSON.stringify(receipt, null, 2));
  expect({ ...result, failure: receipt.failure }).toEqual({ code: 0, stderr: '', failure: null });
  expect(receipt.transport).toBe('Windows ConPTY');
  expect(receipt.public_entrypoint).toBe(true);
  expect(Object.values(receipt.leaks).every(value => value === false)).toBe(true);
  expect(receipt.observations.filter((item: { event: string }) => item.event === 'local_generation_attempt')).toHaveLength(0);
  expect(receipt.speech).toHaveLength(0);
  return receipt;
}

/** Observe real response coordinates without writing credentials to acceptance artifacts. */
function serve({ releaseOnRead = true } = {}) {
  const observed: Array<{ method: string; path: string; status?: number; capabilityBound?: boolean }> = [];
  const coordinates: Array<{ jobId: string; capability: string }> = [];
  const visibility: Array<Promise<boolean>> = [];
  const startup: Record<string, unknown> = {};
  const publicResponses: unknown[] = [];
  httpEvidence.push({ scenario: expect.getState().currentTestName ?? 'unknown', requests: observed });
  const application = express();
  application.use((req, res, next) => {
    const row: (typeof observed)[number] = { method: req.method, path: req.path };
    observed.push(row);
    const send = res.send.bind(res);
    res.send = body => {
      let payload;
      try { payload = typeof body === 'string' ? JSON.parse(body) : body; } catch { payload = null; }
      if (req.method === 'POST' && row.path.startsWith('/gpt/')) publicResponses.push(payload);
      if (res.statusCode === 202 && payload?.jobId) {
        coordinates.push({ jobId: payload.jobId, capability: payload.jobReadToken });
        visibility.push(administrator.query('SELECT count(*)::int AS count FROM job_data WHERE id=$1', [payload.jobId]).then(result => result.rows[0].count === 1));
      }
      if (row.path === '/api/daemon/registry' || row.path === '/system-state') startup[row.path] = payload;
      return send(body);
    };
    if (req.path.startsWith('/jobs/')) {
      row.capabilityBound = req.get('x-arcanos-job-read-token') === issueJobReadCapability(req.path.split('/')[2], secret)
        && req.originalUrl === req.path && !req.get('x-arcanos-daemon-token');
      if (releaseOnRead) res.once('finish', releaseProvider);
    }
    res.once('finish', () => { row.status = res.statusCode; });
    next();
  });
  // createApp constructs all production HTTP middleware/routes without starting
  // the separately-owned worker/runtime activation lifecycle.
  application.use(createApp());
  const server = application.listen(0, '127.0.0.1');
  return { server, observed, coordinates, visibility, startup, publicResponses };
}

async function listening(server: ReturnType<typeof express.application.listen>) {
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an isolated loopback server');
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: ReturnType<typeof express.application.listen>) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function containsPlaintextCapability(directory: string, capability: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).some(entry => {
    if (entry.isSymbolicLink()) throw new Error('Unexpected link in the isolated native evidence tree');
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? containsPlaintextCapability(target, capability)
      : readFileSync(target).includes(Buffer.from(capability));
  });
}

async function waitFor(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  do {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('Owned PostgreSQL acceptance timed out: ' + label);
}

async function postQuestion(baseUrl: string, idempotencyKey = 'synthetic-pg18-original-request') {
  return fetch(baseUrl + '/gpt/arcanos-daemon', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${genericToken}`, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ prompt: 'what can u do?', executionMode: 'async', sessionId: 'synthetic-disposable-pg-conversation' }),
  });
}

async function readResult(baseUrl: string, id: string, capability = issueJobReadCapability(id, secret)) {
  return fetch(`${baseUrl}/jobs/${id}/result`, { headers: { 'x-arcanos-job-read-token': capability } });
}

withDatabase('commits acceptance before HTTP 202 and the repository reuses its exact explicit receipt without inference', async () => {
  providerCompletion = new Promise<void>(resolve => { releaseProvider = resolve; });
  const runtime = serve({ releaseOnRead: false });
  let locked = false;
  try {
    const baseUrl = await listening(runtime.server);
    await administrator.query('UPDATE fixture_controls SET block_accept=true');
    await administrator.query('SELECT pg_advisory_lock(1589182026)'); locked = true;
    let returned = false;
    const request = postQuestion(baseUrl).then(response => { returned = true; return response; });
    await waitFor(async () => (await administrator.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", [schemaName])).rows[0].count === 1, 'acceptance reached the actual insert lock');
    expect(returned).toBe(false);
    expect((await administrator.query('SELECT count(*)::int AS count FROM job_data')).rows[0].count).toBe(0);
    expect(responsesCreate).not.toHaveBeenCalled();
    await administrator.query('SELECT pg_advisory_unlock(1589182026)'); locked = false;
    const response = await request;
    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(accepted.jobReadToken).toBe(issueJobReadCapability(accepted.jobId, secret));
    expect(accepted.poll).toBe(`/jobs/${accepted.jobId}/result`);
    expect(await Promise.all(runtime.visibility)).toEqual([true]);
    releaseProvider();
    await waitFor(async () => (await jobs.getJobById(accepted.jobId))?.status === 'completed', 'terminal output commit');
    const persisted = (await jobs.getJobById(accepted.jobId))!;
    // Public anonymous requests intentionally get distinct server-owned scopes.
    // Exercise reuse under the exact original authoritative scope, never invent
    // authentication from a caller-selected session or raw Authorization value.
    const replay = await jobs.findOrCreateGptJob({ workerId: persisted.worker_id, input: persisted.input,
      requestFingerprintHash: persisted.request_fingerprint_hash!, idempotencyScopeHash: persisted.idempotency_scope_hash!,
      idempotencyKeyHash: persisted.idempotency_key_hash, idempotencyOrigin: 'explicit', createOptions: { status: 'pending' } });
    expect(replay).toMatchObject({ created: false, deduped: true, job: { id: accepted.jobId } });
    for (let index = 0; index < 3; index += 1) {
      const result = await readResult(baseUrl, accepted.jobId, accepted.jobReadToken);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ status: 'completed', result: { ok: true } });
    }
    expect((await administrator.query('SELECT count(*)::int AS count FROM job_data')).rows[0].count).toBe(1);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    writeFileSync(path.resolve('tmp/full-system-postgres/acceptance-idempotency.json'), JSON.stringify({
      insertWasBlockedBefore202: true, independentCommitVisibility: await Promise.all(runtime.visibility),
      logicalOriginalRequests: 1, exactRepositoryIdempotencyReplays: 1, providerCalls: responsesCreate.mock.calls.length,
      resultReads: 3, jobRows: 1, observed: runtime.observed,
    }, null, 2));
  } finally {
    if (locked) await administrator.query('SELECT pg_advisory_unlock(1589182026)');
    releaseProvider(); await stop(runtime.server);
  }
}, 20_000);

withDatabase('fences actual terminal writes by current generation, lease and owner', async () => {
  const original = await jobs.createJob('disposable-pg-slot', 'gpt', { requestPath: '/gpt/arcanos-daemon' }, {
    status: 'running', lastWorkerId: 'pg-owner-one', leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const old = jobs.createClaimedJobFence('pg-owner-one', original.claim_generation!);
  await administrator.query("UPDATE job_data SET claim_generation=claim_generation+1,last_worker_id='pg-owner-two' WHERE id=$1", [original.id]);
  expect(await jobs.updateClaimedJobTerminal(original.id, 'completed', { fence: old, output: { stale: true } })).toBeNull();
  const live = jobs.createClaimedJobFence('pg-owner-two', '2');
  await administrator.query("UPDATE job_data SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [original.id]);
  expect(await jobs.updateClaimedJobTerminal(original.id, 'completed', { fence: live, output: { expired: true } })).toBeNull();
  await administrator.query("UPDATE job_data SET lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1", [original.id]);
  const completed = await jobs.updateClaimedJobTerminal(original.id, 'completed', { fence: live, output: { approved: answer } });
  expect(completed?.output).toEqual({ approved: answer });
  expect(await jobs.updateClaimedJobTerminal(original.id, 'completed', { fence: live, output: { overwritten: true } })).toBeNull();
  expect((await jobs.getJobById(original.id))?.output).toEqual({ approved: answer });
  expect(responsesCreate).not.toHaveBeenCalled();
});

withDatabase('a real acceptance transaction timeout cannot return accepted coordinates or start inference', async () => {
  providerCompletion = Promise.resolve();
  const runtime = serve({ releaseOnRead: false });
  try {
    const baseUrl = await listening(runtime.server);
    await administrator.query('UPDATE fixture_controls SET block_accept=true');
    await administrator.query('SELECT pg_advisory_lock(1589182026)');
    const failed = await postQuestion(baseUrl);
    // Creation maps the actual failed transaction to the admission-unavailable
    // contract, without claiming accepted work or a completed answer.
    expect(failed.status).toBe(503);
    const payload = await failed.json();
    expect(payload.jobId).toBeUndefined();
    expect(payload.jobReadToken).toBeUndefined();
    expect((await administrator.query('SELECT count(*)::int AS count FROM job_data')).rows[0].count).toBe(0);
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(runtime.coordinates).toHaveLength(0);
  } finally { await administrator.query('SELECT pg_advisory_unlock(1589182026)'); await stop(runtime.server); }
}, 10_000);

withDatabase('a completed provider output rejected by real PostgreSQL becomes an honest failed job without regeneration', async () => {
  providerCompletion = new Promise<void>(resolve => { releaseProvider = resolve; });
  const runtime = serve({ releaseOnRead: false });
  try {
    const baseUrl = await listening(runtime.server);
    await administrator.query('UPDATE fixture_controls SET fail_completed=true');
    const response = await postQuestion(baseUrl);
    expect(response.status).toBe(202);
    const accepted = await response.json();
    releaseProvider();
    await waitFor(async () => (await jobs.getJobById(accepted.jobId))?.status === 'failed', 'failed completion persistence');
    const job = (await jobs.getJobById(accepted.jobId))!;
    expect(job.output).toBeNull();
    expect(job.error_message).toContain('Synthetic durable completion write failure');
    const result = await readResult(baseUrl, accepted.jobId, accepted.jobReadToken);
    expect(await result.json()).toMatchObject({ status: 'failed', jobStatus: 'failed', result: null });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(runtime.observed.filter(row => row.method === 'POST')).toHaveLength(1);
  } finally { releaseProvider(); await stop(runtime.server); }
}, 15_000);

const restartDirectory = process.env.ARCANOS_CONTINUATION_PG_RESTART_DIRECTORY;
const postgresControl = process.env.ARCANOS_CONTINUATION_PG_CTL;
const withOwnedClusterRestart = connectionString && restartDirectory && postgresControl ? it : it.skip;
withOwnedClusterRestart('recovers the same retained result after a real owned PostgreSQL outage and restart', async () => {
  const ownedRoot = path.resolve('tmp') + path.sep;
  expect(path.resolve(restartDirectory!).startsWith(ownedRoot)).toBe(true);
  expect(path.resolve(postgresControl!).startsWith(ownedRoot)).toBe(true);
  expect(path.basename(postgresControl!)).toBe(process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
  const actualDirectory = (await administrator.query('SHOW data_directory')).rows[0].data_directory;
  expect(path.resolve(actualDirectory).toLowerCase()).toBe(path.resolve(restartDirectory!).toLowerCase());
  const original = await jobs.createJob('disposable-pg-slot', 'gpt', { requestPath: '/gpt/arcanos-daemon' }, {
    status: 'running', lastWorkerId: 'pg-outage-owner', leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await jobs.updateClaimedJobTerminal(original.id, 'completed', {
    fence: jobs.createClaimedJobFence('pg-outage-owner', original.claim_generation!), output: { ok: true, result: answer },
  });
  const runtime = serve({ releaseOnRead: false });
  let clusterRunning = true;
  const control = (action: 'start' | 'stop') => {
    const port = new URL(connectionString).port;
    const cleanControlEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
    const command = spawnSync(postgresControl!, ['-D', restartDirectory!, '-t', '10', '-w',
      ...(action === 'stop' ? ['-m', 'fast', 'stop'] : ['-l', path.join(path.dirname(restartDirectory!), 'restart-server.log'),
        '-o', `-h 127.0.0.1 -p ${port} -c max_connections=30`, 'start'])],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: cleanControlEnvironment });
    if (command.status !== 0) throw new Error('Owned PostgreSQL control failed: ' + command.stderr);
  };
  try {
    const baseUrl = await listening(runtime.server);
    expect((await readResult(baseUrl, original.id)).status).toBe(200);
    await administrator.end();
    control('stop'); clusterRunning = false;
    const unavailable = await readResult(baseUrl, original.id);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).status).not.toBe('completed');
    control('start'); clusterRunning = true;
    administrator = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
    await administrator.connect();
    await administrator.query(`SET search_path TO "${schemaName}"`);
    const recovered = await readResult(baseUrl, original.id);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ jobId: original.id, status: 'completed', result: { ok: true, result: answer } });
    expect(runtime.observed.filter(row => row.method === 'POST')).toHaveLength(0);
    expect(responsesCreate).not.toHaveBeenCalled();
    writeFileSync(path.resolve('tmp/full-system-postgres/real-postgres-restart.json'), JSON.stringify({
      ownedDirectoryValidatedAgainstServer: true, actualPostgresStoppedAndStarted: true,
      outageStatus: unavailable.status, recoveryStatus: recovered.status, generationPosts: 0, providerCalls: 0,
      observed: runtime.observed,
    }, null, 2));
  } finally {
    try {
      if (!clusterRunning) {
        control('start');
        administrator = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
        await administrator.connect(); await administrator.query(`SET search_path TO "${schemaName}"`);
      }
    } finally { await stop(runtime.server); }
  }
}, 30_000);

withDatabase.each(['completed', 'failed', 'cancelled', 'expired', 'missing_output'] as const)(
  'retrieves truthful %s state from real durable rows and denies invalid/missing/cross-job capabilities', async state => {
    const original = await jobs.createJob('disposable-pg-slot', 'gpt', { requestPath: '/gpt/arcanos-daemon' }, {
      status: 'running', lastWorkerId: 'pg-terminal-owner', leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const expectedOutput = { ok: true, result: { result: answer, tokens: 144 }, _route: { gptId: 'arcanos-daemon' } };
    if (state === 'expired') {
      // The generic unfenced update correctly refuses a live running claim.
      await administrator.query("UPDATE job_data SET status='expired',output=NULL,expires_at=NOW(),completed_at=NOW(),lease_expires_at=NULL WHERE id=$1", [original.id]);
    }
    else await jobs.updateClaimedJobTerminal(original.id, state === 'missing_output' ? 'completed' : state, {
      fence: jobs.createClaimedJobFence('pg-terminal-owner', original.claim_generation!),
      output: state === 'completed' ? expectedOutput : null,
    });
    const runtime = serve({ releaseOnRead: false });
    try {
      const baseUrl = await listening(runtime.server);
      const response = await readResult(baseUrl, original.id);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const result = await response.json();
      if (state === 'completed') expect(result).toMatchObject({ status: 'completed', result: expectedOutput });
      else if (state === 'missing_output') expect(result).toMatchObject({ status: 'failed', jobStatus: 'completed', result: null, error: { code: 'JOB_RESULT_UNAVAILABLE' } });
      else expect(result).toMatchObject({ status: state === 'cancelled' ? 'failed' : state, jobStatus: state, result: null });
      for (const capability of ['', issueJobReadCapability(randomUUID(), secret), 'v1.' + 'x'.repeat(43)]) {
        const denied = await readResult(baseUrl, original.id, capability);
        expect(denied.status).toBe(200);
        expect(await denied.json()).toMatchObject({ status: 'not_found', result: null, error: { code: 'JOB_NOT_FOUND' } });
      }
      const missingId = randomUUID();
      const missing = await readResult(baseUrl, missingId);
      expect(await missing.json()).toMatchObject({ status: 'not_found', result: null, error: { code: 'JOB_NOT_FOUND' } });
      expect(responsesCreate).not.toHaveBeenCalled();
      expect(runtime.observed.filter(row => row.method === 'POST')).toHaveLength(0);
    } finally { await stop(runtime.server); }
  }, 15_000,
);

withDatabase('the real retention cleanup expires and later compacts only eligible GPT work', async () => {
  const completedIds = [];
  for (let index = 0; index < 2; index += 1) {
    const job = await jobs.createJob('disposable-pg-slot', 'gpt', { requestPath: '/gpt/arcanos-daemon' }, {
      status: 'running', lastWorkerId: 'pg-retention-owner', leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await jobs.updateClaimedJobTerminal(job.id, 'completed', {
      fence: jobs.createClaimedJobFence('pg-retention-owner', job.claim_generation!), output: { ok: true, result: answer },
    });
    completedIds.push(job.id);
  }
  const pending = await jobs.createJob('disposable-pg-slot', 'gpt', { requestPath: '/gpt/arcanos-daemon' });
  await administrator.query("UPDATE job_data SET retention_until=NOW()-INTERVAL '1 second' WHERE id=$1", [completedIds[0]]);
  await administrator.query("UPDATE job_data SET created_at=NOW()-INTERVAL '31 minutes' WHERE id=$1", [pending.id]);
  expect(await jobs.cleanupExpiredGptJobs()).toEqual({ expiredPending: 1, expiredTerminal: 1, deletedExpired: 0 });
  expect((await jobs.getJobById(completedIds[1]))?.status).toBe('completed');
  const runtime = serve({ releaseOnRead: false });
  try {
    const baseUrl = await listening(runtime.server);
    expect(await (await readResult(baseUrl, completedIds[0])).json()).toMatchObject({
      status: 'expired', result: { ok: true, result: answer }, error: { code: 'JOB_EXPIRED' },
    });
    await administrator.query("UPDATE job_data SET expires_at=NOW()-INTERVAL '2 days' WHERE id=$1", [completedIds[0]]);
    expect(await jobs.cleanupExpiredGptJobs()).toEqual({ expiredPending: 0, expiredTerminal: 0, deletedExpired: 1 });
    expect(await (await readResult(baseUrl, completedIds[0])).json()).toMatchObject({ status: 'not_found', result: null });
    expect(await (await readResult(baseUrl, completedIds[1])).json()).toMatchObject({ status: 'completed', result: { ok: true, result: answer } });
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(runtime.observed.filter(row => row.method === 'POST')).toHaveLength(0);
  } finally { await stop(runtime.server); }
});

nativeWithDatabase.each(['immediate', 'automatic', 'restart', 'backend_restart'] as const)(
  'native CLI traverses real app and PostgreSQL with %s delivery', async mode => {
    providerCompletion = mode === 'immediate' ? Promise.resolve() : new Promise<void>(resolve => { releaseProvider = resolve; });
    const runtime = serve({ releaseOnRead: mode !== 'restart' && mode !== 'backend_restart' });
    const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-native-pg18-'));
    let serverStopped = false;
    let child: ReturnType<typeof spawn> | undefined;
    let childPid: number | undefined;
    let childCounters: { generationRequests: number; providerCalls: number; resultReads: number } | undefined;
    try {
      const baseUrl = await listening(runtime.server);
      let receipt;
      if (mode === 'restart' || mode === 'backend_restart') {
        const pending = await nativeCli(sandbox, baseUrl, mode + '-before', { persistentProfile: 'postgres', steps: [{ input: 'what can u do?' }, { input: '/exit' }] });
        expect(pending.history).toHaveLength(0);
        expect(runtime.coordinates).toHaveLength(1);
        expect(containsPlaintextCapability(sandbox, runtime.coordinates[0].capability)).toBe(false);
        releaseProvider();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && (await administrator.query("SELECT count(*)::int AS count FROM job_data WHERE status='completed' AND output IS NOT NULL")).rows[0].count !== 1) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect((await administrator.query("SELECT count(*)::int AS count FROM job_data WHERE status='completed' AND output IS NOT NULL")).rows[0].count).toBe(1);
        if (mode === 'backend_restart') {
          const port = new URL(baseUrl).port;
          await stop(runtime.server); serverStopped = true;
          const clean = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT']
            .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
          child = spawn(process.execPath, ['--import', pathToFileURL(path.resolve('scripts/register-esm-loader.mjs')).href,
            path.resolve('tests/fixtures/continuation-postgres-result-child.mjs'), schemaName, port], {
            cwd: sandbox, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: { ...clean, NODE_ENV: 'test', DISABLE_EXTERNAL_CALLS: 'true', RUN_WORKERS: 'false',
              DATABASE_URL: connectionString, ARCANOS_JOB_READ_CAPABILITY_SECRET: secret,
              ARCANOS_DAEMON_ACCESS_TOKEN: daemonToken, ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: peerToken,
              ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'real-chain-fixture', ARCANOS_CONTROL_PLANE_SCOPES: 'arcanos:read,mcp:invoke',
              FINETUNED_MODEL_ID: 'ft:synthetic:session-context-authority', OPENAI_API_KEY: '',
            },
          });
          const backend = child;
          let stderr = '';
          backend.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Fresh PostgreSQL-backed HTTP process timed out: ' + stderr)), 20_000);
            backend.once('error', error => { clearTimeout(timer); reject(error); });
            backend.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error('Fresh PostgreSQL-backed process failed: ' + stderr)); } });
            backend.on('message', message => {
              const value = message as { event: string; pid?: number; method: string; path: string; status: number; capabilityBound?: boolean;
                generationRequests: number; providerCalls: number; resultReads: number };
              if (value.event === 'ready') { childPid = value.pid; clearTimeout(timer); resolve(); }
              if (value.event === 'request') runtime.observed.push({ method: value.method, path: value.path, status: value.status,
                ...(value.path.startsWith('/jobs/') ? { capabilityBound: value.capabilityBound } : {}) });
              if (value.event === 'closed') childCounters = value;
            });
          });
          expect(childPid).not.toBe(process.pid);
        }
        receipt = await nativeCli(sandbox, baseUrl, mode + '-after', { persistentProfile: 'postgres', steps: [{ input: '/exit', waitForText: answer }] });
        const reads = runtime.observed.filter(row => row.path.startsWith('/jobs/')).length;
        const replay = await nativeCli(sandbox, baseUrl, mode + '-replay', { persistentProfile: 'postgres', steps: [{ input: '/exit' }] });
        expect(replay.history).toHaveLength(1);
        expect(runtime.observed.filter(row => row.path.startsWith('/jobs/'))).toHaveLength(reads);
        if (child) {
          const backend = child;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Read-only backend shutdown timed out')), 10_000);
            backend.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Read-only backend shutdown failed')); });
            backend.send('close');
          });
          expect(childCounters).toEqual(expect.objectContaining({ generationRequests: 0, providerCalls: 0, resultReads: 1 }));
        }
      } else {
        receipt = await nativeCli(sandbox, baseUrl, mode, { persistentProfile: 'postgres', steps: [
          { input: 'what can u do?' }, { input: '/exit', waitForText: answer },
        ] });
      }
      if (mode === 'immediate') {
        const response = runtime.publicResponses[0] as Record<string, unknown>;
        const result = response.result as Record<string, unknown> | undefined;
        const accounting: Record<string, number> = {};
        const inspectAccounting = (value: unknown, location: string) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            const pointer = location + '.' + key;
            if (typeof item === 'number' && /tokens|usage|cost/iu.test(pointer)) accounting[pointer] = item;
            else if (item && typeof item === 'object') inspectAccounting(item, pointer);
          }
        };
        inspectAccounting(response, '$');
        writeFileSync(path.resolve('tmp/full-system-postgres/immediate-response-shape.json'), JSON.stringify({
          topKeys: Object.keys(response), resultKeys: result && typeof result === 'object' ? Object.keys(result) : [],
          tokens: response.tokens, usage: response.usage, resultTokens: result?.tokens, resultUsage: result?.usage, accounting,
          parsedUsage: receipt.observations.filter((row: { event: string }) => row.event === 'conversation_result'),
        }, null, 2));
      }
      expect(receipt.history).toEqual([expect.objectContaining({ user: 'what can u do?', ai: answer, tokens: 144 })]);
      expect(receipt.rendered_terminal).toContain(answer);
      expect(receipt.audits.filter((row: { event: string }) => row.event === 'execute_success')).toHaveLength(1);
      expect(runtime.observed.filter(row => row.method === 'POST')).toEqual([
        expect.objectContaining({ path: '/gpt/arcanos-daemon', status: mode === 'immediate' ? 200 : 202 }),
      ]);
      expect(responsesCreate).toHaveBeenCalledTimes(1);
      expect(await Promise.all(runtime.visibility)).toEqual(mode === 'immediate' ? [] : [true]);
      expect(runtime.observed.filter(row => row.path.startsWith('/jobs/')).every(row => row.capabilityBound)).toBe(true);
      const persisted = await administrator.query('SELECT id,status,output,claim_generation,retention_until FROM job_data');
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({ status: 'completed', claim_generation: '1', output: expect.objectContaining({ ok: true }) });
      expect(new Date(persisted.rows[0].retention_until).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
      for (const handle of runtime.coordinates) {
        expect(containsPlaintextCapability(sandbox, handle.capability)).toBe(false);
        expect(JSON.stringify(receipt)).not.toContain(handle.capability);
        expect(JSON.stringify(persisted.rows)).not.toContain(handle.capability);
      }
      writeFileSync(path.resolve('tmp/full-system-postgres', mode + '-counters.json'), JSON.stringify({
        actualPostgres: true, actualCreateApp: true, migrationAppliedTwice: true,
        generationPosts: runtime.observed.filter(row => row.method === 'POST').length,
        providerCalls: responsesCreate.mock.calls.length, jobRows: persisted.rowCount,
        acceptedCommitVisible: await Promise.all(runtime.visibility), childPid, childCounters, observed: runtime.observed,
      }, null, 2));
    } finally { releaseProvider(); if (child && child.exitCode === null) child.kill(); if (!serverStopped) await stop(runtime.server); rmSync(sandbox, { recursive: true, force: true }); }
  }, 100_000,
);
