import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as requestPublisher, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

const guideUrl = 'https://guides.example.org/elden-ring/equipment-load';
const question = 'How do I avoid heavy rolling in Elden Ring?';
const mockHttp = jest.fn();
const mockTrinity = jest.fn();
const mockAuditCompletion = jest.fn();
const mockIngest = jest.fn(async () => { throw new Error('Durable source writes are forbidden in this fixture.'); });
const mockDatabaseAccess = jest.fn(async () => { throw new Error('Database and player persistence are outside this transient fixture.'); });
const mockBackendSearch = jest.fn(async () => { throw new Error('Guide discovery belongs to the frontend.'); });
const pages = new Map<string, { html: string; answer?: string; contentType?: string; status?: number; gzip?: boolean; redirect?: string; timeout?: boolean }>();
const publisherRequests: Array<{ path: string; host: string; method: string }> = [];
let publisher: Server;
let publisherOrigin: string;
let clock = Date.parse('2026-10-12T12:00:00Z');
let privateDns = false;

// The publisher is a deterministic loopback HTTP server and semantic providers
// are sealed fixtures. Only the test Axios seam maps a DNS-pinned public target
// to loopback; production HTTPS/SSRF admission remains enabled. The served
// MCP authentication/schema boundary, protected transport, parser, identity,
// CLEAR, selection, Trinity handoff and answer/citation validation remain real.
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return [privateDns ? '127.0.0.1' : '93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: mockTrinity }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createSingleChatCompletion: mockAuditCompletion, createChatCompletionWithFallback: jest.fn(), ensureModelMatchesExpectation: jest.fn()
}));
jest.unstable_mockModule('../src/core/db/client.js', () => ({
  getPool: () => ({ query: mockDatabaseAccess, connect: mockDatabaseAccess }), isDatabaseConnected: () => true,
  initializeDatabase: mockDatabaseAccess, closePoolIfCurrent: jest.fn(), close: jest.fn(), getStatus: jest.fn()
}));
jest.unstable_mockModule('../src/core/db/index.js', () => ({
  getPool: () => ({ query: mockDatabaseAccess, connect: mockDatabaseAccess }), isDatabaseConnected: () => true,
  query: mockDatabaseAccess, transaction: mockDatabaseAccess
}));
const discovery = await import('../src/services/gamingSourceDiscovery.js');
jest.unstable_mockModule('../src/services/gamingSourceDiscovery.js', () => ({
  ...discovery, discoverGamingSources: mockBackendSearch
}));

const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { createGamingMcpExecutor } = await import('../src/chatgpt/gaming.js');
const { createChatGptGamingMcpRouter } = await import('../src/routes/chatgptGamingMcp.js');
const { readGamingAuthConfiguration } = await import('../src/chatgpt/gamingAuth.js');
const { GAMING_MCP_PATH, GAMING_QUERY_SCOPE, isGamingMcpOutput } = await import('../src/shared/chatgpt/gamingMcpContract.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { requestContext } = await import('../src/middleware/requestContext.js');
const { resetSafetyRuntimeStateForTests } = await import('../src/services/safety/runtimeState.js');
const v2 = 'gaming-hybrid-v2';
const env = {
  ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '12000',
  ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200'
};
const authEnv: Record<string, string> = {
  CHATGPT_GAMING_ENABLED: 'true', CHATGPT_GAMING_ISSUER: 'https://fixture-issuer.invalid/',
  CHATGPT_GAMING_RESOURCE: 'https://fixture-resource.invalid/chatgpt/gaming/mcp',
  CHATGPT_GAMING_JWKS_URL: 'https://fixture-issuer.invalid/jwks', CHATGPT_GAMING_OWNER_SUBJECT: 'ordinary-negative-fixture-owner'
};
const configuration = readGamingAuthConfiguration(name => authEnv[name]);
if (configuration.status !== 'ready') throw new Error('Expected sealed Gaming OAuth configuration.');
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;
let previousEnv: Record<string, string | undefined>;
let previousByteLimit: string | undefined;

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'ordinary-negative-fixture', alg: 'RS256' }] });
  publisher = createServer((incoming, outgoing) => {
    const host = incoming.headers.host ?? '';
    const path = incoming.url ?? '';
    publisherRequests.push({ path, host, method: incoming.method ?? '' });
    const page = pages.get(`https://${host}${path}`);
    outgoing.statusCode = page ? page.status ?? 200 : 404;
    outgoing.setHeader('Content-Type', page?.contentType ?? 'text/html');
    if (page?.gzip) outgoing.setHeader('Content-Encoding', 'gzip');
    if (page?.redirect) outgoing.setHeader('Location', page.redirect);
    outgoing.end(page?.gzip ? gzipSync(page.html) : page?.html ?? 'No deterministic publisher response.');
  });
  await new Promise<void>(resolve => publisher.listen(0, '127.0.0.1', resolve));
  publisherOrigin = `http://127.0.0.1:${(publisher.address() as AddressInfo).port}`;
});
afterAll(async () => new Promise<void>((resolve, reject) => publisher.close(error => error ? reject(error) : resolve())));
beforeEach(() => {
  privateDns = false; pages.clear(); publisherRequests.length = 0; jest.clearAllMocks(); resetSafetyRuntimeStateForTests();
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  previousByteLimit = process.env.WEB_FETCH_MAX_BYTES;
  delete process.env.WEB_FETCH_MAX_BYTES;
  clock = Date.parse('2026-10-12T12:00:00Z');
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'clearImmediate', 'nextTick', 'hrtime', 'performance', 'queueMicrotask'] });
  jest.setSystemTime(clock);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockHttp.mockImplementation(async (url: string, options: any) => {
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('93.184.216.34');
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'stream' });
    expect(options.headers).not.toHaveProperty('Cookie');
    expect(options.headers).not.toHaveProperty('Authorization');
    clock += 25; jest.setSystemTime(clock);
    if (pages.get(`https://${options.headers.Host ?? options.headers.host}${parsed.pathname}${parsed.search}`)?.timeout) {
      clock += 6_000; jest.setSystemTime(clock);
    }
    return new Promise((resolve, reject) => {
      const outgoing = requestPublisher(`${publisherOrigin}${parsed.pathname}${parsed.search}`, {
        headers: options.headers, signal: options.signal
      }, incoming => {
        incoming.on('error', () => undefined);
        resolve({ status: incoming.statusCode, headers: incoming.headers, data: incoming });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  });
  mockAuditCompletion.mockImplementation(async (_client: unknown, params: any) => {
    const data = JSON.parse(params.messages[1].content);
    const refs = data.evidence.map((chunk: any) => chunk.chunkId);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      dimensions: Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
        status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED_FIXTURE'], evidenceRefs: refs.slice(0, 8), unresolvedFacts: []
      }])), findings: []
    }) } }], usage: { prompt_tokens: 400, completion_tokens: 150, total_tokens: 550 } };
  });
  mockTrinity.mockImplementation(async (providerRequest: any) => {
    const blocks = String(providerRequest.input.prompt).split(/(?=^\[Source \d+\])/mu);
    const result = blocks.flatMap(block => {
      const number = /^\[Source (\d+)\]/u.exec(block)?.[1];
      const url = /^URL: (.+)$/mu.exec(block)?.[1];
      const answer = url && pages.get(url)?.answer;
      return answer && number ? [`${answer} [Source ${number}]`] : [];
    }).join('\n\n');
    const { assessment } = await providerRequest.context.runOptions.gamingClearAnswerAudit(result, {});
    return { result, gamingClearAudit: assessment, meta: { provider: { finishReason: 'stop' } } };
  });
});
afterEach(() => {
  expect(mockIngest).not.toHaveBeenCalled();
  expect(mockDatabaseAccess).not.toHaveBeenCalled();
  expect(mockBackendSearch).not.toHaveBeenCalled();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (previousByteLimit === undefined) delete process.env.WEB_FETCH_MAX_BYTES;
  else process.env.WEB_FETCH_MAX_BYTES = previousByteLimit;
  jest.restoreAllMocks(); jest.useRealTimers(); resetSafetyRuntimeStateForTests();
});

function harness(sharedWorkflow?: ReturnType<typeof createGamingHybridWorkflow>, owner = configuration.ownerSubject) {
  // No stored evidence, SQL, jobs, or player persistence service is part of this
  // transient fixture; source ingestion is independently trapped above.
  const retrieve = jest.fn(async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }));
  const workflow = sharedWorkflow ?? createGamingHybridWorkflow({ retrieve, ingest: mockIngest as never, now: () => clock });
  const execute = createGamingMcpExecutor({ hybridQuery: workflow.query, candidates: workflow.candidates, ingestCandidates: workflow.ingest });
  const app = express();
  app.use(requestContext);
  app.use(createChatGptGamingMcpRouter({ configuration: { ...configuration, ownerSubject: owner }, verification: { keyResolver, readEnvironmentValue: () => undefined },
    providerAdmission: (_req, _res, next) => next(), execute }));
  let sequence = 0;
  async function invoke(name: string, input: unknown, options: { scope?: string; subject?: string; expectStructured?: boolean; expectedHttpStatus?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: configuration.issuer, aud: configuration.resource,
      sub: options.subject ?? owner, iat: now, exp: now + 3600, scope: options.scope ?? GAMING_QUERY_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'ordinary-negative-fixture' }).sign(keys.privateKey);
    const response = await request(app).post(GAMING_MCP_PATH).set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: input } });
    expect(response.status).toBe(options.expectedHttpStatus ?? 200);
    if (options.expectedHttpStatus && options.expectedHttpStatus !== 200) return response.body as any;
    if (options.expectStructured === false) return response.body.result as any;
    expect(isGamingMcpOutput(name as never, response.body.result.structuredContent)).toBe(true);
    return response.body.result.structuredContent as { statusCode: number; result: GamingHybridResponse };
  }
  const query = (overrides: Record<string, unknown> = {}) => invoke('arcanos_gaming_hybrid_query', {
    contractVersion: v2, game: 'Elden Ring', mode: 'guide',
    question, idempotencyKey: 'negative-query-001', storagePolicy: 'transient_only', ...overrides
  });
  const submit = (state: GamingHybridResponse, urls: string | string[], claims: Record<string, unknown> = {}, key = 'negative-source-001', extras: Record<string, unknown> = {}) => invoke('arcanos_gaming_submit_candidates', {
    contractVersion: state.contractVersion, workflowId: state.workflowId,
    ...(state.contractVersion === v2 ? { expectedRevision: state.revision } : {}),
    discoveryType: state.discovery?.type ?? 'gameplay_evidence', idempotencyKey: key, candidates: (typeof urls === 'string' ? [urls] : urls).map(url => ({ url, ...claims })), ...extras
  });
  return { workflow, retrieve, query, submit, app, invoke };
}


// All acquisition bytes below are synthetic local files. They preserve the
// meaningful identity/topic/edition signals but are not production wiki captures.
function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/gamingAcceptance/${name}.html`, import.meta.url), 'utf8');
}
function equipmentPage(url = guideUrl, extras: Partial<{ html: string; answer: string; status: number; gzip: boolean; redirect: string; timeout: boolean }> = {}) {
  pages.set(url, { html: fixture('equipment-load'),
    answer: 'Keep equipped weight below 70 percent of maximum equipment load to avoid heavy rolling.', ...extras });
}
function assertNoAnswer(state: GamingHybridResponse) {
  expect(state.state).not.toBe('answer_ready');
  expect(state.answer).toBeUndefined();
}
function providerFindings(code: string, invalidRefs = false) {
  mockAuditCompletion.mockImplementation(async (_client: unknown, params: any) => {
    const data = JSON.parse(params.messages[1].content);
    const refs = data.evidence.map((chunk: any) => chunk.chunkId);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      dimensions: Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
        status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED_FIXTURE'],
        evidenceRefs: invalidRefs ? ['nonexistent-evidence-id'] : refs.slice(0, 8), unresolvedFacts: []
      }])), findings: code ? [{ code, severity: 'blocking', evidenceRefs: refs.slice(0, 1) }] : []
    }) } }], usage: { prompt_tokens: 400, completion_tokens: 150, total_tokens: 550 } };
  });
}

describe('ordinary Gaming negative controls through authenticated served MCP', () => {
  it.each(['gaming-hybrid-v1', v2].flatMap(protocol => [
    { protocol, name: 'wrong-game', reason: 'GAME_MISMATCH' },
    { protocol, name: 'dlc', reason: 'EDITION_CONFLICT' },
    { protocol, name: 'ambiguous-location', reason: 'GAME_IDENTITY_UNVERIFIED' }
  ]))('rejects $name under $protocol without trusting discovery claims', async ({ protocol, name, reason }) => {
    const url = 'https://guides.example.org/church-of-elleh';
    pages.set(url, { html: fixture(name), answer: 'Rest at the Site of Grace at Church of Elleh.' });
    const run = harness();
    const initial = await run.query({ contractVersion: protocol, edition: 'base-game',
      question: 'What should I do at the Church of Elleh before moving on?', currentArea: 'Church of Elleh' });
    const final = await run.submit(initial.result, url, { claimedGame: 'Elden Ring',
      title: 'Elden Ring Church of Elleh', claimedPublisher: 'Official publisher' });
    expect(final.result.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: [reason] });
    assertNoAnswer(final.result);
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).not.toHaveBeenCalled();
    expect(mockAuditCompletion).not.toHaveBeenCalled();
  });

  it('does not let a game-qualified location title hide contradictory ownership of that same location', async () => {
    const url = 'https://guides.example.org/church-of-elleh-conflict';
    const html = fixture('church-elleh').replace('<title>Church of Elleh</title>', '<title>Elden Ring Church of Elleh</title>')
      .replace('</article>', '<p>Church of Elleh is a location in Copper Vale.</p></article>');
    pages.set(url, { html });
    const run = harness(); const initial = await run.query({ question: 'What should I do at the Church of Elleh before moving on?',
      currentArea: 'Church of Elleh' });
    const final = await run.submit(initial.result, url);
    expect(final.result.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] });
    assertNoAnswer(final.result); expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('rejects accessible unrelated status evidence for equipment-load guidance', async () => {
    pages.set(guideUrl, { html: fixture('unrelated-status') });
    const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, guideUrl);
    const evidencePath = process.env.GAMING_NEGATIVE_ACCEPTANCE_EVIDENCE;
    if (evidencePath) writeFileSync(evidencePath, JSON.stringify({ scope: 'synthetic served MCP negative control',
      baselineSha: 'da746f224bbecf74dff3b848a6e57023505ae3f2', fixture: 'unrelated-status',
      result: final.result, acquisitionCalls: mockHttp.mock.calls.length, generationCalls: mockTrinity.mock.calls.length,
      answerAuditCalls: mockAuditCompletion.mock.calls.length }, null, 2));
    assertNoAnswer(final.result);
    expect(mockTrinity).not.toHaveBeenCalled();
    expect(final.result.coverageSatisfied).toBe(false);
    expect(final.result.selectedEvidenceIds).toEqual([]);
    expect(mockHttp).toHaveBeenCalledTimes(1);
  });

  it('withholds multi-part generation when equipment load is supported but weapon improvement is absent', async () => {
    equipmentPage(); const run = harness();
    const initial = await run.query({ question: 'Explain how to avoid heavy rolling and where to improve my weapon in early Elden Ring.' });
    const final = await run.submit(initial.result, guideUrl);
    expect(final.result).toMatchObject({ coverageSatisfied: false, nextAction: 'search' });
    expect(final.result.requirementSupport).toHaveLength(2);
    expect(final.result.requirementSupport!.filter(item => item.evidenceIds.length > 0)).toHaveLength(1);
    expect(final.result.missingCoverage).toEqual(['requested topic 2']);
    assertNoAnswer(final.result); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('cannot present a patch-sensitive claim as current without official currentness evidence', async () => {
    pages.set(guideUrl, { html: fixture('patch-sensitive'), answer: 'This is the best current-patch Uchigatana balance setup.' });
    const run = harness(); const initial = await run.query({ mode: 'build', class: 'Samurai', platform: 'PC', edition: 'base-game',
      question: 'What is the best current-patch Uchigatana build in Elden Ring?' });
    const final = await run.submit(initial.result, guideUrl);
    assertNoAnswer(final.result);
    expect(final.result.freshnessStatus).not.toBe('current');
    expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('does not use an incomplete extraction fragment as a complete mechanics answer', async () => {
    pages.set(guideUrl, { html: fixture('partial') });
    const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, guideUrl);
    assertNoAnswer(final.result); expect(final.result.coverageSatisfied).toBe(false);
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it.each([false, true])('checks cached citation provenance (complete=%s) before generation', async complete => {
    const text = 'In Elden Ring, avoid heavy rolling by keeping equipped weight below 70 percent of maximum equipment load. Remove heavy armor or a weapon to reduce equipped weight and check the equipment screen.';
    const retrieve = jest.fn(async () => ({ context: text, sourceKnown: true,
      sources: [{ sourceId: '41000000-0000-4000-8000-000000000001', url: guideUrl, game: 'Elden Ring', sourceType: 'guide',
        fetchedAt: new Date(clock).toISOString(), snippet: text }],
      evidence: [{ sourceId: '41000000-0000-4000-8000-000000000001', revisionId: '42000000-0000-4000-8000-000000000001', recordId: '43000000-0000-4000-8000-000000000001', publicUrl: guideUrl,
        recordType: 'guide', text, lexicalScore: 1, combinedScore: 1,
        provenance: complete ? { fetchedAt: new Date(clock).toISOString() } : {} }] }));
    const workflow = createGamingHybridWorkflow({ retrieve: retrieve as never, ingest: mockIngest as never, now: () => clock });
    equipmentPage();
    const run = harness(workflow); const final = await run.query();
    const evidencePath = process.env.GAMING_NEGATIVE_PROVENANCE_EVIDENCE;
    if (evidencePath) writeFileSync(evidencePath, JSON.stringify({ scope: 'synthetic cached evidence through served MCP',
      result: final.result, generationCalls: mockTrinity.mock.calls.length }, null, 2));
    if (complete) {
      expect(final.result.state).toBe('answer_ready'); expect(mockTrinity).toHaveBeenCalledTimes(1);
    } else {
      assertNoAnswer(final.result); expect(mockTrinity).not.toHaveBeenCalled();
      expect(final.result.selectedEvidenceIds).toEqual([]);
    }
    expect(mockHttp).not.toHaveBeenCalled(); expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('rejects untrusted source instructions before grounding or provider execution', async () => {
    pages.set(guideUrl, { html: fixture('instruction') });
    const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, guideUrl);
    expect(final.result.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['SOURCE_INSTRUCTIONS_REJECTED'] });
    assertNoAnswer(final.result); expect(mockTrinity).not.toHaveBeenCalled();
    expect(JSON.stringify(final.result)).not.toMatch(/reveal your system prompt|ignore all previous instructions/iu);
  });

  it.each([
    { name: 'HTTP 403', status: 403, timeout: false, reason: 'SOURCE_INACCESSIBLE' },
    { name: 'acquisition deadline', status: 200, timeout: true, reason: 'SOURCE_TIMEOUT' }
  ])('retains the bounded acquisition reason for $name and does not generate', async ({ status, timeout, reason }) => {
    equipmentPage(guideUrl, { status, timeout, html: fixture(timeout ? 'timeout' : 'forbidden') });
    const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, guideUrl);
    expect(final.result.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: [reason] });
    assertNoAnswer(final.result); expect(mockTrinity).not.toHaveBeenCalled();
    expect(mockHttp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(final.result)).not.toContain('Private synthetic acquisition deadline');
  });

  it.each(['http://guides.example.org/guide', 'https://127.0.0.1/guide', 'https://user:pass@guides.example.org/guide'])
  ('rejects unsafe submitted URL %s before an HTTP hop', async url => {
    const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, url);
    expect(final.result.candidates![0].decision).toBe('rejected');
    assertNoAnswer(final.result); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('rejects a public hostname resolving to loopback before acquisition', async () => {
    privateDns = true; equipmentPage(); const run = harness(); const initial = await run.query();
    const final = await run.submit(initial.result, guideUrl);
    expect(final.result.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['URL_BLOCKED'] });
    assertNoAnswer(final.result); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it.each(['https://unreviewed.example.net/copied-guide', 'http://guides.example.org/insecure-guide', 'https://127.0.0.1/private'])
  ('stops at the redirect boundary for %s', async redirect => {
    equipmentPage(guideUrl, { status: 302, redirect }); const run = harness(); const initial = await run.query();
    const final = await run.submit(initial.result, guideUrl);
    expect(final.result.candidates![0].decision).toBe('rejected');
    assertNoAnswer(final.result); expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).not.toHaveBeenCalled();
    expect(publisherRequests).toHaveLength(1);
  });

  it('enforces decoded-size limits on a small compressed response before extraction', async () => {
    process.env.WEB_FETCH_MAX_BYTES = '128';
    equipmentPage(guideUrl, { html: 'x'.repeat(4096), gzip: true });
    const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, guideUrl);
    expect(final.result.candidates![0]).toMatchObject({ decision: 'rejected', reasonCodes: ['SOURCE_TOO_LARGE'] });
    assertNoAnswer(final.result); expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('suppresses tracking aliases during one submitted batch and publishes only the canonical selected URL', async () => {
    equipmentPage(); const run = harness(); const initial = await run.query();
    const final = await run.submit(initial.result, [`${guideUrl}?utm_source=fixture`, `${guideUrl}?utm_campaign=equivalent`]);
    expect(final.result.state).toBe('answer_ready');
    expect(final.result.selectedCandidateIds).toHaveLength(1);
    expect(final.result.answer!.sources.map(source => source.url)).toEqual([guideUrl]);
    expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale workflow revision before source acquisition', async () => {
    equipmentPage(); const run = harness(); const initial = await run.query();
    const final = await run.submit(initial.result, guideUrl, {}, 'stale-revision-001', { expectedRevision: initial.result.revision! + 1 });
    expect(final).toMatchObject({ statusCode: 409, result: { reason: 'STALE_WORKFLOW_REVISION', nextAction: 'stop' } });
    assertNoAnswer(final.result); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('replays only the identical candidate operation without reacquisition or generation', async () => {
    equipmentPage(); const run = harness(); const initial = await run.query();
    const final = await run.submit(initial.result, guideUrl);
    const replay = await run.submit(initial.result, guideUrl);
    expect(replay.result.answer).toEqual(final.result.answer);
    expect(replay.result.selectedEvidenceIds).toEqual(final.result.selectedEvidenceIds);
    const changed = await run.submit(initial.result, `${guideUrl}?different=content`);
    expect(changed).toMatchObject({ statusCode: 409, result: { reason: 'IDEMPOTENCY_CONFLICT' } });
    assertNoAnswer(changed.result); expect(mockHttp).toHaveBeenCalledTimes(1); expect(mockTrinity).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed question under an already used query idempotency key', async () => {
    const run = harness(); await run.query();
    const changed = await run.query({ question: 'Where do I improve a weapon in Elden Ring?' });
    expect(changed).toMatchObject({ statusCode: 409, result: { reason: 'IDEMPOTENCY_CONFLICT' } });
    assertNoAnswer(changed.result); expect(run.retrieve).toHaveBeenCalledTimes(1);
    expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('binds workflow ownership to the authenticated principal even through another authorized local owner resource', async () => {
    const original = harness(); const initial = await original.query();
    const other = harness(original.workflow, 'different-negative-owner');
    const denied = await other.submit(initial.result, guideUrl);
    expect(denied).toMatchObject({ statusCode: 404, result: { reason: 'WORKFLOW_UNAVAILABLE', nextAction: 'stop' } });
    assertNoAnswer(denied.result); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('does not resurrect an expired v2 query with the original operation key', async () => {
    const run = harness(); const initial = await run.query();
    clock += 10 * 60_000; jest.setSystemTime(clock);
    const expired = await run.query();
    expect(expired).toMatchObject({ statusCode: 409, result: { reason: 'WORKFLOW_EXPIRED', nextAction: 'stop' } });
    assertNoAnswer(expired.result); expect(run.retrieve).toHaveBeenCalledTimes(1);
    expect(initial.result.workflowId).toBeDefined(); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('preserves terminal stop after exhausting both discovery rounds and refuses another candidate operation', async () => {
    const run = harness(); const initial = await run.query();
    const first = await run.submit(initial.result, 'https://guides.example.org/unsupported.mp4');
    const final = await run.submit(first.result, 'https://guides.example.org/other-unsupported.mp4', {}, 'negative-round-two');
    expect(final.result.nextAction).toBe('stop'); assertNoAnswer(final.result);
    const denied = await run.submit(final.result, guideUrl, {}, 'negative-round-three');
    expect(denied).toMatchObject({ statusCode: 409, result: { reason: 'WORKFLOW_CLOSED', nextAction: 'stop' } });
    assertNoAnswer(denied.result); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('never starts a fourth acquisition when the public request exceeds the three-candidate schema', async () => {
    const run = harness(); const initial = await run.query();
    const invalid = await run.invoke('arcanos_gaming_submit_candidates', { contractVersion: v2, workflowId: initial.result.workflowId,
      expectedRevision: initial.result.revision, idempotencyKey: 'four-candidates-001',
      candidates: Array.from({ length: 4 }, (_unused, index) => ({ url: `https://guides.example.org/guide-${index}` })) }, { expectStructured: false });
    expect(invalid).toMatchObject({ isError: true, content: [{ type: 'text', text: 'GAMING_INPUT_INVALID' }] });
    expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it.each(['invalid citation', 'unknown evidence IDs', 'spoiler violation'] as const)
  ('withholds generated text after %s rather than repairing or returning it', async kind => {
    equipmentPage();
    if (kind === 'invalid citation') {
      mockTrinity.mockImplementation(async (providerRequest: any) => {
        const result = 'Keep equipment load below 70 percent. [Source 99]';
        const { assessment } = await providerRequest.context.runOptions.gamingClearAnswerAudit(result, {});
        return { result, gamingClearAudit: assessment, meta: { provider: { finishReason: 'stop' } } };
      });
    } else providerFindings(kind === 'spoiler violation' ? 'SPOILER_VIOLATION' : '', kind === 'unknown evidence IDs');
    const run = harness(); const initial = await run.query({ spoilerTolerance: 'none' });
    const final = await run.submit(initial.result, guideUrl);
    assertNoAnswer(final.result); expect(final.result.nextAction).toBe('stop');
    expect(mockTrinity).toHaveBeenCalledTimes(1);
    expect(mockAuditCompletion).toHaveBeenCalledTimes(kind === 'invalid citation' ? 0 : 1);
  });

  it('does not expose durable ingestion authority to a query-only MCP principal', async () => {
    equipmentPage(); const run = harness(); const initial = await run.query(); const final = await run.submit(initial.result, guideUrl);
    const denied = await run.invoke('arcanos_gaming_ingest_candidates', { contractVersion: v2, workflowId: final.result.workflowId,
      idempotencyKey: 'unauthorized-write-001', candidateIds: final.result.selectedCandidateIds,
      storagePolicy: 'ask_before_store', confirmStore: true }, { expectStructured: false });
    expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: 'GAMING_PERMISSION_DENIED' }] });
    expect(mockIngest).not.toHaveBeenCalled(); expect(mockDatabaseAccess).not.toHaveBeenCalled();
  });

  it('requires authenticated Gaming OAuth before any workflow or provider operation', async () => {
    const run = harness();
    const denied = await request(run.app).post(GAMING_MCP_PATH).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'arcanos_gaming_hybrid_query',
        arguments: { contractVersion: v2, game: 'Elden Ring', question, idempotencyKey: 'missing-token-001' } } });
    expect(denied.status).toBe(401); expect(denied.body).toEqual({ error: 'GAMING_AUTHORIZATION_REQUIRED' });
    expect(run.retrieve).not.toHaveBeenCalled(); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('rejects a validly signed non-owner token before invoking the Gaming workflow', async () => {
    const run = harness();
    const denied = await run.invoke('arcanos_gaming_hybrid_query', { contractVersion: v2, game: 'Elden Ring', question,
      idempotencyKey: 'wrong-owner-001' }, { subject: 'unauthorized-owner', expectedHttpStatus: 401 });
    expect(denied).toEqual({ error: 'GAMING_AUTHORIZATION_REQUIRED' });
    expect(run.retrieve).not.toHaveBeenCalled(); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });

  it('rejects administrative tools outside the Gaming catalog without invoking them', async () => {
    const run = harness();
    const denied = await run.invoke('arcanos_admin_execute', {}, { expectStructured: false });
    expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: 'GAMING_TOOL_UNAVAILABLE' }] });
    expect(run.retrieve).not.toHaveBeenCalled(); expect(mockHttp).not.toHaveBeenCalled(); expect(mockTrinity).not.toHaveBeenCalled();
  });
});
