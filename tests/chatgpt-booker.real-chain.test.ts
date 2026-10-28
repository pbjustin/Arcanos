import { jest } from '@jest/globals';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { ChatGptPrincipal } from '../src/chatgpt/auth.js';
import type { Request, Response, NextFunction } from 'express';
import type { JobData } from '../src/core/db/schema.js';
import { createBookerTokenVerifier, readBookerAuthConfiguration, bookerPrincipalActorKey, type ReadyBookerAuthConfiguration } from '../src/chatgpt/bookerAuth.js';
import { BOOKER_GENERATE_SCOPE, BOOKER_MCP_PATH, BOOKER_READ_SCOPE } from '../src/shared/chatgpt/bookerMcpContract.js';
import { createBookerMcpExecutor } from '../src/chatgpt/booker.js';
import { invokeBookerGptAction } from '../src/chatgpt/bookerGptAdapter.js';
import { runWithBookerMcpProviderAdmission, hasBookerMcpGenerationAuthentication } from '../src/chatgpt/bookerRequestAuth.js';
import { isBackstageBookerAccessAuthenticated } from '../src/services/backstageBookerAccessAuth.js';
import { isBackstageNotionEnrichmentAuthorized, isBackstageProtectedGenerationExecution } from '../src/services/backstageNotionEnrichmentAuthorization.js';
import { parseQueuedGptJobInput } from '../src/shared/gpt/asyncGptJob.js';
import { buildGptIdempotencyScopeHash } from '../src/shared/gpt/gptIdempotency.js';
import { getRequestAbortSignal, runWithRequestAbortContext } from '@arcanos/runtime';

const route = jest.fn();
const findOrCreate = jest.fn();
const plan = jest.fn();
const wait = jest.fn();
const admission = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
let authorityEnforced = false;
jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: async () => ({ ok: true, plan: { matchedId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', route: 'backstage-booker',
    action: 'generateBooking', availableActions: ['generateBooking', 'generateBookingWithHRC', 'queryContinuity', 'simulateMatch'],
    moduleVersion: null, moduleDescription: null, matchMethod: 'exact' }, _route: {} }),
  routeGptRequest: route,
}));
jest.unstable_mockModule('../src/transport/http/middleware/publicProviderAdmission.js', () => ({ publicProviderGptAdmission: admission }));
jest.unstable_mockModule('../src/services/backstageNotionAuthority.js', () => ({
  isBackstageNotionAuthorityEnforced: async () => authorityEnforced,
  isBackstageNotionAuthorityDatabaseError: () => false,
  readBackstageNotionAuthorityConfiguration: () => ({ status: 'absent' }),
  resolveEffectiveBackstageNotionAuthorityRoot: async () => null,
}));
jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: plan, getWorkerAutonomyHealthReport: async () => ({ status: 'ok', workers: [] }),
  getWorkerAutonomySettings: () => ({ enabled: false, mode: 'off' }),
}));
jest.unstable_mockModule('../src/services/queuedGptCompletionService.js', () => ({
  waitForQueuedGptJobCompletion: wait, resolveAsyncGptPollIntervalMs: () => 250,
  resolveAsyncGptWaitForResultMs: (requested?: number) => requested ?? 0,
}));
class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}
jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError, JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreate, getJobById: jest.fn(), createClaimedJobFence: jest.fn(), normalizeJobClaimGeneration: jest.fn(),
  createJob: jest.fn(), claimNextPendingJob: jest.fn(), claimNextPendingJobWithAdmission: jest.fn(), failPendingJobIfUnclaimed: jest.fn(),
  recordJobHeartbeat: jest.fn(), scheduleJobRetry: jest.fn(), deferJobForProviderRecovery: jest.fn(), recoverStaleJobs: jest.fn(),
  recoverStalledJobsForWorkers: jest.fn(), resolveJobWorkerStaleAfterMs: () => 45_000, updateJob: jest.fn(), getLatestJob: jest.fn(),
  listFailedJobs: jest.fn(), requeueFailedJob: jest.fn(), getJobQueueSummary: jest.fn(), getJobExecutionStatsSince: jest.fn(),
  requestJobCancellation: jest.fn(), updateClaimedJobTerminal: jest.fn(), cleanupExpiredGptJobs: jest.fn(),
}));

const universeId = 'booker-real-chain';
const jobId = '11111111-1111-4111-8111-111111111111';
const configuration = readBookerAuthConfiguration(name => ({
  CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: 'https://booker-issuer.invalid/',
  CHATGPT_BOOKER_RESOURCE: 'https://booker-resource.invalid' + BOOKER_MCP_PATH,
  CHATGPT_BOOKER_JWKS_URL: 'https://booker-issuer.invalid/jwks', CHATGPT_BOOKER_OWNER_SUBJECT: 'fixture-owner',
  CHATGPT_BOOKER_UNIVERSE_ID: universeId, CHATGPT_BOOKER_OAUTH_CLIENT_ID: 'fixture-client',
})[name]) as ReadyBookerAuthConfiguration;
let principal: ChatGptPrincipal;
const environmentNames = ['ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY', 'ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED', 'PRIORITY_QUEUE_ENABLED', 'GPT_ROUTE_ASYNC_CORE_DEFAULT'] as const;
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' }] });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
    iat: now, exp: now + 300, client_id: configuration.oauthClientId, scope: BOOKER_READ_SCOPE + ' ' + BOOKER_GENERATE_SCOPE,
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' }).sign(keys.privateKey);
  const result = await createBookerTokenVerifier(configuration, { keyResolver, readEnvironmentValue: () => undefined })('Bearer ' + token);
  if (!result.ok) throw new Error('Signed fixture rejected'); principal = result.principal;
});
beforeEach(() => {
  jest.clearAllMocks(); authorityEnforced = false;
  admission.mockImplementation((_req, _res, next) => next());
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = Buffer.alloc(32, 0x53).toString('base64');
  process.env.ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED = 'true';
  process.env.PRIORITY_QUEUE_ENABLED = 'false'; process.env.GPT_ROUTE_ASYNC_CORE_DEFAULT = 'false';
  plan.mockResolvedValue({ status: 'pending', retryCount: 0, maxRetries: 2, priority: 85,
    autonomyState: { planner: { reasons: [] } }, planningReasons: [] });
});
afterAll(() => { for (const [name, value] of originalEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });

describe('Booker MCP canonical backend route reuse', () => {
  it('does not accept caller-shaped authentication markers or a changed universe', async () => {
    const fakeRequest = { method: 'POST', originalUrl: '/gpt/backstage-booker', body: { action: 'generateBooking' },
      authenticatedActorKey: bookerPrincipalActorKey(principal), bookerMcpAuthenticated: true } as unknown as Request;
    expect(hasBookerMcpGenerationAuthentication(fakeRequest)).toBe(false);
    await expect(invokeBookerGptAction(principal, 'generateBooking', { universeId: 'other-universe', prompt: 'Book Raw.' }))
      .rejects.toThrow('BOOKER_PERMISSION_DENIED');
    expect(route).not.toHaveBeenCalled(); expect(findOrCreate).not.toHaveBeenCalled();
  });
  it('uses a protected OAuth context without establishing the legacy bearer marker', async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    route.mockImplementation(async () => {
      expect(isBackstageNotionEnrichmentAuthorized()).toBe(true);
      expect(isBackstageProtectedGenerationExecution()).toBe(true);
      return { ok: false, error: { code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE', message: 'Authority is unavailable.' },
        _route: { gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', route: 'backstage-booker', action: 'queryContinuity', timestamp: new Date().toISOString() } };
    });
    const result = await invokeBookerGptAction(principal, 'queryContinuity', { universeId, query: 'What is current?' },
      { requestId: 'request', traceId: 'trace', logger: logger as unknown as Request['logger'] });
    expect(result.statusCode).toBe(503); expect(result.result).toMatchObject({ ok: false, error: { code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' } });
    const fakeRequest = { method: 'POST', originalUrl: '/gpt/backstage-booker' } as Request;
    expect(isBackstageBookerAccessAuthenticated(fakeRequest)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith('gpt.request.timeout_plan', expect.objectContaining({ endpoint: '/gpt/backstage-booker' }));
    expect(findOrCreate).not.toHaveBeenCalled(); expect(route).toHaveBeenCalledTimes(1);
  });
  it('preserves sealed queue planning, registered OAuth provenance and stable idempotent recovery', async () => {
    authorityEnforced = true;
    let persisted: JobData | undefined;
    let creations = 0;
    findOrCreate.mockImplementation(async (input: { input: unknown; idempotencyScopeHash: string }) => {
      const created = !persisted;
      if (!persisted) { creations++; persisted = { id: jobId, status: 'pending', job_type: 'gpt', input: input.input,
        idempotency_scope_hash: input.idempotencyScopeHash, created_at: new Date(), updated_at: new Date() } as JobData; }
      return { job: persisted, created, deduped: !created, dedupeReason: created ? 'new_job' : 'same_request' };
    });
    wait.mockImplementation(async () => ({ state: 'timeout', job: persisted }));
    const execute = createBookerMcpExecutor();
    const input = { universeId, prompt: 'Book one complete Raw card.', idempotencyKey: 'same-booking-request' };
    for (let index = 0; index < 2; index++) {
      const result = await runWithBookerMcpProviderAdmission(() => execute(principal, 'generateBooking', input, { requestId: 'request', traceId: 'trace' }));
      expect(result.statusCode).toBe(202); expect(result.result).toMatchObject({ jobId });
      expect(result.result.instruction).toContain('getBackstageBookerJobResult');
      expect(result.result.instruction).toContain(universeId); expect(String(result.result.instruction)).not.toContain('Bearer');
      expect(result.result).not.toHaveProperty('jobReadToken'); expect(result.result).not.toHaveProperty('stream');
    }
    expect(creations).toBe(1); expect(route).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled();
    const first = findOrCreate.mock.calls[0][0] as Record<string, unknown>;
    const second = findOrCreate.mock.calls[1][0] as Record<string, unknown>;
    expect(first.idempotencyScopeHash).toBe(buildGptIdempotencyScopeHash({ surface: 'public-gpt', actorKey: bookerPrincipalActorKey(principal) }));
    expect(first.requestFingerprintHash).toBe(second.requestFingerprintHash); expect(first.idempotencyKeyHash).toBe(second.idempotencyKeyHash);
    const parsed = parseQueuedGptJobInput(first.input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toMatchObject({ gptId: 'backstage-booker', protectedBackstage: { action: 'generateBooking', universeId, notionEnrichmentAuthorized: true } });
    expect(JSON.stringify(first.input)).not.toContain(input.prompt);
    expect(first.createOptions).toMatchObject({ autonomyState: { gptClientProvenance: { clientId: 'backstage-booker-plugin',
      authenticationType: 'oauth', runtimeModel: null, modelIdentityAssurance: 'unknown',
      authenticatedUser: { subject: principal.subject, oauthClientId: configuration.oauthClientId } } } });
  });
  it('retains protected lane identity when OAuth expires during admitted in-flight routing', async () => {
    authorityEnforced = true;
    admission.mockImplementation((req, _res, next) => {
      expect(hasBookerMcpGenerationAuthentication(req)).toBe(true);
      jest.spyOn(Date, 'now').mockReturnValue((principal.expiresAt + 1) * 1000);
      expect(hasBookerMcpGenerationAuthentication(req)).toBe(true);
      next();
    });
    findOrCreate.mockImplementation(async (input: { input: unknown; idempotencyScopeHash: string }) => ({
      job: { id: jobId, status: 'pending', job_type: 'gpt', input: input.input, idempotency_scope_hash: input.idempotencyScopeHash },
      created: true, deduped: false, dedupeReason: 'new_job',
    }));
    wait.mockImplementation(async () => ({ state: 'timeout', job: null }));
    try {
      const result = await invokeBookerGptAction(principal, 'generateBooking', { universeId, prompt: 'Book one complete Raw card.' }, { idempotencyKey: 'late-expiry' });
      expect(result.statusCode).toBe(202); expect(result.result).toHaveProperty('jobId', jobId);
      expect(result.result).not.toHaveProperty('jobReadToken'); expect(result.result).not.toHaveProperty('stream');
      expect(route).not.toHaveBeenCalled();
    } finally { jest.restoreAllMocks(); }
  });
  it('propagates parent cancellation to the canonical backend without replaying inference', async () => {
    const controller = new AbortController();
    let backendSignal: AbortSignal | undefined;
    route.mockImplementation(async () => {
      backendSignal = getRequestAbortSignal();
      controller.abort(new Error('fixture cancellation'));
      backendSignal?.throwIfAborted();
      throw new Error('Backend should have received abort');
    });
    await expect(runWithRequestAbortContext({ controller, signal: controller.signal, deadlineAt: Date.now() + 5000, timeoutMs: 5000 },
      () => invokeBookerGptAction(principal, 'queryContinuity', { universeId, query: 'What is current?' })))
      .rejects.toThrow('BOOKER_ABORTED');
    expect(backendSignal?.aborted).toBe(true); expect(route).toHaveBeenCalledTimes(1); expect(findOrCreate).not.toHaveBeenCalled();
  });
});
