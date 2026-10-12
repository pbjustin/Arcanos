import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, request as requestPublisher, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { GAMING_CLEAR_DIMENSIONS } from '../src/shared/gaming/gamingClearPolicy.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

const question = "I'm at the beginning of Elden Ring. I'm a Samurai. I just got out of the tutorial area. I want a Samurai blade build.";
const mockHttp = jest.fn();
const mockTrinity = jest.fn();
const mockAuditCompletion = jest.fn();
const mockIngest = jest.fn(async () => { throw new Error('Durable source writes are forbidden in this fixture.'); });
const mockDatabaseAccess = jest.fn(async () => { throw new Error('Database and player persistence are outside this transient fixture.'); });
const mockBackendSearch = jest.fn(async () => { throw new Error('Guide discovery belongs to the frontend.'); });
const mockSearchProvider = jest.fn();
const pages = new Map<string, { html: string; answer?: string; contentType?: string; status?: number; gzip?: boolean }>();
const publisherRequests: Array<{ path: string; host: string; method: string; status: number }> = [];
let publisher: Server;
let publisherOrigin: string;
let clock = Date.parse('2026-10-12T12:00:00Z');

// The publisher is a deterministic loopback HTTP server and semantic providers
// are sealed fixtures. Only the test Axios seam maps a DNS-pinned public target
// to loopback; production HTTPS/SSRF admission remains enabled. The served
// MCP authentication/schema boundary, protected transport, parser, identity,
// CLEAR, selection, Trinity handoff and answer/citation validation remain real.
// The Trinity orchestrator and one semantic answer-review completion are
// deterministic seams; this suite makes no claim of model or live-provider quality.
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: mockTrinity }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createSingleChatCompletion: mockAuditCompletion, createChatCompletionWithFallback: jest.fn(), ensureModelMatchesExpectation: jest.fn()
}));
jest.unstable_mockModule('../src/core/db/client.js', () => ({
  getPool: () => ({ query: mockDatabaseAccess, connect: mockDatabaseAccess }), isDatabaseConnected: () => false,
  initializeDatabase: mockDatabaseAccess, closePoolIfCurrent: jest.fn(), close: jest.fn(), getStatus: jest.fn()
}));
jest.unstable_mockModule('../src/core/db/index.js', () => ({
  getPool: () => ({ query: mockDatabaseAccess, connect: mockDatabaseAccess }), isDatabaseConnected: () => false,
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
const { clearGamingRagCache, isCitableGamingWebSource } = await import('../src/services/gamingWebContext.js');
const v2 = 'gaming-hybrid-v2';
const env = {
  ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '12000',
  ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200'
};
const authEnv: Record<string, string> = {
  CHATGPT_GAMING_ENABLED: 'true', CHATGPT_GAMING_ISSUER: 'https://fixture-issuer.invalid/',
  CHATGPT_GAMING_RESOURCE: 'https://fixture-resource.invalid/chatgpt/gaming/mcp',
  CHATGPT_GAMING_JWKS_URL: 'https://fixture-issuer.invalid/jwks', CHATGPT_GAMING_OWNER_SUBJECT: 'ordinary-gameplay-fixture-owner'
};
const configuration = readGamingAuthConfiguration(name => authEnv[name]);
if (configuration.status !== 'ready') throw new Error('Expected sealed Gaming OAuth configuration.');
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let keyResolver: ReturnType<typeof createLocalJWKSet>;
let previousEnv: Record<string, string | undefined>;
let previousByteLimit: string | undefined;

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'ordinary-gameplay-fixture', alg: 'RS256' }] });
  publisher = createServer((incoming, outgoing) => {
    const host = incoming.headers.host ?? '';
    const path = incoming.url ?? '';
    const page = pages.get(`https://${host}${path}`);
    outgoing.statusCode = page ? page.status ?? 200 : 404;
    publisherRequests.push({ path, host, method: incoming.method ?? '', status: outgoing.statusCode });
    outgoing.setHeader('Content-Type', page?.contentType ?? 'text/html');
    if (page?.gzip) outgoing.setHeader('Content-Encoding', 'gzip');
    outgoing.end(page?.gzip ? gzipSync(page.html) : page?.html ?? 'No deterministic publisher response.');
  });
  await new Promise<void>(resolve => publisher.listen(0, '127.0.0.1', resolve));
  publisherOrigin = `http://127.0.0.1:${(publisher.address() as AddressInfo).port}`;
});
afterAll(async () => new Promise<void>((resolve, reject) => publisher.close(error => error ? reject(error) : resolve())));
beforeEach(() => {
  pages.clear(); publisherRequests.length = 0; jest.clearAllMocks(); resetSafetyRuntimeStateForTests();
  discovery.clearGamingDiscoveryCache(); clearGamingRagCache();
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
  mockSearchProvider.mockImplementation(async () => [...pages.entries()].map(([url, page], index) => ({
    url, title: /<title>(.*?)<\/title>/u.exec(page.html)?.[1] ?? '',
    snippet: page.html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').slice(0, 500),
    providerRank: index + 1, provider: 'synthetic-acceptance-search'
  })));
  // Preserve actual discovery query construction, ranking and URL admission.
  // The injected provider replaces only the external search service.
  mockBackendSearch.mockImplementation((input: any) => discovery.discoverGamingSources({ ...input,
    provider: { id: 'synthetic-acceptance-search', version: 'v1', isConfigured: () => true, search: mockSearchProvider as never }
  }) as never);
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
      const url = /^URL: (.+)$/mu.exec(block)?.[1] ?? /^\[Source \d+\] (https?:\/\/\S+)/u.exec(block)?.[1];
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
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (previousByteLimit === undefined) delete process.env.WEB_FETCH_MAX_BYTES;
  else process.env.WEB_FETCH_MAX_BYTES = previousByteLimit;
  jest.restoreAllMocks(); jest.useRealTimers(); resetSafetyRuntimeStateForTests();
});

function harness() {
  // No stored evidence, SQL, jobs, or player persistence service is part of this
  // transient fixture; source ingestion is independently trapped above.
  const retrieve = jest.fn(async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }));
  const workflow = createGamingHybridWorkflow({ retrieve, ingest: mockIngest as never, now: () => clock });
  const execute = createGamingMcpExecutor({ hybridQuery: workflow.query, candidates: workflow.candidates, ingestCandidates: workflow.ingest });
  const app = express();
  app.use(requestContext);
  app.use(createChatGptGamingMcpRouter({ configuration, verification: { keyResolver, readEnvironmentValue: () => undefined },
    providerAdmission: (_req, _res, next) => next(), execute }));
  let sequence = 0;
  async function invoke(name: 'arcanos_gaming_query' | 'arcanos_gaming_hybrid_query' | 'arcanos_gaming_submit_candidates', input: unknown) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: configuration.issuer, aud: configuration.resource,
      sub: configuration.ownerSubject, iat: now, exp: now + 3600, scope: GAMING_QUERY_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'ordinary-gameplay-fixture' }).sign(keys.privateKey);
    const response = await request(app).post(GAMING_MCP_PATH).set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: input } });
    expect(response.status).toBe(200);
    expect(isGamingMcpOutput(name, response.body.result.structuredContent)).toBe(true);
    return response.body.result.structuredContent as { statusCode: number; result: GamingHybridResponse };
  }
  const query = (overrides: Record<string, unknown> = {}) => invoke('arcanos_gaming_hybrid_query', {
    contractVersion: v2, game: 'Elden Ring', mode: 'guide', question,
    idempotencyKey: 'ordinary-query-001', storagePolicy: 'transient_only', ...overrides
  });
  const submit = (state: GamingHybridResponse, urls: string[], key = 'ordinary-source-001') => invoke('arcanos_gaming_submit_candidates', {
    contractVersion: state.contractVersion, workflowId: state.workflowId,
    ...(state.contractVersion === v2 ? { expectedRevision: state.revision } : {}),
    discoveryType: state.discovery?.type ?? 'gameplay_evidence', idempotencyKey: key, candidates: urls.map(url => ({ url }))
  });
  return { workflow, retrieve, query, submit, invoke };
}

interface AcquisitionFixture {
  id: string; file: string; url: string; title: string; game: string | null;
  answer: string; contentType: string; status: number; provenance: 'synthetic';
}
const manifest = JSON.parse(readFileSync(new URL('./fixtures/gamingAcceptance/manifest.json', import.meta.url), 'utf8')) as {
  provenance: 'synthetic'; capturedPublicResponses: false; fixtures: AcquisitionFixture[];
};
function publish(id: string): AcquisitionFixture {
  const fixture = manifest.fixtures.find(item => item.id === id)!;
  expect(fixture.provenance).toBe('synthetic');
  pages.set(fixture.url, { html: readFileSync(new URL(`./fixtures/gamingAcceptance/${fixture.file}`, import.meta.url), 'utf8'),
    answer: fixture.answer, contentType: fixture.contentType, status: fixture.status });
  return fixture;
}
const ordinaryScenarios = [
  { id: 'A', name: 'basic location advice', fixture: 'church-elleh', mode: 'guide', game: 'Elden Ring',
    question: 'What should I do at the Church of Elleh before moving on?', currentArea: 'Church of Elleh',
    searchTerms: ['church', 'elleh'] },
  { id: 'B', name: 'stable equipment-load mechanic', fixture: 'equipment-load', mode: 'guide', game: 'Elden Ring',
    question: 'How do I avoid heavy rolling in Elden Ring?', searchTerms: ['heavy', 'rolling'] },
  { id: 'C', name: 'early-game Samurai stat', fixture: 'early-stat', mode: 'build', game: 'Elden Ring',
    question: 'Which stat should an early-game Samurai using an Uchigatana level first?', class: 'Samurai',
    currentArea: 'Limgrave', progressPoint: 'early Limgrave',
    constraints: ['Solo PvE', 'No DLC'], answerDepth: 'concise', searchTerms: ['samurai', 'uchigatana'] },
  { id: 'D', name: 'one spoiler-safe preparation step', fixture: 'church-elleh', mode: 'guide', game: 'Elden Ring',
    question: 'At Church of Elleh in early Elden Ring, what is one safe preparation step before continuing? Avoid spoilers.',
    searchTerms: ['church', 'elleh', 'preparation'] },
  { id: 'F', name: 'non-Elden Ring first-spring mechanic', fixture: 'non-elden-mechanic', mode: 'guide', game: 'Stardew Valley',
    question: 'How should I water my parsnip seeds during the first spring in Stardew Valley?',
    currentArea: 'Farm', progressPoint: 'first spring', searchTerms: ['parsnip', 'water'] }
];
function requestFields(scenario: typeof ordinaryScenarios[number]) {
  return { game: scenario.game, mode: scenario.mode, class: scenario.class, currentArea: scenario.currentArea,
    progressPoint: scenario.progressPoint, constraints: scenario.constraints, answerDepth: scenario.answerDepth,
    spoilerTolerance: 'none' };
}
function assertGroundedHandoff(answer: { response: string; sources: Array<{
  url: string; sourceId?: string; snippet?: string; error?: string }> },
  expected: AcquisitionFixture[], questionText: string, selectedIds?: string[], selectedEvidenceIds?: string[]) {
  const citedSources = answer.sources.filter(source => source.sourceId || isCitableGamingWebSource(source));
  expect(citedSources.map(source => source.url).sort()).toEqual(expected.map(fixture => fixture.url).sort());
  expected.forEach(fixture => expect(answer.response).toContain(fixture.answer));
  expect(answer.response).toContain('[Source 1]');
  const citedNumbers = [...answer.response.matchAll(/\[Source (\d+)\]/gu)].map(match => Number(match[1]));
  expect(citedNumbers.length).toBeGreaterThan(0);
  expect(citedNumbers.every(index => index > 0 && index <= citedSources.length)).toBe(true);
  citedNumbers.forEach(index => expect(expected.map(fixture => fixture.url)).toContain(answer.sources[index - 1].url));
  expect(mockTrinity).toHaveBeenCalledTimes(1);
  expect(mockAuditCompletion).toHaveBeenCalledTimes(1);
  const provider = mockTrinity.mock.calls[0][0] as any;
  expect(provider.input.prompt).toContain(questionText);
  answer.sources.filter(source => source.error).forEach(source => expect(provider.input.prompt).not.toContain(source.url));
  expect(provider.context.runOptions).toMatchObject({ disableOptionalSideEffects: true, redactAuditContent: true });
  const audited = JSON.parse((mockAuditCompletion.mock.calls[0][1] as any).messages[1].content);
  expect(audited.evidence.length).toBeGreaterThan(0);
  expect(audited.question).toBe(questionText);
  expect(audited.verifiedEvidenceGates).toEqual({ identity: 'verified', compatibility: 'verified',
    claimSupport: 'verified', freshness: 'not_applicable', provenance: 'verified', security: 'verified' });
  for (const chunk of audited.evidence) {
    expect(expected.map(fixture => fixture.url)).toContain(answer.sources[chunk.sourceIndex - 1].url);
    const source = answer.sources[chunk.sourceIndex - 1];
    if (source.sourceId) expect(source.sourceId).toBe(chunk.sourceId);
    else expect(chunk.sourceId).toBe(`live:${createHash('sha256')
      .update(source.url.toLowerCase().replace(/\s+/gu, ' ')).digest('hex')}`);
    expect(chunk.revisionId).toMatch(/^(?:live:)?[a-f0-9]{64}$/u);
    if (selectedIds) expect(selectedIds).toContain(chunk.sourceId);
    if (selectedEvidenceIds) expect(selectedEvidenceIds).toContain(chunk.chunkId);
    expect(provider.input.prompt).toContain(chunk.text);
  }
  const sourceLogs = (logger.info as jest.Mock).mock.calls.filter(call => call[0] === 'gaming.clear.source.completed');
  if (answer.sources.every(source => source.sourceId)) {
    const finalSourceLogs = sourceLogs.slice(-expected.length);
    expect(finalSourceLogs.length).toBe(expected.length);
    for (const [, details] of finalSourceLogs as Array<[unknown, any]>) {
      expect(details.extraction).toMatchObject({ rawChars: expect.any(Number), acceptedBytes: expect.any(Number),
        receivedBytes: expect.any(Number) });
      expect(details.extraction.acceptedBytes).toBeGreaterThan(200);
      expect(audited.evidence.map((chunk: any) => chunk.revisionId)).toContain(details.subjectHash);
      expect(details.identity.ruleId).toMatch(/^gaming\.identity\./u);
      expect(details.blockingFindingCount).toBe(0);
    }
  } else {
    const selections = (logger.info as jest.Mock).mock.calls.filter(call => call[0] === 'gaming.retrieval.source.selection')
      .slice(-expected.length);
    expect(selections).toHaveLength(expected.length);
    selections.forEach(([, details]) => expect(details).toMatchObject({
      selectedContainer: expect.any(String), cleanedTextLength: expect.any(Number), selectedChunkScore: expect.any(Number) }));
  }
  for (const fixture of expected) {
    const admitted = new URL(fixture.url);
    const acquired = publisherRequests.filter(item => item.host === admitted.hostname && item.path === admitted.pathname);
    expect(acquired.length).toBeGreaterThan(0);
    expect(acquired.every(item => item.status === 200 && item.method === 'GET')).toBe(true);
  }
  expect(mockHttp).toHaveBeenCalledTimes(publisherRequests.length);
}

describe.each(['gaming-hybrid-v1', v2])('ordinary gameplay authenticated served %s acceptance', contractVersion => {
  it.each(ordinaryScenarios)('$id: $name travels through acquired evidence to cited answer', async scenario => {
    const fixture = publish(scenario.fixture);
    const run = harness();
    const initial = await run.query({ ...requestFields(scenario), contractVersion, question: scenario.question });
    expect(initial.result).toMatchObject({ state: 'discovery_required', nextAction: 'search' });
    expect(initial.result.discovery!.type).toBe('gameplay_evidence');
    const queries = initial.result.discovery!.searchQueries.join(' ').toLowerCase();
    scenario.searchTerms.forEach(term => expect(queries).toContain(term));
    expect(queries).toContain(scenario.game.toLowerCase());
    expect(mockHttp).not.toHaveBeenCalled();
    expect(mockTrinity).not.toHaveBeenCalled();
    expect(mockBackendSearch).not.toHaveBeenCalled();
    const final = await run.submit(initial.result, [fixture.url]);
    if (final.result.state !== 'answer_ready') process.stderr.write(`ACCEPTANCE_DIAGNOSTIC ${JSON.stringify({
      scenario: scenario.id, contractVersion, result: final.result })}\n`);
    expect(final.statusCode).toBe(200);
    expect(final.result).toMatchObject({ state: 'answer_ready', nextAction: 'answer',
      evidenceSelected: true, answer: { provenance: 'arcanos-trinity' } });
    if (contractVersion === v2) {
      expect(final.result.coverageSatisfied).toBe(true);
      expect(final.result.missingCoverage).toEqual([]);
      expect(final.result.selectedCandidateIds).toHaveLength(1);
      expect(final.result.selectedEvidenceIds!.length).toBeGreaterThan(0);
    }
    expect(final.result.candidates![0].decision).not.toBe('rejected');
    assertGroundedHandoff(final.result.answer!, [fixture], scenario.question,
      final.result.selectedCandidateIds, final.result.selectedEvidenceIds);
    if (scenario.id === 'C') {
      const provider = mockTrinity.mock.calls[0][0] as any;
      expect(provider.input.body).toMatchObject({ class: 'Samurai', currentArea: 'Limgrave',
        progressPoint: 'early Limgrave', constraints: ['Solo PvE', 'No DLC'], answerDepth: 'concise' });
      expect(final.result.answer!.response).not.toMatch(/(?:optimal|strongest|current meta|latest patch)/iu);
    }
    if (scenario.id === 'D') expect(final.result.answer!.response).not.toMatch(/boss|ending|quest|story/iu);
  });

  it.each([
    'Explain how to avoid heavy rolling and where to improve my weapon in early Elden Ring.',
    'Explain the mechanics of equipment load and weapon upgrades.'
  ])('E: complementary sources cover independently requested topics: %s', async multipart => {
    const load = publish('equipment-load');
    const upgrade = publish('weapon-upgrade');
    const run = harness();
    const initial = await run.query({ contractVersion, question: multipart, mode: 'guide', spoilerTolerance: 'none' });
    const unsupported = await run.submit(initial.result, [load.url]);
    expect(unsupported.result.answer).toBeUndefined();
    expect(unsupported.result.nextAction).toBe(contractVersion === v2 ? 'search' : 'stop');
    expect(mockTrinity).not.toHaveBeenCalled();
    if (contractVersion === v2) {
      expect(unsupported.result.coverageSatisfied).toBe(false);
      expect(unsupported.result.missingCoverage!.length).toBeGreaterThan(0);
    }
    // v1 has a single discovery round; a stopped partial workflow remains stopped.
    // A separate in-memory v1 workflow submits the complete complementary set.
    const completeRun = contractVersion === v2 ? run : harness();
    const completeState = contractVersion === v2 ? unsupported.result : (await completeRun.query({ contractVersion,
      question: multipart, mode: 'guide', spoilerTolerance: 'none' })).result;
    const final = await completeRun.submit(completeState, contractVersion === v2 ? [upgrade.url] : [load.url, upgrade.url],
      'ordinary-complementary-source-002');
    if (final.result.state !== 'answer_ready') process.stderr.write(`MULTIPART_DIAGNOSTIC ${JSON.stringify({ contractVersion,
      result: final.result })}\n`);
    expect(final.result).toMatchObject({ state: 'answer_ready', nextAction: 'answer', evidenceSelected: true });
    if (contractVersion === v2) {
      expect(final.result.coverageSatisfied).toBe(true);
      expect(final.result.missingCoverage).toEqual([]);
      expect(final.result.selectedCandidateIds).toHaveLength(2);
      expect(final.result.requirementSupport).toHaveLength(2);
      const selectedCandidates = final.result.candidates!.filter(candidate => candidate.candidateId
        && final.result.selectedCandidateIds!.includes(candidate.candidateId));
      expect(final.result.requirementSupport![0].candidateIds)
        .toEqual([selectedCandidates.find(candidate => candidate.url === load.url)!.candidateId]);
      expect(final.result.requirementSupport![1].candidateIds)
        .toEqual([selectedCandidates.find(candidate => candidate.url === upgrade.url)!.candidateId]);
      final.result.requirementSupport!.forEach(requirement => requirement.evidenceIds
        .forEach(id => expect(final.result.selectedEvidenceIds).toContain(id)));
    }
    assertGroundedHandoff(final.result.answer!, [load, upgrade], multipart,
      final.result.selectedCandidateIds, final.result.selectedEvidenceIds);
    expect(final.result.answer!.response).toContain('[Source 2]');
  });
});

describe('ordinary gameplay through the supported legacy Gaming MCP query', () => {
  it.each(ordinaryScenarios)('$id: $name keeps the public legacy request and selected evidence bound', async scenario => {
    process.env.ARCANOS_GAMING_RAG_ENABLED = 'true';
    process.env.ARCANOS_GAMING_DISCOVERY_ENABLED = 'true';
    const fixture = publish(scenario.fixture);
    const run = harness();
    const final = await run.invoke('arcanos_gaming_query', { ...requestFields(scenario), prompt: scenario.question });
    const result = final.result as unknown as { ok: boolean; data: {
      response: string; sources: Array<{ url: string; sourceId?: string }>; grounding: Record<string, unknown> } };
    expect(final.statusCode).toBe(200);
    expect(result.ok).toBe(true);
    expect(mockBackendSearch).toHaveBeenCalledTimes(1);
    expect(mockSearchProvider).toHaveBeenCalledTimes(1);
    const search = mockSearchProvider.mock.calls[0][0] as any;
    expect(search).toMatchObject({ game: scenario.game, mode: scenario.mode, freshnessPreference: 'stable' });
    scenario.searchTerms.forEach(term => expect(search.query.toLowerCase()).toContain(term));
    expect(search.query.toLowerCase()).toContain(scenario.game.toLowerCase());
    assertGroundedHandoff(result.data, [fixture], scenario.question);
    const provider = mockTrinity.mock.calls[0][0] as any;
    expect(provider.input.body.game).toBe(scenario.game);
    expect(provider.input.body.spoilerTolerance).toBe('none');
  });
  it.each([
    'Explain how to avoid heavy rolling and where to improve my weapon in early Elden Ring.',
    'Explain the mechanics of equipment load and weapon upgrades.'
  ])('E: legacy generation waits for complete multi-part grounding: %s', async multipart => {
    process.env.ARCANOS_GAMING_RAG_ENABLED = 'true';
    const load = publish('equipment-load');
    const run = harness();
    const unsupported = await run.invoke('arcanos_gaming_query', { game: 'Elden Ring', mode: 'guide',
      prompt: multipart, guideUrl: load.url, spoilerTolerance: 'none' });
    const insufficient = unsupported.result as unknown as { ok: boolean; data?: { response: string } };
    expect(insufficient.data?.response).not.toContain(load.answer);
    expect(mockTrinity).not.toHaveBeenCalled();
    const upgrade = publish('weapon-upgrade');
    const final = await run.invoke('arcanos_gaming_query', { game: 'Elden Ring', mode: 'guide',
      prompt: multipart, guideUrls: [load.url, upgrade.url], spoilerTolerance: 'none' });
    const result = final.result as unknown as { ok: boolean; data: {
      response: string; sources: Array<{ url: string; sourceId?: string }> } };
    expect(result.ok).toBe(true);
    assertGroundedHandoff(result.data, [load, upgrade], multipart);
    expect(result.data.response).toContain('[Source 2]');
  });
});
