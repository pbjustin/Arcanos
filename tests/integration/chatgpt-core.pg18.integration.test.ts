import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { afterAll, beforeAll, expect, it, jest } from '@jest/globals';
import { generateKeyPair, SignJWT } from 'jose';
import { Client, Pool } from 'pg';
import request from 'supertest';
import { assertDisposablePostgresTestDatabaseUrl, resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const databaseEnvironment = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(databaseEnvironment);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, databaseEnvironment);
const withDatabase = connectionString ? it : it.skip;
const schema = `chatgpt_core_${randomUUID().replaceAll('-', '')}`;
let pool: Pool | undefined;
let admin: Client | undefined;
let createdSchema = false;
const previousKey = process.env.ARCANOS_CHATGPT_CORE_STORAGE_KEY;

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => pool,
  isDatabaseConnected: () => Boolean(pool),
  getStatus: () => ({ connected: Boolean(pool), hasPool: Boolean(pool), error: null }),
  initializeDatabase: () => { throw new Error('Unexpected database initialization'); },
  close: jest.fn(),
  closePoolIfCurrent: jest.fn()
}));
const { readSessionContext } = await import('@platform/runtime/sessionContext.js');
const model = jest.fn(async ({ prompt }: { prompt: string }) => ({
  result: prompt === 'What did I ask before?'
    ? `Observed continuity: ${String(readSessionContext()?.includes('Explain the prior transaction.'))}`
    : 'Synthetic Core answer.'
}));
jest.unstable_mockModule('@services/arcanos-core.js', () => ({ runArcanosCoreQuery: model }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));

const { TABLE_DEFINITIONS } = await import('@core/db/schema.js');
const { claimNextPendingJob, updateClaimedJobTerminal } = await import('@core/db/repositories/jobRepository.js');
const { loadMemory, saveMemory, deleteMemory, getMemoryRecordByKey } = await import('@core/db/repositories/memoryRepository.js');
const { executeCoreQueuedJob } = await import('@services/chatgptCoreJobs.js');
const { createChatGptCoreMcpRouter } = await import('../../src/routes/chatgptCoreMcp.js');
const { CORE_MCP_PATH, CORE_METADATA_PATH, CORE_SCOPES } = await import('@shared/chatgpt/coreMcpContract.js');
const { computeGptJobLifecycleDeadlines } = await import('@shared/gpt/gptJobLifecycle.js');

beforeAll(async () => {
  if (!connectionString) return;
  process.env.ARCANOS_CHATGPT_CORE_STORAGE_KEY = randomBytes(32).toString('base64url');
  admin = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 2_000 });
  await admin.connect();
  const result = await admin.query("SELECT current_database() AS name, current_setting('server_version_num')::int AS version");
  expect(result.rows[0].name).toBe('arcanos_audit_pg18_20260727');
  expect(Math.floor(result.rows[0].version / 10_000)).toBe(18);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await admin.query(`SET search_path TO "${schema}"`);
  for (const table of ['job_data', 'job_events', 'memory']) {
    const statement = TABLE_DEFINITIONS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
    if (!statement) throw new Error(`Missing fixture table: ${table}`);
    await admin.query(statement);
  }
  await admin.query(readFileSync('migrations/20260727_job_claim_generation_v1.sql', 'utf8'));
  pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 2_000,
    options: `-c search_path=${schema} -c statement_timeout=3000 -c lock_timeout=2500` });
}, 20_000);

afterAll(async () => {
  if (previousKey === undefined) delete process.env.ARCANOS_CHATGPT_CORE_STORAGE_KEY;
  else process.env.ARCANOS_CHATGPT_CORE_STORAGE_KEY = previousKey;
  await pool?.end();
  if (createdSchema) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin?.end();
});

withDatabase('enforces ownership and confirmation and continues one committed Core job through real PostgreSQL', async () => {
  const issuer = 'https://core-issuer.example.test/';
  const resource = `https://arcanos.example.test${CORE_MCP_PATH}`;
  const oauthClientId = 'core-fixture-client';
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  async function makeClient(ownerSubject: string) {
    const app = express();
    app.use(createChatGptCoreMcpRouter({
      configuration: { status: 'ready', issuer, resource, ownerSubject, oauthClientId,
        jwksUrl: new URL('jwks', issuer).href, metadataUrl: new URL(CORE_METADATA_PATH, resource).href },
      verification: { keyResolver: async () => publicKey, readEnvironmentValue: () => undefined },
      isUnsafe: () => false,
      providerAdmission: (_req, _res, next) => next()
    }));
    const token = await new SignJWT({ scope: CORE_SCOPES.join(' '), client_id: oauthClientId })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' }).setIssuer(issuer).setAudience(resource)
      .setSubject(ownerSubject).setIssuedAt().setExpirationTime('2m').sign(privateKey);
    return async (name: string, args: Record<string, unknown>) => {
      const response = await request(app).post(CORE_MCP_PATH)
        .set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      expect(response.status).toBe(200);
      return response.body.result.structuredContent;
    };
  }

  const core = await makeClient('fixture-owner');
  const other = await makeClient('fixture-other-owner');
  const { sessionId } = await core('startCoreSession', { idempotencyKey: 'core-fixture-session' });
  expect(sessionId).toMatch(/^[a-f0-9]{64}$/);
  expect(await other('readCoreMemory', { sessionId })).toMatchObject({ ok: false, error: { code: 'CORE_SESSION_NOT_FOUND' } });

  const save = { sessionId, text: 'synthetic remembered detail', idempotencyKey: 'core-fixture-note' };
  const { confirmationToken } = await core('writeCoreMemory', save);
  expect(confirmationToken).toEqual(expect.any(String));
  expect(await core('readCoreMemory', { sessionId })).toMatchObject({ ok: true, notes: [] });
  expect(await core('writeCoreMemory', { ...save, confirmationToken })).toMatchObject({ ok: true });
  expect(await core('readCoreMemory', { sessionId })).toMatchObject({ ok: true, notes: [save.text] });

  const legacyMemoryKey = `chatgpt-core-session:v1:${sessionId}`;
  await expect(loadMemory(legacyMemoryKey)).resolves.toBeNull();
  await expect(getMemoryRecordByKey(legacyMemoryKey)).resolves.toBeNull();
  await expect(saveMemory(legacyMemoryKey, {})).rejects.toThrow('Protected memory key.');
  await expect(deleteMemory(legacyMemoryKey)).resolves.toBe(false);

  const first = {
    sessionId, prompt: 'Explain the prior transaction.', idempotencyKey: 'core-fixture-turn-one',
    answerMode: 'explained', maxOutputTokens: 512
  };
  const [admitted, duplicate] = await Promise.all([core('coreAsk', first), core('coreAsk', first)]);
  expect(admitted).toMatchObject({ ok: true, status: 'pending', jobId: expect.any(String) });
  expect(duplicate).toEqual(admitted);
  expect(await core('coreAsk', { ...first, prompt: 'A different request.' })).toMatchObject({
    ok: false, error: { code: 'CORE_IDEMPOTENCY_CONFLICT' }
  });
  expect(model).not.toHaveBeenCalled();
  expect(await other('getCoreJobResult', { jobId: admitted.jobId })).toMatchObject({ ok: false, error: { code: 'CORE_JOB_NOT_FOUND' } });

  const workerId = 'core-fixture-worker';
  async function complete(jobId: string) {
    const claimed = await claimNextPendingJob({ workerId, leaseMs: 10_000 });
    if (!claimed) throw new Error('Expected a durable Core job');
    expect(claimed.id).toBe(jobId);
    expect(JSON.stringify(claimed.input)).not.toContain(first.prompt);
    const outcome = await executeCoreQueuedJob(claimed.id, claimed.input);
    expect(outcome.status).toBe('completed');
    const committed = await updateClaimedJobTerminal(jobId, 'completed', {
      output: outcome.output, fence: { workerId, claimGeneration: claimed.claim_generation },
      metadata: computeGptJobLifecycleDeadlines('completed')
    });
    expect(committed?.status).toBe('completed');
    expect(JSON.stringify(committed?.output)).not.toContain('Synthetic Core answer.');
    return core('getCoreJobResult', { jobId });
  }
  expect(await complete(admitted.jobId)).toMatchObject({ ok: true, status: 'completed', answer: 'Synthetic Core answer.' });
  expect(model).toHaveBeenCalledWith(expect.objectContaining({
    gptId: 'arcanos-core', prompt: first.prompt, maxOutputTokens: 512,
    runOptions: expect.objectContaining({ answerMode: 'explained', disableMemoryAccess: true })
  }));
  expect(await core('coreAsk', first)).toMatchObject({ status: 'completed', jobId: admitted.jobId });
  expect(model).toHaveBeenCalledTimes(1);

  const next = await core('coreAsk', { sessionId, prompt: 'What did I ask before?', idempotencyKey: 'core-fixture-turn-two' });
  expect(await complete(next.jobId)).toMatchObject({ ok: true, status: 'completed', answer: 'Observed continuity: true' });
  expect(model).toHaveBeenCalledTimes(2);
  const rows = await admin?.query('SELECT count(*)::int AS count FROM job_data');
  expect(rows?.rows[0].count).toBe(2);
}, 30_000);
