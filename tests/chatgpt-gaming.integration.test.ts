import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestAbortContext, getRequestAbortSignal, runWithRequestAbortContext } from '@arcanos/runtime';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import { createChatGptGamingMcpRouter } from '../src/routes/chatgptGamingMcp.js';
import { createGamingMcpExecutor, type GamingMcpServices } from '../src/chatgpt/gaming.js';
import { readGamingAuthConfiguration, createGamingTokenVerifier, hasGamingPermission, gamingPrincipalActorKey,
  type ReadyGamingAuthConfiguration } from '../src/chatgpt/gamingAuth.js';
import { GAMING_MCP_PATH, GAMING_METADATA_PATH, GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE, gamingMcpTools } from '../src/shared/chatgpt/gamingMcpContract.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';
import { resetSafetyRuntimeStateForTests } from '../src/services/safety/runtimeState.js';
import { runWithSessionContext, readSessionContext } from '../src/platform/runtime/sessionContext.js';
import { readRuntimeEnv, unsetRuntimeEnv, writeRuntimeEnv } from '../src/platform/runtime/env.js';
import { GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS } from '../src/shared/gaming/gamingExecutionBudgetCore.js';
import type { ChatGptGamingToolName } from '@arcanos/protocol';

const env: Record<string, string> = { CHATGPT_GAMING_ENABLED: 'true', CHATGPT_GAMING_ISSUER: 'https://gaming-issuer.invalid/',
  CHATGPT_GAMING_RESOURCE: 'https://gaming-resource.invalid/chatgpt/gaming/mcp', CHATGPT_GAMING_JWKS_URL: 'https://gaming-issuer.invalid/jwks',
  CHATGPT_GAMING_OWNER_SUBJECT: 'private-owner-fixture' };
const configuration = readGamingAuthConfiguration(name => env[name]) as ReadyGamingAuthConfiguration;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'gaming-fixture', alg: 'RS256' }] });
});
beforeEach(() => resetSafetyRuntimeStateForTests());
afterEach(() => { resetSafetyRuntimeStateForTests(); jest.restoreAllMocks(); });
async function token(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
    iat: now, exp: now + 300, scope: GAMING_QUERY_SCOPE, ...claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'gaming-fixture' }).sign(keys.privateKey);
}
async function principal(write = false) {
  const result = await createGamingTokenVerifier(configuration, { keyResolver, readEnvironmentValue: () => undefined })(
    'Bearer ' + await token({ scope: GAMING_QUERY_SCOPE + (write ? ' ' + GAMING_WRITE_SCOPE : '') }));
  if (!result.ok) throw new Error('Invalid signed fixture');
  return result.principal;
}
const hybrid = { contractVersion: 'gaming-hybrid-v1', requestId: 'fixture-request', workflowId: '11111111-1111-4111-8111-111111111111',
  state: 'discovery_required', nextAction: 'search', reason: 'EVIDENCE_REQUIRED', sourceKnown: false, evidenceSelected: false, freshnessStatus: 'unverified' };
const denied = { statusCode: 404, payload: { ok: false, error: { code: 'GAMING_SOURCE_INGESTION_NOT_FOUND', message: 'Not found.' } } };
function services(): GamingMcpServices {
  return {
    query: jest.fn(async () => ({ ok: true, route: 'gaming', mode: 'guide', data: { response: 'Fixture guide.', sources: [] } })),
    canary: jest.fn(() => { throw new Error('Unused'); }),
    hybridQuery: jest.fn(async () => ({ status: 200, body: hybrid })),
    candidates: jest.fn(async () => ({ status: 200, body: hybrid })),
    ingestCandidates: jest.fn(async () => ({ status: 200, body: hybrid })),
    ingestSources: jest.fn(async () => denied), refreshSources: jest.fn(async () => denied), ingestionStatus: jest.fn(async () => denied),
  };
}
const writeInput = { game: 'Fixture Game', sourceUrls: ['https://guide.example.invalid/fixture'], idempotencyKey: 'fixture-store-001',
  storagePolicy: 'ask_before_store', confirmStore: true };
const queryInput = { contractVersion: 'gaming-hybrid-v1', question: 'Where next?', game: 'Fixture Game', idempotencyKey: 'fixture-query-001', storagePolicy: 'ask_before_store' };
function app(options: Parameters<typeof createChatGptGamingMcpRouter>[0] = {}, parentRemainingMs?: number,
  parentController?: AbortController) {
  const result = express();
  if (parentRemainingMs !== undefined) result.use((_req, _res, next) => {
    const controller = parentController ?? new AbortController();
    runWithRequestAbortContext({ controller, signal: controller.signal, deadlineAt: Date.now() + parentRemainingMs,
      timeoutMs: parentRemainingMs }, () => next());
  });
  result.use(createChatGptGamingMcpRouter({ configuration, verification: { keyResolver, readEnvironmentValue: () => undefined },
    providerAdmission: (_req, _res, next) => next(), ...options }));
  result.use(express.json()); result.post('/gpt/fixture', (req, res) => res.json(req.body));
  return result;
}
const post = (application = app()) => request(application).post(GAMING_MCP_PATH).set('Accept', 'application/json, text/event-stream');
const rpc = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('private Gaming OAuth authority', () => {
  it.each(['CHATGPT_GAMING_ISSUER', 'CHATGPT_GAMING_RESOURCE', 'CHATGPT_GAMING_JWKS_URL', 'CHATGPT_GAMING_OWNER_SUBJECT'])(
    'fails closed without %s', name => expect(readGamingAuthConfiguration(key => key === name ? undefined : env[key])).toEqual({ status: 'misconfigured' }));
  it('is disabled by default and rejects the Tutor resource', () => {
    expect(readGamingAuthConfiguration(() => undefined)).toEqual({ status: 'disabled' });
    expect(readGamingAuthConfiguration(key => key === 'CHATGPT_GAMING_RESOURCE' ? 'https://gaming-resource.invalid/chatgpt/mcp' : env[key])).toEqual({ status: 'misconfigured' });
  });
  it.each([{ sub: 'different-owner' }, { aud: 'https://gaming-resource.invalid/chatgpt/mcp' }, { scope: 'arcanos:tutor' },
    { scope: GAMING_WRITE_SCOPE }, { scope: 'operator:admin' }, { exp: 1 }, { iss: 'https://other.invalid/' }])('rejects %j', async claims => {
    const result = await createGamingTokenVerifier(configuration, { keyResolver })(`Bearer ${await token(claims)}`);
    expect(result.ok).toBe(false);
  });
  it.each(PURPOSE_BOUND_CREDENTIAL_ENV_NAMES)('rejects purpose-bound token reuse: %s', async name => {
    const signed = await token();
    expect((await createGamingTokenVerifier(configuration, { keyResolver, readEnvironmentValue: key => key === name ? signed : undefined })(`Bearer ${signed}`)).ok).toBe(false);
  });
  it('separates read and write grants; actor survives renewal without legacy impersonation', async () => {
    const read = await principal(); const write = await principal(true);
    expect(hasGamingPermission(read)).toBe(true); expect(hasGamingPermission(read, true)).toBe(false);
    expect(hasGamingPermission(write, true)).toBe(true); expect(hasGamingPermission({ ...write }, true)).toBe(false);
    expect(gamingPrincipalActorKey(read)).toBe(gamingPrincipalActorKey(write));
    expect(gamingPrincipalActorKey(read)).toMatch(/^chatgpt-gaming:[0-9a-f]{64}$/u);
    expect(JSON.stringify(write)).not.toContain('arcanos:tutor');
    jest.spyOn(Date, 'now').mockReturnValue(write.expiresAt * 1_000);
    expect(hasGamingPermission(write, true)).toBe(false);
  });
});

describe('Gaming fixed service execution and persistence boundary', () => {
  it('runs the bundled canary without claiming the legacy HTTP route or live providers', async () => {
    const result = await createGamingMcpExecutor()(await principal(), 'arcanos_gaming_canary', {});
    expect(result).toMatchObject({ statusCode: 200, result: { ok: true, route: 'gaming_mcp_canary',
      checks: { dispatcher: 'passed', requestValidation: 'passed', publicRoute: 'skipped', providerExecution: 'skipped', networkRetrieval: 'skipped' } } });
    expect(result.result.message).toContain('were not checked');
  });
  it('clears inherited session context and calls only gameplay query', async () => {
    const deps = services(); deps.query = jest.fn(async () => {
      expect(readSessionContext()).toBeUndefined();
      return { ok: true, route: 'gaming', mode: 'guide', data: { response: 'Fixture guide.', sources: [] } };
    });
    const owner = await principal();
    await runWithSessionContext('unrelated private history', () => createGamingMcpExecutor(deps)(owner, 'arcanos_gaming_query', { mode: 'guide', prompt: 'Next step', game: 'Fixture Game', progressPoint: 'First town' }));
    expect(deps.query).toHaveBeenCalledTimes(1); expect(deps.ingestSources).not.toHaveBeenCalled();
  });
  it.each(['arcanos_gaming_hybrid_query', 'arcanos_gaming_submit_candidates'] as const)('denies implicit storage in %s even for write owner', async name => {
    const deps = services(); const input = name === 'arcanos_gaming_hybrid_query' ? queryInput
      : { contractVersion: 'gaming-hybrid-v1', workflowId: hybrid.workflowId, idempotencyKey: 'fixture-candidates-001', candidates: [{ url: 'https://guide.example.invalid/fixture' }] };
    await createGamingMcpExecutor(deps)(await principal(true), name, input, { autoStoreApproved: true });
    expect(name === 'arcanos_gaming_hybrid_query' ? deps.hybridQuery : deps.candidates).toHaveBeenCalledWith(input,
      expect.objectContaining({ canStore: false, canAutoStore: false, actorKey: expect.stringMatching(/^chatgpt-gaming:/u) }));
    expect(deps.ingestCandidates).not.toHaveBeenCalled();
  });
  it.each([{ ...writeInput, confirmStore: false }, { ...writeInput, confirmStore: undefined },
    { ...writeInput, storagePolicy: 'transient_only' }, { ...writeInput, storagePolicy: 'auto_store_approved' },
    { ...writeInput, actorKey: 'forged-owner' }, { ...writeInput, scope: GAMING_WRITE_SCOPE },
    { ...writeInput, sourceUrls: Array(5).fill('https://guide.example.invalid/fixture') }])('rejects unsafe write %j before services', async input => {
    const deps = services();
    await expect(createGamingMcpExecutor(deps)(await principal(true), 'arcanos_gaming_ingest_sources', input)).rejects.toThrow();
    expect(deps.ingestSources).not.toHaveBeenCalled();
  });
  it('read scope cannot ingest; confirmed write strips MCP consent and preserves idempotency', async () => {
    const deps = services(); const execute = createGamingMcpExecutor(deps);
    await expect(execute(await principal(), 'arcanos_gaming_ingest_sources', writeInput)).rejects.toThrow('GAMING_PERMISSION_DENIED');
    const owner = await principal(true);
    await execute(owner, 'arcanos_gaming_ingest_sources', writeInput);
    expect(deps.ingestSources).toHaveBeenCalledWith({ action: 'ingest', payload: { game: writeInput.game, sourceUrls: writeInput.sourceUrls, idempotencyKey: writeInput.idempotencyKey } },
      expect.objectContaining({ actorKey: gamingPrincipalActorKey(owner), canStore: true }));
  });
  it('automatic candidate ingestion additionally needs standing permission and explicit confirmation', async () => {
    const deps = services(); const execute = createGamingMcpExecutor(deps); const owner = await principal(true);
    const input = { contractVersion: 'gaming-hybrid-v1', workflowId: hybrid.workflowId, candidateIds: ['22222222-2222-4222-8222-222222222222'],
      idempotencyKey: 'fixture-candidate-store', storagePolicy: 'auto_store_approved', confirmStore: true };
    await expect(execute(owner, 'arcanos_gaming_ingest_candidates', input)).rejects.toThrow('GAMING_AUTO_STORAGE_FORBIDDEN');
    await execute(owner, 'arcanos_gaming_ingest_candidates', input, { autoStoreApproved: true });
    expect(deps.ingestCandidates).toHaveBeenCalledWith(input, expect.objectContaining({ canStore: true, canAutoStore: true }));
  });
  it('status always forwards only the verified OAuth actor; malformed service output fails closed', async () => {
    const deps = services(); const owner = await principal(); const execute = createGamingMcpExecutor(deps);
    await execute(owner, 'arcanos_gaming_ingestion_status', { ingestionId: hybrid.workflowId });
    expect(deps.ingestionStatus).toHaveBeenCalledWith(hybrid.workflowId, expect.objectContaining({ actorKey: gamingPrincipalActorKey(owner), canStore: false }));
    deps.hybridQuery = jest.fn(async () => ({ status: 200, body: { state: 'answer_ready' } }));
    await expect(createGamingMcpExecutor(deps)(owner, 'arcanos_gaming_hybrid_query', queryInput)).rejects.toThrow('GAMING_OUTPUT_INVALID');
  });
});

describe('Gaming MCP execution deadlines', () => {
  let originalModuleTimeoutMs: string | undefined;
  beforeEach(() => {
    originalModuleTimeoutMs = readRuntimeEnv('ARCANOS_GAMING_MODULE_TIMEOUT_MS');
    unsetRuntimeEnv('ARCANOS_GAMING_MODULE_TIMEOUT_MS');
  });
  afterEach(() => {
    if (originalModuleTimeoutMs === undefined) unsetRuntimeEnv('ARCANOS_GAMING_MODULE_TIMEOUT_MS');
    else writeRuntimeEnv('ARCANOS_GAMING_MODULE_TIMEOUT_MS', originalModuleTimeoutMs);
  });
  const providerOperations: [ChatGptGamingToolName, Record<string, unknown>][] = [
    ['arcanos_gaming_query', { mode: 'build', prompt: 'bleed Samurai build', game: 'Elden Ring' }],
    ['arcanos_gaming_hybrid_query', queryInput],
    ['arcanos_gaming_submit_candidates', { contractVersion: 'gaming-hybrid-v1', workflowId: hybrid.workflowId,
      idempotencyKey: 'fixture-candidates-001', candidates: [{ url: 'https://guide.example.invalid/fixture' }] }],
  ];
  async function observedTimeout(name: ChatGptGamingToolName, input: Record<string, unknown>,
    options: Parameters<typeof createChatGptGamingMcpRouter>[0] = {}, parentRemainingMs?: number) {
    let timeoutMs: number | undefined;
    const execute = jest.fn(async () => {
      timeoutMs = getRequestAbortContext()?.timeoutMs;
      return { statusCode: 200, result: hybrid };
    });
    const response = await post(app({ ...options, execute }, parentRemainingMs))
      .set('Authorization', 'Bearer ' + await token({ scope: GAMING_QUERY_SCOPE + ' ' + GAMING_WRITE_SCOPE }))
      .send(rpc(name, input)).expect(200);
    expect(response.body.result.structuredContent).toEqual({ statusCode: 200, result: hybrid });
    expect(execute).toHaveBeenCalledTimes(1);
    return timeoutMs!;
  }
  it.each(providerOperations)('%s receives the shared 60-second provider envelope', async (name, input) => {
    expect(GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS).toBe(60_000);
    expect(await observedTimeout(name, input)).toBe(GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS);
  });
  it.each(providerOperations)('%s respects a lower operator module cap', async (name, input) => {
    writeRuntimeEnv('ARCANOS_GAMING_MODULE_TIMEOUT_MS', '25000');
    expect(await observedTimeout(name, input)).toBe(25_000);
  });
  it.each(providerOperations)('%s cannot expand the safe envelope through a higher override', async (name, input) => {
    writeRuntimeEnv('ARCANOS_GAMING_MODULE_TIMEOUT_MS', '120000');
    expect(await observedTimeout(name, input, { timeoutMs: 120_000 })).toBe(60_000);
  });
  it.each(providerOperations)('%s retains the internal lower timeout cap', async (name, input) => {
    expect(await observedTimeout(name, input, { timeoutMs: 25_000 })).toBe(25_000);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an exhausted or invalid internal timeout cap: %s', async timeoutMs => {
    const execute = jest.fn<ReturnType<typeof createGamingMcpExecutor>>();
    const response = await post(app({ execute, timeoutMs })).set('Authorization', 'Bearer ' + await token())
      .send(rpc('arcanos_gaming_hybrid_query', queryInput)).expect(200);
    expect(response.body.result).toMatchObject({ isError: true, content: [{ text: 'GAMING_TIMEOUT' }] });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(providerOperations)('%s clamps to a caller with only 30 seconds remaining', async (name, input) => {
    const timeoutMs = await observedTimeout(name, input, {}, 30_000);
    expect(timeoutMs).toBeGreaterThan(29_000);
    expect(timeoutMs).toBeLessThanOrEqual(30_000);
  });
  it.each([
    ['arcanos_gaming_canary', {}, 5_000],
    ['arcanos_gaming_ingestion_status', { ingestionId: hybrid.workflowId }, 10_000],
    ['arcanos_gaming_ingest_sources', writeInput, 20_000],
    ['arcanos_gaming_refresh_sources', { sourceIds: [hybrid.workflowId], idempotencyKey: 'fixture-refresh-001',
      storagePolicy: 'ask_before_store', confirmStore: true }, 20_000],
    ['arcanos_gaming_ingest_candidates', { contractVersion: 'gaming-hybrid-v1', workflowId: hybrid.workflowId,
      candidateIds: ['22222222-2222-4222-8222-222222222222'], idempotencyKey: 'fixture-store-candidates',
      storagePolicy: 'ask_before_store', confirmStore: true }, 38_000],
  ] as [ChatGptGamingToolName, Record<string, unknown>, number][])(
    '%s retains its shorter fixture/status/write deadline', async (name, input, expectedTimeoutMs) => {
      expect(await observedTimeout(name, input)).toBe(expectedTimeoutMs);
    });
  it('does not start an operation after its parent deadline is exhausted', async () => {
    const execute = jest.fn<ReturnType<typeof createGamingMcpExecutor>>();
    const response = await post(app({ execute }, 0)).set('Authorization', 'Bearer ' + await token())
      .send(rpc('arcanos_gaming_hybrid_query', queryInput)).expect(200);
    expect(response.body.result).toMatchObject({ isError: true, content: [{ text: 'GAMING_TIMEOUT' }] });
    expect(execute).not.toHaveBeenCalled();
  });
  it('inherits parent cancellation before executing backend work', async () => {
    const controller = new AbortController(); controller.abort();
    const execute = jest.fn<ReturnType<typeof createGamingMcpExecutor>>();
    const response = await post(app({ execute }, 30_000, controller)).set('Authorization', 'Bearer ' + await token())
      .send(rpc('arcanos_gaming_hybrid_query', queryInput)).expect(200);
    expect(response.body.result).toMatchObject({ isError: true, content: [{ text: 'GAMING_CANCELLED' }] });
    expect(execute).not.toHaveBeenCalled();
  });
  it('logs the execution envelope without question or OAuth identity', async () => {
    const info = jest.fn();
    const application = express();
    application.use((req, _res, next) => {
      req.logger = { info, debug: jest.fn(), warn: jest.fn(), error: jest.fn() }; next();
    });
    application.use(app({ execute: async () => ({ statusCode: 200, result: hybrid }) }));
    await post(application).set('Authorization', 'Bearer ' + await token())
      .send(rpc('arcanos_gaming_hybrid_query', queryInput)).expect(200);
    expect(info).toHaveBeenCalledWith('gaming.mcp.execution_budget', { mcpOperationTimeoutMs: 60_000, requestRemainingMs: null });
    expect(JSON.stringify(info.mock.calls)).not.toContain(queryInput.question);
    expect(JSON.stringify(info.mock.calls)).not.toContain(configuration.ownerSubject);
  });
});

describe('Gaming MCP HTTP boundary', () => {
  it('propagates timeout cancellation without exposing private exception details', async () => {
    let signal: AbortSignal | undefined;
    const execute = jest.fn(async () => {
      signal = getRequestAbortSignal();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { statusCode: 200, result: hybrid };
    });
    const response = await post(app({ execute, timeoutMs: 20 })).set('Authorization', 'Bearer ' + await token())
      .send(rpc('arcanos_gaming_hybrid_query', queryInput)).expect(200);
    expect(signal?.aborted).toBe(true);
    expect(response.body.result).toMatchObject({ isError: true, content: [{ text: 'GAMING_TIMEOUT' }] });
  });
  it('aborts backend work when its client disconnects', async () => {
    let started!: () => void; let aborted!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const abort = new Promise<void>(resolve => { aborted = resolve; });
    const execute = jest.fn(async () => {
      const signal = getRequestAbortSignal()!; started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      return { statusCode: 200, result: hybrid };
    });
    const server = createServer(app({ execute })).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number }; const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${address.port}${GAMING_MCP_PATH}`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(rpc('arcanos_gaming_hybrid_query', queryInput)),
      }).catch(() => undefined);
      await start; controller.abort(); await pending; await abort;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('publishes only Gaming scopes and authenticates before parsing', async () => {
    const metadata = await request(app()).get(GAMING_METADATA_PATH).expect(200);
    expect(metadata.body.scopes_supported).toEqual([GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE]);
    expect(JSON.stringify(metadata.body)).not.toContain(configuration.ownerSubject);
    await post().set('Content-Type', 'application/json').send('{').expect(401);
    await post().set('Authorization', 'Bearer ' + await token()).set('Content-Type', 'application/json').send('{').expect(400);
  });
  it('initializes and lists exactly eight scoped tools with distinct write annotations', async () => {
    const application = app(); const authorization = 'Bearer ' + await token();
    const initialized = await post(application).set('Authorization', authorization).send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }).expect(200);
    expect(initialized.body.result.serverInfo.name).toBe('arcanos-gaming-private');
    const listed = await post(application).set('Authorization', authorization).send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).expect(200);
    expect(listed.body.result.tools).toEqual(gamingMcpTools);
    expect(listed.body.result.tools.filter((tool: { annotations: { readOnlyHint: boolean } }) => !tool.annotations.readOnlyHint)).toHaveLength(5);
  });
  it.each(['modules.invoke', 'arcanos_tutor', 'jobs.create', 'db.inspect'])('denies cross-plugin tool %s', async name => {
    const execute = jest.fn<ReturnType<typeof createGamingMcpExecutor>>();
    const response = await post(app({ execute })).set('Authorization', 'Bearer ' + await token()).send(rpc(name, {})).expect(200);
    expect(response.body.result.isError).toBe(true); expect(execute).not.toHaveBeenCalled();
  });
  it('denies write grant before execution and returns Gaming-only scope upgrade metadata', async () => {
    const execute = jest.fn<ReturnType<typeof createGamingMcpExecutor>>();
    const response = await post(app({ execute })).set('Authorization', 'Bearer ' + await token()).send(rpc('arcanos_gaming_ingest_sources', writeInput)).expect(200);
    expect(response.body.result._meta['mcp/www_authenticate'][0]).toContain(GAMING_WRITE_SCOPE);
    expect(execute).not.toHaveBeenCalled();
  });
  it('preserves hybrid structured state and rejects host/authority injection', async () => {
    const execute = createGamingMcpExecutor(services()); const application = app({ execute }); const authorization = 'Bearer ' + await token();
    const response = await post(application).set('Authorization', authorization).send(rpc('arcanos_gaming_hybrid_query', queryInput)).expect(200);
    expect(response.body.result.structuredContent).toEqual({ statusCode: 200, result: hybrid });
    const rejected = await post(application).set('Authorization', authorization).send(rpc('arcanos_gaming_hybrid_query', { ...queryInput, backendHost: 'https://untrusted.invalid' })).expect(200);
    expect(rejected.body.result.isError).toBe(true);
  });
  it.each(['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates'] as ChatGptGamingToolName[])(
    '%s advertises separate write authority', name => {
      expect(gamingMcpTools.find(tool => tool.name === name)).toMatchObject({ securitySchemes: [{ type: 'oauth2', scopes: [GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE] }], annotations: { readOnlyHint: false } });
    });
});
