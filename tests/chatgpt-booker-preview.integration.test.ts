import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createNativePrPreviewApplication } from '../src/nativePrPreviewApplication.js';
import { BOOKER_MCP_PATH, BOOKER_METADATA_PATH, bookerMcpTools } from '../src/shared/chatgpt/bookerMcpContract.js';
import { BOOKER_PREVIEW_EVIDENCE_PATH, BOOKER_PREVIEW_PROOF_HEADER, BOOKER_PREVIEW_PROOF_VERSION } from '../src/shared/chatgpt/bookerMcpPreviewFixture.js';
import { simulateBackstageMatchCore } from '../src/shared/backstage/backstageMatchSimulationCore.js';
import { BOOKER_PREVIEW_UNIVERSE_ID, signBookerPreviewToken } from '../scripts/booker-mcp-preview-key.mjs';

const origin = 'https://arcanos-v2-pr-676861-1566.up.railway.app';
const resource = origin + BOOKER_MCP_PATH;
const universeId = BOOKER_PREVIEW_UNIVERSE_ID;
const readinessState = { applicationImported: true, fixturesSealed: true, ready: true, draining: false };
const application = (prNumber = 1566, bookerOrigin: string | undefined = origin) => createNativePrPreviewApplication({
  identity: { prNumber, sourceCommit: 'a'.repeat(40) }, readinessState, bookerOrigin,
  notionConnectivityProbe: async () => { throw new Error('Unexpected Notion network'); },
});
let app: ReturnType<typeof application>;
let authorization: string;
beforeEach(async () => { app = application(); authorization = 'Bearer ' + await signBookerPreviewToken({ resource }); });
afterEach(() => jest.restoreAllMocks());
const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
const post = (body: unknown, auth = authorization) => request(app).post(BOOKER_MCP_PATH)
  .set('Accept', 'application/json, text/event-stream').set('Authorization', auth).send(body);
const call = (name: string, input: Record<string, unknown>) => post(rpc('tools/call', { name, arguments: { universeId, ...input } }));
const output = (response: { body: { result: { structuredContent: { statusCode: number; result: Record<string, any> } } } }) => response.body.result.structuredContent;
const scope = { pageTitle: 'Raw', pagePath: ['Universe', 'Raw'] };
const roster = [{ name: 'Synthetic A', overall: 90 }, { name: 'Synthetic B', overall: 60 }, { name: 'Synthetic C', overall: 70 }];

describe('contained Booker actual MCP transport and synthetic OAuth', () => {
  it('publishes exact resource metadata and rejects missing authentication before parsing', async () => {
    const response = await request(app).get(BOOKER_METADATA_PATH).expect(200);
    expect(response.body.resource).toBe(resource);
    expect(response.headers[BOOKER_PREVIEW_PROOF_HEADER]).toBe(BOOKER_PREVIEW_PROOF_VERSION);
    await request(app).post(BOOKER_MCP_PATH).set('Content-Type', 'application/json').send('{').expect(401);
  });
  it('lets the actual router authenticate before enforcing its own media and body bounds', async () => {
    const oversized = JSON.stringify(rpc('tools/call', { name: 'generateBooking', arguments: { universeId, prompt: 'x'.repeat(270_000) } }));
    await request(app).post(BOOKER_MCP_PATH).set('Content-Type', 'application/json').send(oversized).expect(401);
    await post('{}').set('Content-Type', 'application/json; charset=utf-16').expect(415);
    await post(oversized).set('Content-Type', 'application/json').expect(413);
  });
  it.each([{ aud: origin + '/chatgpt/mcp' }, { aud: [resource] }, { sub: 'other-owner' },
    { client_id: 'other-client' }, { exp: 1 }, { scope: 'arcanos:booker:generate' }])('rejects signed invalid fixture claims %j', async claims => {
    await post(rpc('tools/list'), 'Bearer ' + await signBookerPreviewToken({ resource, claims })).expect('scope' in claims ? 403 : 401);
  });
  it('runs the actual SDK initialize and seven-tool discovery through the native app', async () => {
    const server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const realFetch = globalThis.fetch;
    const client = new Client({ name: 'booker-contained-test', version: '1' });
    try {
      jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (new URL(input instanceof Request ? input.url : String(input)).origin !== endpoint) throw new Error('Unexpected external request');
        return realFetch(input, init);
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + BOOKER_MCP_PATH), { requestInit: { headers: { Authorization: authorization } } }));
      expect(client.getServerVersion()?.name).toBe('arcanos-backstage-booker-private');
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(bookerMcpTools.map(tool => tool.name));
      const result = await client.callTool({ name: 'queryContinuity', arguments: { universeId, query: 'fixture:continuity', retrievalScope: scope } });
      expect(result.isError).not.toBe(true);
    } finally { await client.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
  it('advertises read tools only and denies generation and changed universe before fixture execution', async () => {
    const reader = 'Bearer ' + await signBookerPreviewToken({ resource, readOnly: true });
    const listed = await post(rpc('tools/list'), reader);
    expect(listed.body.result.tools).toHaveLength(4);
    const denied = await post(rpc('tools/call', { name: 'generateBooking', arguments: { universeId, prompt: 'fixture:booking' } }), reader);
    expect(denied.body.result.isError).toBe(true);
    const cross = await call('queryContinuity', { universeId: 'another-universe', query: 'fixture:continuity' });
    expect(cross.body.result.content[0].text).toBe('BOOKER_UNIVERSE_DENIED');
    const evidence = await request(app).get(BOOKER_PREVIEW_EVIDENCE_PATH).set('Authorization', reader).expect(200);
    expect(evidence.body.providerAdmissions).toBe(0);
  });
  it.each(['writeBackstageCanon', 'appendCanonBeat', 'upsertStoryline', 'modules.invoke'])('rejects administrative/canon tool %s', async name => {
    expect((await call(name, {})).body.result.content[0].text).toBe('BOOKER_TOOL_UNAVAILABLE');
  });
  it('keeps bearer admission limited to the actual Booker paths and trusted PR identity', async () => {
    await request(app).post('/chatgpt/mcp').set('Authorization', authorization).send(rpc('tools/list')).expect(404);
    await request(application(1565)).post(BOOKER_MCP_PATH).set('Authorization', authorization).send(rpc('tools/list')).expect(404);
    const withoutOrigin = createNativePrPreviewApplication({ identity: { prNumber: 1566, sourceCommit: 'a'.repeat(40) }, readinessState });
    await request(withoutOrigin).get(BOOKER_METADATA_PATH).expect(404);
    expect(() => application(1566, 'https://attacker.invalid')).toThrow('BOOKER_PREVIEW_ORIGIN_INVALID');
    await request(app).get(BOOKER_PREVIEW_EVIDENCE_PATH).expect(401);
  });
});

describe('deterministic Booker continuity, generation and simulation', () => {
  it('preserves exact-page, section and subtree boundaries with truthful coverage', async () => {
    const page = output(await call('queryContinuity', { query: 'fixture:continuity', retrievalScope: scope })).result.result;
    expect(page.sources).toHaveLength(2); expect(page.answer).not.toContain('Smackdown'); expect(page.answer).not.toContain('prior Raw exhibition');
    const section = output(await call('queryContinuity', { query: 'fixture:continuity', retrievalScope: { ...scope, sectionPath: ['Main event'] } })).result.result;
    expect(section.sources).toHaveLength(1); expect(section.answer).toContain('Raw championship'); expect(section.answer).not.toContain('opens');
    const subtree = output(await call('queryContinuity', { query: 'fixture:continuity', retrievalScope: { ...scope, scopeKind: 'subtree' } })).result.result;
    expect(subtree.sources).toHaveLength(3); expect(subtree.coverage.scopePages).toBe(2); expect(subtree.answer).not.toContain('Smackdown');
  });
  it('continues the same pinned synthetic snapshot cursor and rejects changed or forged cursors', async () => {
    const input = { query: 'fixture:continuity', retrievalScope: { ...scope, scopeKind: 'subtree' }, retrievalMode: 'complete_scope' };
    const first = output(await call('queryContinuity', input)).result.result;
    expect(first.coverage).toMatchObject({ hasMore: true, scopeChunks: 3, selectedChunks: 2 });
    const second = output(await call('queryContinuity', { ...input, cursor: first.coverage.nextCursor })).result.result;
    expect(second.sources).toHaveLength(1); expect(second.coverage.hasMore).toBe(false);
    expect(output(await call('queryContinuity', { ...input, cursor: 'forged' })).statusCode).toBe(409);
    expect(output(await call('queryContinuity', { ...input, retrievalScope: scope, cursor: first.coverage.nextCursor })).statusCode).toBe(409);
  });
  it.each(['fixture:stale', 'fixture:unavailable'])('fails closed for %s authority', async query => {
    const result = output(await call('queryContinuity', { query }));
    expect(result.statusCode).toBe(503); expect(result.result).toMatchObject({ result: null, official: false, fallbackPermitted: false });
  });
  it.each(['generateBooking', 'generateBookingWithHRC'])('preserves %s official synthetic provenance without canon persistence', async name => {
    const result = output(await call(name, { prompt: name === 'generateBooking' ? 'fixture:booking' : 'fixture:hrc' }));
    expect(result.result.result.storyline).toContain('Kay "Spotlight" Morales');
    expect(result.result.result.protectedGeneration).toMatchObject({ official: true, snapshotStatus: 'current_complete', fallbackUsed: false });
    if (name === 'generateBookingWithHRC') expect(result.result.result.hrc.fidelity).toBe(1);
    expect((await request(app).get(BOOKER_PREVIEW_EVIDENCE_PATH).set('Authorization', authorization)).body.canonWrites).toBe(0);
  });
  it('rejects protected generation and legacy universe/storyline fallback', async () => {
    expect(output(await call('generateBooking', { prompt: 'fixture:protected-failure' })).statusCode).toBe(503);
    for (const name of ['getBackstageUniverse', 'getBackstageStoryline']) {
      expect(output(await call(name, { ...(name === 'getBackstageStoryline' ? { storylineKey: 'Raw' } : {}) })).statusCode).toBe(409);
    }
  });
  it('uses the production ratings, modifier, interference and clamp algorithm', async () => {
    const match = { wrestler1: 'Synthetic A', wrestler2: 'Synthetic B', matchType: 'Singles' };
    const first = output(await call('simulateMatch', { match, rosters: roster })).result.result;
    expect(first.result).toMatchObject({ winner: 'Synthetic A', probability: { 'Synthetic A': '0.75', 'Synthetic B': '0.25' }, interference: 'Synthetic C', rating: '4.0' });
    const modified = output(await call('simulateMatch', { match, rosters: roster, winProbModifier: 0.1 })).result.result;
    expect(modified.result.probability['Synthetic A']).toBe('0.85');
    const rolls = [0.5, 0.7, 0];
    expect(simulateBackstageMatchCore(match, roster, 1, () => rolls.shift()!)).toMatchObject({ winner: 'Synthetic A', interference: null, probability: { 'Synthetic A': '1.00', 'Synthetic B': '0.00' } });
  });
});

describe('bounded process-local synthetic async continuation', () => {
  it.each(['completed', 'cancelled', 'failed'])('accepts, idempotently retries, polls and reconciles %s without replacement execution', async mode => {
    const input = { prompt: 'fixture:async:' + mode, idempotencyKey: 'preview-' + mode };
    const accepted = output(await call('generateBooking', input)); expect(accepted.statusCode).toBe(202);
    const jobId = accepted.result.jobId;
    expect(output(await call('generateBooking', input)).result.jobId).toBe(jobId);
    const evidenceBefore = (await request(app).get(BOOKER_PREVIEW_EVIDENCE_PATH).set('Authorization', authorization)).body;
    expect(output(await call('getBackstageBookerJobResult', { jobId, waitForResultMs: 0 })).result.status).toBe('pending');
    const completed = output(await call('getBackstageBookerJobResult', { jobId, waitForResultMs: 0 }));
    expect(completed.result.jobId).toBe(jobId); expect(completed.result.jobStatus).toBe(mode);
    if (mode === 'completed') expect(completed.result.result.result.protectedGeneration.official).toBe(true);
    else expect(completed.result).toMatchObject({ result: null, official: false, protectedGenerationCompleted: false, fallbackPermitted: false });
    expect(output(await call('getBackstageBookerJobResult', { jobId, waitForResultMs: 0 })).result).toEqual(completed.result);
    const evidence = (await request(app).get(BOOKER_PREVIEW_EVIDENCE_PATH).set('Authorization', authorization)).body;
    expect(evidence).toMatchObject({ pendingJobs: 0, terminalJobs: 1, canonWrites: 0, databaseWrites: 0, providerRequests: 0, notionRequests: 0, duplicateExecutions: 0 });
    expect(evidence.syntheticExecutions).toBe(evidenceBefore.syntheticExecutions);
  });
});
