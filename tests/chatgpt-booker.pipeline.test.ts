import { jest } from '@jest/globals';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { ChatGptPrincipal } from '../src/chatgpt/auth.js';
import type { Request } from 'express';
import { createBookerMcpExecutor, type BookerMcpServices } from '../src/chatgpt/booker.js';
import { createBookerTokenVerifier, readBookerAuthConfiguration, bookerPrincipalActorKey, type ReadyBookerAuthConfiguration } from '../src/chatgpt/bookerAuth.js';
import { BOOKER_GENERATE_SCOPE, BOOKER_MCP_PATH, BOOKER_READ_SCOPE } from '../src/shared/chatgpt/bookerMcpContract.js';
import { readBackstageUniverse, readBackstageStorylineSummary } from '../src/services/backstageUniverseRead.js';
import { readBackstageBookerAsyncResultCore } from '../src/shared/backstage/backstageBookerAsyncResultCore.js';
import { buildGptIdempotencyScopeHash } from '../src/shared/gpt/gptIdempotency.js';
import { buildProtectedBackstageQueuedGptJobInput } from '../src/shared/gpt/asyncGptJob.js';
import { protectBackstageQueuedGptJobOutput } from '../src/shared/backstage/backstageQueuedJobResultProtection.js';
import type { JobData } from '../src/core/db/schema.js';

const universeId = 'booker-pipeline-fixture';
const jobId = '11111111-1111-4111-8111-111111111111';
const configuration: ReadyBookerAuthConfiguration = readBookerAuthConfiguration(name => ({
  CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: 'https://booker-issuer.invalid/',
  CHATGPT_BOOKER_RESOURCE: 'https://booker-resource.invalid' + BOOKER_MCP_PATH,
  CHATGPT_BOOKER_JWKS_URL: 'https://booker-issuer.invalid/jwks', CHATGPT_BOOKER_OWNER_SUBJECT: 'fixture-owner',
  CHATGPT_BOOKER_UNIVERSE_ID: universeId, CHATGPT_BOOKER_OAUTH_CLIENT_ID: 'fixture-client',
})[name]) as ReadyBookerAuthConfiguration;
let owner: ChatGptPrincipal;
let reader: ChatGptPrincipal;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' }] });
  const verify = createBookerTokenVerifier(configuration, { keyResolver, readEnvironmentValue: () => undefined });
  for (const generation of [false, true]) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: configuration.issuer, aud: configuration.resource,
      sub: configuration.ownerSubject, iat: now, exp: now + 300, client_id: configuration.oauthClientId,
      scope: BOOKER_READ_SCOPE + (generation ? ' ' + BOOKER_GENERATE_SCOPE : ''),
    }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' }).sign(keys.privateKey);
    const result = await verify('Bearer ' + token);
    if (!result.ok) throw new Error('Signed fixture rejected');
    if (generation) owner = result.principal; else reader = result.principal;
  }
});
const provenance = { version: 1, protected: true, protectedGenerationCompleted: true, official: true,
  continuityVerified: true, authority: 'notion', snapshotStatus: 'current_complete', fallbackUsed: false, fallbackPermitted: false };
const route = (action: string) => ({ gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', route: 'backstage-booker', action, timestamp: '2026-10-23T12:00:00.000Z' });
const generated = (action = 'generateBooking') => ({ ok: true, result: { universeId, storyline: 'A complete protected booking.',
  protectedGeneration: provenance, ...(action === 'generateBookingWithHRC' ? { hrc: { fidelity: 0.9, resilience: 0.8, verdict: 'Consistent.' } } : {}) }, _route: route(action) });
function services(): BookerMcpServices {
  return { run: jest.fn(async (_principal, action) => ({ statusCode: 200, result: generated(action) })),
    universe: jest.fn(async id => readBackstageUniverse(id, { authorityResolver: async () => false,
      reader: { loadContext: async () => ({ roster: [], events: [], storyBeats: [], storylines: [],
        canonContext: { universeId, revision: '0', storylines: [], activeBeats: [] } }) } })),
    storyline: jest.fn(async (id, key, options) => readBackstageStorylineSummary(id, key, { ...options,
      authorityResolver: async () => false, reader: { loadCanonStorylineSummary: async () => ({
        id: jobId, universeId, storyKey: key, title: 'Raw', summary: 'Exact saved text.\n', status: 'active', version: 2,
        createdRevision: '1', updatedRevision: '2', createdAt: new Date(), updatedAt: new Date(), closedAt: null,
      }) } })),
    job: jest.fn(async (input, dependencies) => readBackstageBookerAsyncResultCore({ ...input, pollIntervalMs: 500 }, {
      getJobByIdFn: dependencies.getJobByIdFn!, waitForQueuedGptJobCompletionFn: async () => { throw new Error('Unexpected wait'); },
    })), getJobById: jest.fn(async () => null) };
}

describe('Booker MCP fixed service parity', () => {
  it.each(['generateBooking', 'generateBookingWithHRC'] as const)('preserves %s payload and protected output without a second run', async name => {
    const dependencies = services();
    const input = { universeId, prompt: 'Produce one complete show.', idempotencyKey: 'same-request-001' };
    const output = await createBookerMcpExecutor(dependencies)(owner, name, input, { requestId: 'request' });
    expect(output.result).toMatchObject(generated(name));
    expect(dependencies.run).toHaveBeenCalledTimes(1);
    expect(dependencies.run).toHaveBeenCalledWith(owner, name, { universeId, prompt: input.prompt },
      { requestId: 'request', idempotencyKey: input.idempotencyKey });
  });
  it('preserves exact continuity scope, cursor and truthful sampled coverage', async () => {
    const dependencies = services();
    const result = { ok: true, result: { universeId, authority: 'notion', answer: 'A bounded answer.',
      coverage: { status: 'sampled', scopeChunks: 5, selectedChunks: 2, omittedChunks: 3, promptTruncated: false,
        exhaustive: false, hasMore: false }, sources: [] }, _route: route('queryContinuity') };
    dependencies.run = jest.fn(async () => ({ statusCode: 200, result }));
    const input = { universeId, query: 'What happened?', retrievalScope: { pageTitle: 'Raw', pagePath: ['WWE', 'Raw'], sectionPath: ['Main event'] }, retrievalMode: 'complete_scope' };
    expect((await createBookerMcpExecutor(dependencies)(reader, 'queryContinuity', input)).result).toEqual(result);
    expect(dependencies.run).toHaveBeenCalledWith(reader, 'queryContinuity', input, {});
  });
  it('passes match, numeric roster and odds modifier through to existing simulation and HRC', async () => {
    const dependencies = services();
    const input = { universeId, match: { wrestler1: 'A', wrestler2: 'B', matchType: 'Singles' },
      rosters: [{ name: 'A', overall: 90 }, { name: 'B', overall: 85 }], winProbModifier: 0.1 };
    dependencies.run = jest.fn(async () => ({ statusCode: 200, result: { ok: true, _route: route('simulateMatch'),
      result: { universeId, result: { match: 'A vs B (Singles)', winner: 'A', loser: 'B', probability: { A: '0.61', B: '0.39' },
        interference: null, rating: '4.2' }, hrc: { fidelity: 0.9, resilience: 0.8, verdict: 'Plausible.' } } } }));
    await createBookerMcpExecutor(dependencies)(owner, 'simulateMatch', input);
    expect(dependencies.run).toHaveBeenCalledWith(owner, 'simulateMatch', input, {});
  });
  it('uses bounded universe and exact storyline readers without generation', async () => {
    const dependencies = services();
    const execute = createBookerMcpExecutor(dependencies);
    const universe = await execute(reader, 'getBackstageUniverse', { universeId });
    expect(universe.result).toMatchObject({ ok: true, result: { universeId, hasPersistedData: false } });
    const storyline = await execute(reader, 'getBackstageStoryline', { universeId, storylineKey: 'raw / 🎤', offset: 0 });
    expect(storyline.result).toMatchObject({ ok: true, result: { storyline: { key: 'raw / 🎤', version: 2 }, summaryPage: { text: 'Exact saved text.\n' } } });
    expect(dependencies.run).not.toHaveBeenCalled();
  });
  it('forwards trusted logger context to generation without serializing it in read successes or failures', async () => {
    const dependencies = services();
    const logger = { info: jest.fn(), privateLoggerSentinel: 'logger-context-only' } as unknown as Request['logger'];
    const execute = createBookerMcpExecutor(dependencies);
    const options = { requestId: 'request', traceId: 'trace', logger };
    await execute(owner, 'generateBooking', { universeId, prompt: 'Book Raw.' }, options);
    expect(dependencies.run).toHaveBeenCalledWith(owner, 'generateBooking', { universeId, prompt: 'Book Raw.' }, options);
    for (const output of [await execute(reader, 'getBackstageUniverse', { universeId }, options),
      await execute(reader, 'getBackstageStoryline', { universeId, storylineKey: 'Raw' }, options),
      await execute(reader, 'getBackstageStoryline', { universeId, storylineKey: 'Raw', offset: 100, expectedVersion: 2 }, options)]) {
      expect(output.result).toMatchObject({ requestId: 'request', traceId: 'trace' });
      expect(output.result).not.toHaveProperty('logger'); expect(JSON.stringify(output)).not.toContain('logger-context-only');
    }
  });
  it('rejects changed universe, missing generation permission and attempted operator input before services', async () => {
    const dependencies = services(); const execute = createBookerMcpExecutor(dependencies);
    await expect(execute(owner, 'getBackstageUniverse', { universeId: 'other-universe' })).rejects.toThrow('BOOKER_PERMISSION_DENIED');
    await expect(execute(reader, 'generateBooking', { universeId, prompt: 'Book Raw.' })).rejects.toThrow('BOOKER_PERMISSION_DENIED');
    await expect(execute(owner, 'generateBooking', { universeId, prompt: 'Book Raw.', action: 'upsertStoryline' })).rejects.toThrow('BOOKER_INPUT_INVALID');
    expect(dependencies.run).not.toHaveBeenCalled(); expect(dependencies.universe).not.toHaveBeenCalled();
  });
  it('preserves authority quarantine and sanitizes unrecognized backend failures without a replacement run', async () => {
    const dependencies = services(); dependencies.universe = jest.fn(async () => { throw { code: 'BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED' }; });
    dependencies.run = jest.fn(async () => { throw new Error('private partial draft sentinel'); });
    const execute = createBookerMcpExecutor(dependencies);
    expect(await execute(reader, 'getBackstageUniverse', { universeId })).toMatchObject({ statusCode: 409,
      result: { ok: false, error: { code: 'BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED', retryable: false } } });
    const failed = await execute(owner, 'generateBooking', { universeId, prompt: 'Book Raw.' });
    expect(failed).toMatchObject({ statusCode: 503, result: { result: null, official: false, protectedGenerationCompleted: false } });
    expect(JSON.stringify(failed)).not.toContain('private partial draft sentinel'); expect(dependencies.run).toHaveBeenCalledTimes(1);
  });
  it('blocks other-universe and other-actor jobs before wait or result unsealing', async () => {
    for (const mismatch of ['universe', 'actor']) {
      const dependencies = services();
      const job = { id: jobId, job_type: 'gpt', status: 'running', input: {
        gptId: 'backstage-booker', protectedBackstage: { version: 1, source: 'backstage-booker-http', envelopeId: jobId,
          action: 'generateBooking', universeId: mismatch === 'universe' ? 'other' : universeId, sealedPayload: {} },
      }, idempotency_scope_hash: buildGptIdempotencyScopeHash({ surface: 'public-gpt', actorKey: mismatch === 'actor' ? 'other' : bookerPrincipalActorKey(owner) }) } as JobData;
      dependencies.getJobById = jest.fn(async () => job);
      const output = await createBookerMcpExecutor(dependencies)(owner, 'getBackstageBookerJobResult', { universeId, jobId });
      expect(output.result).toMatchObject({ status: 'not_found', result: null }); expect(dependencies.run).not.toHaveBeenCalled();
    }
  });
  it.each(['legacy', 'unverified', 'other-universe'] as const)('withholds %s generation success without replacement inference', async kind => {
    const dependencies = services();
    const envelope = generated();
    dependencies.run = jest.fn(async () => ({ statusCode: 200, result: kind === 'legacy' ? { ...envelope, result: 'A legacy unverified story.' }
      : { ...envelope, result: { ...envelope.result, ...(kind === 'unverified' ? { protectedGeneration: undefined } : { universeId: 'other-universe' }) } } }));
    const output = await createBookerMcpExecutor(dependencies)(owner, 'generateBooking', { universeId, prompt: 'Book Raw.' });
    expect(output).toMatchObject({ statusCode: 503, result: { result: null, official: false, protectedGenerationCompleted: false, error: { code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE' } } });
    expect(dependencies.run).toHaveBeenCalledTimes(1);
  });
  it('preserves actual out-of-range storyline pagination as a validation failure', async () => {
    const execute = createBookerMcpExecutor(services());
    expect(await execute(reader, 'getBackstageStoryline', { universeId, storylineKey: 'Raw', offset: 100, expectedVersion: 2 }))
      .toMatchObject({ statusCode: 400, result: { ok: false, error: { code: 'GPT_ACCESS_VALIDATION_ERROR' } } });
  });
  it.each(['getBackstageUniverse', 'getBackstageStoryline'] as const)('preserves %s repository and unexpected read failure classifications', async name => {
    for (const unavailable of [true, false]) {
      const dependencies = services();
      const fail = async () => { throw unavailable ? { code: 'BACKSTAGE_BOOKER_REPOSITORY_UNAVAILABLE' } : new TypeError('private invalid row sentinel'); };
      if (name === 'getBackstageUniverse') dependencies.universe = fail; else dependencies.storyline = fail;
      const output = await createBookerMcpExecutor(dependencies)(reader, name, { universeId, ...(name === 'getBackstageStoryline' ? { storylineKey: 'Raw' } : {}) });
      expect(output).toMatchObject({ statusCode: unavailable ? 503 : 500, result: { ok: false, error: {
        code: `BACKSTAGE_${name === 'getBackstageStoryline' ? 'STORYLINE' : 'UNIVERSE'}_READ_${unavailable ? 'UNAVAILABLE' : 'FAILED'}`,
        ...(unavailable ? { retryable: true } : {}),
      } } });
      expect(JSON.stringify(output)).not.toContain('private invalid row sentinel'); expect(dependencies.run).not.toHaveBeenCalled();
    }
  });
  it('unseals only the same owned official result, with no duplicate inference during repeated continuation', async () => {
    const original = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = Buffer.alloc(32, 0x52).toString('base64');
    try {
      const dependencies = services();
      const input = buildProtectedBackstageQueuedGptJobInput({ body: { action: 'generateBooking', payload: { universeId, prompt: 'Book Raw.' } },
        prompt: 'Book Raw.', action: 'generateBooking', universeId, notionEnrichmentAuthorized: true, requestId: 'request', traceId: 'trace', correlationId: 'trace', executionModeReason: 'fixture' });
      const job = { id: jobId, job_type: 'gpt', status: 'completed', input, created_at: new Date(), updated_at: new Date(), completed_at: new Date(),
        idempotency_scope_hash: buildGptIdempotencyScopeHash({ surface: 'public-gpt', actorKey: bookerPrincipalActorKey(owner) }),
        output: protectBackstageQueuedGptJobOutput({ jobId, rawInput: input, output: generated() }) } as JobData;
      dependencies.getJobById = jest.fn(async () => job);
      const execute = createBookerMcpExecutor(dependencies);
      for (let count = 0; count < 2; count++) expect((await execute(owner, 'getBackstageBookerJobResult', { universeId, jobId, waitForResultMs: 0 })).result)
        .toMatchObject({ status: 'completed', result: generated() });
      expect(dependencies.run).not.toHaveBeenCalled();
    } finally { if (original === undefined) delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY; else process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = original; }
  });
});
