import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SignJWT, generateKeyPair } from 'jose';
import { runWithRequestAbortContext } from '@arcanos/runtime';
import type { FindOrCreateGptJobOptions } from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { readSessionContext } from '@platform/runtime/sessionContext.js';
import {
  CORE_MCP_PATH, CORE_QUERY_SCOPE, CORE_MEMORY_READ_SCOPE, CORE_MEMORY_WRITE_SCOPE,
} from '@shared/chatgpt/coreMcpContract.js';

const jobs = new Map<string, JobData>();
const sessions = new Map<string, { owner: string; revision: string; envelope: string }>();
const storageKey = randomBytes(32).toString('base64url');
const runArcanosCoreQuery = jest.fn<(_input: unknown) => Promise<unknown>>();
const getOpenAIClientOrAdapter = jest.fn<() => { client: object | null }>();
const hasUnsafeBlockingConditions = jest.fn<() => boolean>();
const loadChatGptCoreSessionMemory = jest.fn(async (id: string) => sessions.get(id) ?? null);
const saveChatGptCoreSessionMemory = jest.fn(async (id: string, value: { owner: string; revision: string; envelope: string }, revision: string) => {
  const prior = sessions.get(id);
  if (prior && BigInt(prior.revision) >= BigInt(revision)) return null;
  sessions.set(id, value);
  return value;
});
const getJobById = jest.fn(async (id: string) => jobs.get(id) ?? null);
class IdempotencyKeyConflictError extends Error {}
const findOrCreateGptJob = jest.fn(async (input: FindOrCreateGptJobOptions) => {
  const prior = [...jobs.values()].find(job => job.idempotency_scope_hash === input.idempotencyScopeHash
    && job.idempotency_key_hash === input.idempotencyKeyHash);
  if (prior) {
    if (prior.request_fingerprint_hash !== input.requestFingerprintHash) throw new IdempotencyKeyConflictError();
    return { job: prior };
  }
  const job = {
    id: randomUUID(), job_type: 'gpt', status: 'pending', output: null,
    input: input.input, idempotency_scope_hash: input.idempotencyScopeHash,
    idempotency_key_hash: input.idempotencyKeyHash, request_fingerprint_hash: input.requestFingerprintHash,
  } as JobData;
  jobs.set(job.id, job);
  return { job };
});
const readRecentCompletedCoreGptJobs = jest.fn(async (scopeHash: string, sessionReference: string) =>
  [...jobs.values()].filter(job => {
    const input = job.input as { protectedCore?: { sessionReference?: unknown } };
    return job.status === 'completed' && job.idempotency_scope_hash === scopeHash
      && input.protectedCore?.sessionReference === sessionReference;
  }).reverse().slice(0, 8));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: (name: string) => name === 'ARCANOS_CHATGPT_CORE_STORAGE_KEY' ? storageKey : undefined,
  getEnvNumber: (_name: string, defaultValue: number) => defaultValue,
}));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  getJobById, findOrCreateGptJob, IdempotencyKeyConflictError, readRecentCompletedCoreGptJobs,
}));
jest.unstable_mockModule('@core/db/repositories/memoryRepository.js', () => ({
  loadChatGptCoreSessionMemory, saveChatGptCoreSessionMemory,
}));
jest.unstable_mockModule('@services/arcanos-core.js', () => ({ runArcanosCoreQuery }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter }));
jest.unstable_mockModule('@services/safety/runtimeState.js', () => ({ hasUnsafeBlockingConditions }));
jest.unstable_mockModule('@services/chatgptCoreDiagnostics.js', () => ({ inspectChatGptCoreDiagnostics: jest.fn() }));
jest.unstable_mockModule('@services/chatgptCoreProductivity.js', () => ({ inspectChatGptCoreProductivity: jest.fn() }));

const { executeCoreMcp } = await import('../src/chatgpt/core.js');
const { createCoreTokenVerifier } = await import('../src/chatgpt/coreAuth.js');
const { executeCoreQueuedJob } = await import('../src/services/chatgptCoreJobs.js');

const issuer = 'https://issuer.invalid/';
const resource = 'https://core.invalid' + CORE_MCP_PATH;
const oauthClientId = 'fixture-client';
const memoryScopes = [CORE_QUERY_SCOPE, CORE_MEMORY_READ_SCOPE, CORE_MEMORY_WRITE_SCOPE];
let signingKeys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { signingKeys = await generateKeyPair('RS256'); });

async function principal(subject = 'fixture-owner', scopes: readonly string[] = memoryScopes) {
  const verify = createCoreTokenVerifier({
    status: 'ready', issuer, resource, oauthClientId, ownerSubject: subject,
    jwksUrl: issuer + 'jwks', metadataUrl: resource,
  }, {
    keyResolver: async () => signingKeys.publicKey,
    readEnvironmentValue: () => undefined,
  });
  const token = await new SignJWT({ client_id: oauthClientId, scope: scopes.join(' ') })
    .setIssuer(issuer).setAudience(resource).setSubject(subject).setIssuedAt().setExpirationTime('5m')
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).sign(signingKeys.privateKey);
  const result = await verify('Bearer ' + token);
  if (!result.ok) throw new Error('Fixture authentication denied.');
  return result.principal;
}

function getId(output: Awaited<ReturnType<typeof executeCoreMcp>>, name: 'jobId' | 'sessionId' | 'confirmationToken') {
  const id = (output as Record<string, unknown> | undefined)?.[name];
  if (typeof id !== 'string') throw new Error('Expected a fixture identifier.');
  return id;
}

/** Keep pending fixture calls immediate while retaining the real ownership-aware poller. */
function observeOnce<T>(callback: () => Promise<T>) {
  const controller = new AbortController();
  return runWithRequestAbortContext({ controller, signal: controller.signal, deadlineAt: Date.now() + 100, timeoutMs: 100 }, callback);
}

async function settle(jobId: string) {
  const job = jobs.get(jobId)!;
  const result = await executeCoreQueuedJob(jobId, job.input);
  Object.assign(job, { status: result.status, output: result.output, error_message: result.errorMessage ?? null });
  return result;
}

beforeEach(() => {
  jobs.clear();
  sessions.clear();
  jest.clearAllMocks();
  getOpenAIClientOrAdapter.mockReturnValue({ client: {} });
  hasUnsafeBlockingConditions.mockReturnValue(false);
  runArcanosCoreQuery.mockReset().mockResolvedValue({
    result: 'A backend-generated fixture answer.', fallbackFlag: false, dryRun: false,
  });
});

describe('private Core canonical execution', () => {
  it('queues one fixed Core job, continues by owner, and returns a fast completed retry inline', async () => {
    const owner = await principal();
    const outsider = await principal('another-owner');
    const args = { prompt: 'Explain the numerical solution step by step.', idempotencyKey: 'reasoning-one', answerMode: 'explained' };
    const submitted = await observeOnce(() => executeCoreMcp(owner, 'coreAsk', args));
    const jobId = getId(submitted, 'jobId');
    expect(submitted).toEqual({ ok: true, status: 'pending', jobId });
    expect(findOrCreateGptJob).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ gptId: 'arcanos-core', requestPath: CORE_MCP_PATH }),
      idempotencyOrigin: 'explicit', createOptions: expect.objectContaining({ maxRetries: 0 }),
    }));
    expect(JSON.stringify(jobs.get(jobId)?.input)).not.toContain(args.prompt);
    await expect(executeCoreMcp(outsider, 'getCoreJobResult', { jobId })).resolves.toMatchObject({ error: { code: 'CORE_JOB_NOT_FOUND' } });
    expect(runArcanosCoreQuery).not.toHaveBeenCalled();
    await settle(jobId);
    expect(JSON.stringify(jobs.get(jobId)?.output)).not.toContain('fixture answer');
    const completed = { ok: true, status: 'completed', jobId, answer: 'A backend-generated fixture answer.' };
    await expect(executeCoreMcp(owner, 'getCoreJobResult', { jobId })).resolves.toEqual(completed);
    await expect(executeCoreMcp(owner, 'coreAsk', args)).resolves.toEqual(completed);
    expect(runArcanosCoreQuery).toHaveBeenCalledTimes(1);
    expect(runArcanosCoreQuery).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'arcanos-core', requestedAction: 'query', allowTimeoutFallback: false,
      runOptions: expect.objectContaining({ answerMode: 'explained', disableMemoryAccess: true, redactAuditContent: true }),
    }));
    await expect(executeCoreMcp(owner, 'coreAsk', { ...args, prompt: 'Different prompt.' }))
      .resolves.toMatchObject({ error: { code: 'CORE_IDEMPOTENCY_CONFLICT' } });
    const next = await observeOnce(() => executeCoreMcp(owner, 'coreAsk', { ...args, idempotencyKey: 'reasoning-two' }));
    expect(getId(next, 'jobId')).not.toEqual(jobId);
    expect(findOrCreateGptJob.mock.calls.at(-1)?.[0].requestFingerprintHash)
      .not.toEqual(findOrCreateGptJob.mock.calls[0]?.[0].requestFingerprintHash);
  });

  it('isolates explicit notes and saves only finished turns as continuity', async () => {
    const owner = await principal();
    const outsider = await principal('another-owner');
    const queryOnly = await principal('fixture-owner', [CORE_QUERY_SCOPE]);
    const privateNote = 'My preferred symbolic example.';
    const session = await executeCoreMcp(owner, 'startCoreSession', { idempotencyKey: 'session-one' });
    const sessionId = getId(session, 'sessionId');
    await expect(executeCoreMcp(owner, 'startCoreSession', { idempotencyKey: 'session-one' })).resolves.toEqual(session);
    await expect(executeCoreMcp(outsider, 'readCoreMemory', { sessionId })).resolves.toMatchObject({ error: { code: 'CORE_SESSION_NOT_FOUND' } });
    const save = { sessionId, text: privateNote, idempotencyKey: 'memory-one' };
    const proposal = await executeCoreMcp(owner, 'writeCoreMemory', save);
    expect(proposal).toMatchObject({ error: { code: 'CORE_CONFIRMATION_REQUIRED' } });
    const token = getId(proposal, 'confirmationToken');
    await expect(executeCoreMcp(owner, 'readCoreMemory', { sessionId })).resolves.toMatchObject({ notes: [] });
    const mismatched = await executeCoreMcp(owner, 'writeCoreMemory', { ...save, text: 'Other value.', confirmationToken: token });
    expect(mismatched).toMatchObject({ error: { code: 'CORE_CONFIRMATION_REQUIRED' } });
    const exact = await executeCoreMcp(owner, 'writeCoreMemory', save);
    const confirmed = { ...save, confirmationToken: getId(exact, 'confirmationToken') };
    await expect(executeCoreMcp(owner, 'writeCoreMemory', confirmed)).resolves.toEqual({ ok: true, sessionId });
    await expect(executeCoreMcp(owner, 'writeCoreMemory', confirmed)).resolves.toEqual({ ok: true, sessionId });
    await expect(executeCoreMcp(owner, 'readCoreMemory', { sessionId })).resolves.toMatchObject({ notes: [privateNote] });
    expect(JSON.stringify(sessions.get(sessionId))).not.toContain(privateNote);

    const first = { sessionId, prompt: 'Let the fixture variable equal 23.', idempotencyKey: 'turn-one' };
    await expect(executeCoreMcp(queryOnly, 'coreAsk', first)).resolves.toMatchObject({ error: { code: 'CORE_PERMISSION_DENIED' } });
    await expect(executeCoreMcp(outsider, 'coreAsk', first)).resolves.toMatchObject({ error: { code: 'CORE_SESSION_NOT_FOUND' } });
    const jobId = getId(await observeOnce(() => executeCoreMcp(owner, 'coreAsk', first)), 'jobId');
    await settle(jobId);
    await expect(executeCoreMcp(queryOnly, 'getCoreJobResult', { jobId })).resolves.toMatchObject({ error: { code: 'CORE_JOB_NOT_FOUND' } });
    const second = { sessionId, prompt: 'Use the fixture variable in the example.', idempotencyKey: 'turn-two' };
    const secondJob = getId(await observeOnce(() => executeCoreMcp(owner, 'coreAsk', second)), 'jobId');
    runArcanosCoreQuery.mockImplementationOnce(async () => {
      expect(readSessionContext()).toContain(first.prompt);
      expect(readSessionContext()).toContain('A backend-generated fixture answer.');
      expect(readSessionContext()).toContain(privateNote);
      expect(readSessionContext()).not.toContain(second.prompt);
      return { result: 'Continued using the owned fixture context.', fallbackFlag: false, dryRun: false };
    });
    await settle(secondJob);
    await expect(executeCoreMcp(owner, 'getCoreJobResult', { jobId: secondJob }))
      .resolves.toMatchObject({ answer: 'Continued using the owned fixture context.', sessionId, continuitySaved: true });
  });

  it.each([
    ['provider', 'CORE_PROVIDER_UNAVAILABLE'],
    ['timeout', 'CORE_GENERATION_TIMEOUT'],
    ['fallback', 'CORE_GENERATION_FAILED'],
    ['operation', 'CORE_OPERATION_DENIED'],
    ['unsafe', 'CORE_UNAVAILABLE'],
  ])('classifies %s without raw provider or control-plane details', async (mode, errorCode) => {
    const owner = await principal();
    const submitted = await observeOnce(() => executeCoreMcp(owner, 'coreAsk', {
      prompt: 'Synthetic request.', idempotencyKey: 'failure-test',
    }));
    const jobId = getId(submitted, 'jobId');
    if (mode === 'provider') getOpenAIClientOrAdapter.mockReturnValue({ client: null });
    if (mode === 'timeout') runArcanosCoreQuery.mockRejectedValueOnce(new Error('timed out with private diagnostic'));
    if (mode === 'fallback') runArcanosCoreQuery.mockResolvedValueOnce({ result: 'local fallback', fallbackFlag: true });
    if (mode === 'operation') {
      runArcanosCoreQuery.mockRejectedValueOnce(Object.assign(new Error('private execution diagnostic'), { code: 'TRINITY_CONTROL_LEAK' }));
    }
    if (mode === 'unsafe') hasUnsafeBlockingConditions.mockReturnValue(true);
    const outcome = await settle(jobId);
    expect(outcome).toMatchObject({ status: 'failed', output: null, retryable: false, errorMessage: errorCode });
    await expect(executeCoreMcp(owner, 'getCoreJobResult', { jobId })).resolves.toMatchObject({ error: { code: errorCode } });
    expect(JSON.stringify(outcome)).not.toContain('private');
    if (mode === 'unsafe') expect(getOpenAIClientOrAdapter).not.toHaveBeenCalled();
  });

  it('blocks direct credential-shaped inputs and redacts credential-shaped generated output', async () => {
    const owner = await principal();
    const syntheticCredential = `sk-${randomBytes(16).toString('hex')}`;
    const syntheticPrivateKey = '-----BEGIN TEST PRIVATE KEY-----\nfixture\n-----END TEST PRIVATE KEY-----';
    await expect(executeCoreMcp(owner, 'coreAsk', { prompt: syntheticCredential, idempotencyKey: 'credential-one' }))
      .resolves.toMatchObject({ error: { code: 'CORE_SENSITIVE_INPUT' } });
    await expect(executeCoreMcp(owner, 'coreAsk', { prompt: syntheticPrivateKey, idempotencyKey: 'credential-pem' }))
      .resolves.toMatchObject({ error: { code: 'CORE_SENSITIVE_INPUT' } });
    await expect(executeCoreMcp(owner, 'coreAsk', { prompt: storageKey, idempotencyKey: 'credential-key' }))
      .resolves.toMatchObject({ error: { code: 'CORE_SENSITIVE_INPUT' } });
    expect(findOrCreateGptJob).not.toHaveBeenCalled();
    const accepted = await observeOnce(() => executeCoreMcp(owner, 'coreAsk', {
      prompt: 'Give status of the synthetic fixture.', idempotencyKey: 'credential-two',
    }));
    const jobId = getId(accepted, 'jobId');
    runArcanosCoreQuery.mockResolvedValueOnce({
      result: `Fixture ${syntheticCredential}\n${syntheticPrivateKey}\nPublic summary.`, fallbackFlag: false, dryRun: false,
    });
    await settle(jobId);
    await expect(executeCoreMcp(owner, 'getCoreJobResult', { jobId }))
      .resolves.toMatchObject({ answer: 'Fixture [REDACTED_OPENAI_KEY]\n[REDACTED_PRIVATE_KEY]\nPublic summary.' });
  });
});
