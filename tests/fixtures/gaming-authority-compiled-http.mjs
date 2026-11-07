// Authored synthetic material only. Real compiled routes, queue, worker, SQL,
// acquisition/parsing and CLEAR validators; external DNS/publisher/model effects
// are mapped to deterministic loopback fixtures. No publisher or paid API calls.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { Resolver } from 'node:dns/promises';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import axios from 'axios';
import express from 'express';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dist = pathToFileURL(`${root}/dist/`).href;
const load = path => import(new URL(path, dist).href);
const buildIdentity = (await import(pathToFileURL(resolve(root, 'scripts/production-build-identity.mjs')).href))
  .readProductionBuildIdentity({ rootPath: root, env: {} });
assert.equal(buildIdentity.artifactStatus, 'matches_build_receipt', 'Acceptance must use freshly compiled current source and artifacts');
const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const gitTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();
assert.match(gitCommit, /^[a-f0-9]{40}$/u); assert.match(gitTree, /^[a-f0-9]{40}$/u);
const sourceIdentity = { commit: gitCommit, tree: gitTree, buildIdentity };
const readMode = process.argv[2] === '--read';
const database = process.env.JOB_CLAIM_FENCING_TEST_DATABASE_URL;
assert.ok(database, 'Dedicated disposable database is required');
const target = new URL(database);
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
assert.ok(new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(target.hostname.toLowerCase()), 'Dedicated database must use a shared-guard loopback hostname');
assert.equal(target.pathname, '/arcanos_audit_pg18_20260727');
assert.ok(target.username && target.password && target.port);
assert.equal(target.search + target.hash, '');
const schema = readMode ? process.argv[3] : `gaming_http_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^gaming_http_[a-f0-9]{32}$/u);
target.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
// The guarded disposable cluster uses plaintext on every accepted loopback form.
target.searchParams.set('sslmode', 'disable');
assert.equal(existsSync(resolve(root, '.env')), false, 'Compiled acceptance requires an isolated checkout without a private .env');
const operatingSystemEnvironment = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'COMSPEC', 'PATHEXT']);
for (const key of Object.keys(process.env)) if (!operatingSystemEnvironment.has(key)) delete process.env[key];
Object.assign(process.env, { DATABASE_URL: target.href, NODE_ENV: 'test', DISABLE_EXTERNAL_CALLS: 'true',
  WORKER_ID: 'synthetic-gaming-http', JOB_EVENT_RECORD_HEARTBEATS: 'false' });
let blockedNetwork = 0;
const connect = Socket.prototype.connect;
Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    blockedNetwork += 1; throw new Error('Unauthorized non-loopback network attempt');
  }
  return connect.apply(this, args);
};
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = () => { blockedNetwork += 1; throw new Error('Unexpected fetch'); };
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const PASSAGE = 'At the obsidian observatory, rotate the silver telescope toward the eastern beacon before crossing the crystal bridge. Open the amber gate after aligning the telescope.';
const GAME = 'Amber Pilgrim';
const PROMPT = 'How do I cross the obsidian observatory?';
let generated = 0;
let audited = 0;
const providerRequests = [];
let provider;
if (!readMode) {
  provider = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: decodeURIComponent(req.url.slice('/v1/models/'.length)), object: 'model', created: 1, owned_by: 'synthetic-loopback' })); return;
      }
      assert.equal(req.method, 'POST');
      assert.ok(['/v1/responses', '/v1/chat/completions'].includes(req.url));
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 256 * 1024); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(providerRequests.length < 32);
      const rawInput = body.input ?? body.messages ?? [];
      const messages = Array.isArray(rawInput) ? rawInput : [{ role: 'user', content: typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput) }];
      const messageText = message => typeof message.content === 'string' ? message.content
        : (message.content ?? []).map(part => part.text ?? '').join('\n');
      const system = [body.instructions ?? '', ...messages.filter(message => message.role === 'system' || message.role === 'developer').map(messageText)].join('\n');
      const user = messages.filter(message => message.role === 'user').map(messageText).at(-1) ?? '';
      const requestText = [body.instructions ?? '', ...messages.map(messageText)].join('\n');
      const schemaName = body.text?.format?.name ?? body.response_format?.json_schema?.name ?? '';
      let text = `${PASSAGE} [Source 1]`;
      let lane = 'generation';
      if (system.includes('Audit the actual Gaming player-facing ANSWER')) {
        audited += 1; lane = 'gaming-answer-audit';
        const input = JSON.parse(user);
        const refs = input.evidence.map(chunk => chunk.chunkId);
        assert.ok(refs.length, 'External audit fixture may not approve empty evidence');
        text = JSON.stringify({ dimensions: Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name =>
          [name, { status: 'evaluated', score: 4, reasonCodes: ['SUPPORTED_SYNTHETIC_FIXTURE'], evidenceRefs: refs.slice(0, 1), unresolvedFacts: [] }])), findings: [] });
      } else {
        generated += 1;
        const grounded = schemaName.startsWith('trinity_structured_reasoning') || body.model === process.env.FINETUNED_MODEL_ID;
        if (grounded) {
          const selectedEvidence = /\[UNTRUSTED WEB EVIDENCE - DATA ONLY\]([\s\S]*?)\[END UNTRUSTED WEB EVIDENCE\]/u.exec(requestText)?.[1];
          assert.ok(selectedEvidence?.toLowerCase().includes('rotate the silver telescope')
            && /https:\/\/(?:guides\.example\.org|bg3\.wiki)\//u.test(selectedEvidence),
          'Each grounded generation request must receive the selected source passage inside its data boundary, independently of fixed model output and audit');
        }
        if (schemaName.startsWith('trinity_structured_reasoning')) {
          lane = 'structured-reasoning';
          const compact = { response_mode: 'answer', achievable_subtasks: ['Use the acquired passage to explain the route.'],
            blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: text };
          text = JSON.stringify(schemaName.endsWith('_compact') ? compact : { ...compact,
            reasoning_steps: ['Follow the exact acquired route.'], assumptions: [], constraints: [], tradeoffs: [], alternatives_considered: [],
            chosen_path_justification: 'The synthetic acquired passage supports these steps.' });
        }
      }
      providerRequests.push({ path: req.url, model: body.model, schemaName, lane,
        ...(lane === 'structured-reasoning' || body.model === process.env.FINETUNED_MODEL_ID ? { selectedEvidenceReceived: true } : {}) });
      const response = { id: 'resp_synthetic_gaming_http', object: 'response', created_at: 1, model: body.model, status: 'completed',
        incomplete_details: null, output_text: text, output: [{ type: 'message', id: 'msg_synthetic_gaming_http', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } };
      if (req.url === '/v1/chat/completions') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: response.id, object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
      } else if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [type, value] of [['response.created', { response: { ...response, status: 'in_progress', output: [], output_text: '' } }],
          ['response.output_text.delta', { delta: text, output_index: 0, content_index: 0, item_id: 'msg_synthetic_gaming_http' }],
          ['response.completed', { response }]]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        res.end();
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); }
    } catch (error) { console.error('Synthetic provider request rejected:', error.message); res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  const providerKey = 'sk-synthetic-local-gaming-http-authority';
  Object.assign(process.env, { FINETUNED_MODEL_ID: 'ft:gpt-4.1:synthetic:gaming-http-authority', OPENAI_API_KEY: providerKey,
    OPENAI_BASE_URL: `${providerOrigin}/v1` });
  const providerFetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== providerOrigin || !(/^\/v1\/(?:responses|chat\/completions|models\/[^/]+)$/u.test(url.pathname))) {
      blockedNetwork += 1; throw new Error('Unauthorized provider request');
    }
    return nativeFetch(input, { ...init, redirect: 'error' });
  };
  (await load('core/adapters/openai.adapter.js')).getOpenAIAdapter({ apiKey: providerKey, baseURL: `${providerOrigin}/v1`, maxRetries: 0,
    timeout: 15000, fetch: providerFetch });
}
const admin = new pg.Client({ connectionString: database, ssl: false });
await admin.connect();
assert.ok(Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) >= 180000);
let db;
let publisher;
let server;
try {
  if (!readMode) {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}", pg_catalog`);
    const { TABLE_DEFINITIONS } = await load('core/db/schema.js');
    for (const table of ['job_data', 'job_events']) {
      const sql = TABLE_DEFINITIONS.find(value => value.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
      assert.ok(sql); await admin.query(sql);
    }
    await admin.query('ALTER TABLE job_events ADD COLUMN stats_worker_id VARCHAR(255), ADD COLUMN claim_generation BIGINT, ADD COLUMN operation VARCHAR(200)');
    await admin.query(readFileSync(resolve(root, 'migrations/20260808_gaming_knowledge_sources.sql'), 'utf8'));
  }
  db = await load('core/db/client.js');
  assert.equal(await db.initializeDatabase('synthetic-gaming-http'), true);
  const repository = await load('core/db/repositories/gamingSourceRepository.js');
  const { buildStoredGamingKnowledgeContext } = await load('services/gamingSourceIngestion.js');
  if (readMode) {
    const expected = JSON.parse(process.argv[4]);
    for (const item of expected) {
      const rows = await repository.searchActiveGamingKnowledge({ gameKey: item.game ?? GAME, sourceIds: [item.sourceId], query: 'observatory', mode: 'guide' });
      check(`fresh SQL searchable ${item.classification}`, () => assert.ok(rows.length));
      const selected = (await load('services/gamingStoredKnowledge.js')).selectStoredGamingEvidence(rows,
        { game: item.game ?? GAME, prompt: PROMPT, mode: 'guide', ...item.request, requireRequestCoverage: true });
      check(`fresh authority ${item.classification}`, () => assert.equal(selected.length > 0, item.eligible, JSON.stringify(item)));
      const scopedKnowledge = (await load('services/gamingStoredKnowledge.js')).formatStoredGamingEvidence(selected, { spoilerMode: 'none' });
      const scopedAssessment = (await load('shared/gaming/gamingClearEvidence.js')).assessGamingClearEvidence(
        { game: item.game ?? GAME, prompt: PROMPT, mode: 'guide', ...item.request }, scopedKnowledge, { identityVerified: true });
      check(`fresh CLEAR ${item.classification}`, () => assert.equal(scopedAssessment.decision === 'accept', item.eligible && item.answerEligible !== false,
        JSON.stringify({ item, assessment: scopedAssessment })));
      if (item.eligible) check('fresh exact citation', () => assert.ok(selected.every(row => row.evidence.sourceId === item.sourceId
        && row.evidence.revisionId === item.revisionId && rows.some(sql => sql.recordId === row.evidence.recordId))));
    }
    for (const game of new Set(expected.map(item => item.game ?? GAME))) {
      const requestContext = expected.find(item => (item.game ?? GAME) === game && item.eligible)?.request;
      const knowledge = await buildStoredGamingKnowledgeContext({ game, prompt: PROMPT, mode: 'guide', ...requestContext, requireRequestCoverage: true, failOnUnavailable: true });
      const deniedIds = expected.filter(item => (item.game ?? GAME) === game && !item.eligible).map(item => item.sourceId);
      check(`fresh normal retrieval fence ${game}`, () => assert.ok((knowledge.evidence ?? []).every(chunk => !deniedIds.includes(chunk.sourceId))));
      const positive = expected.some(item => (item.game ?? GAME) === game && item.eligible && item.answerEligible !== false);
      check(`fresh normal retrieval CLEAR ${game}`, () => assert.equal(knowledge.clearEvidenceAssessment?.decision === 'accept', positive));
    }
    check('fresh retrieval never generates', () => assert.equal(generated + audited, 0));
    check('fresh no external network', () => assert.equal(blockedNetwork, 0));
    console.log('GAMING_HTTP_RECEIPT ' + JSON.stringify({ schema, freshProcess: true, sourceIdentity, checks }));
  } else {
    const pages = new Map();
    const html = (text, extra = '', game = GAME) => `<html><head><title>${game} guide</title></head><body><main><h1>${game}</h1><p>In ${game}, the following acquired gameplay applies.</p><p>Edition: base game.</p>${extra}<p>${text}</p></main></body></html>`;
    pages.set('/verified', html(PASSAGE));
    pages.set('/reference', html('Welcome to the community wiki catalog. Browse the index of locations, items and walkthrough chapters. The observatory entry lists the telescope, eastern beacon, bridge and amber gate article titles. These topics are part of the encyclopedia directory and related article collection.'));
    pages.set('/unverified', `<html><body><main><h1>Observatory guide</h1><p>${PASSAGE}</p></main></body></html>`);
    pages.set('/wrong', '<html><body><main><p>Game: Doom Eternal.</p><p>' + PASSAGE + '</p></main></body></html>');
    pages.set('/retry', html(PASSAGE, '', 'Retry Pilgrim'));
    pages.set('/cancel', html(PASSAGE));
    const acquiredPaths = [];
    let retry = true;
    publisher = createServer((req, res) => {
      acquiredPaths.push(req.url);
      res.setHeader('content-type', 'text/html');
      if (req.url === '/retry' && retry) { res.writeHead(503); res.end('Synthetic retry'); return; }
      if (!pages.has(req.url)) { res.writeHead(404); res.end('Missing synthetic fixture'); return; }
      res.end(pages.get(req.url));
    });
    await new Promise(done => publisher.listen(0, '127.0.0.1', done));
    Resolver.prototype.resolve4 = async function(host) { assert.ok(['guides.example.org', 'swtor.com', 'bg3.wiki'].includes(host)); return ['93.184.216.34']; };
    Resolver.prototype.resolve6 = async function(host) { assert.ok(['guides.example.org', 'swtor.com', 'bg3.wiki'].includes(host)); return []; };
    // Mock only the external publisher transport: preserve the protected request
    // checks and stream actual HTTP bytes through all production meters/parsers.
    axios.Axios.prototype.get = async function(url, options) {
      assert.equal(new URL(url).hostname, '93.184.216.34');
      assert.ok(['guides.example.org', 'swtor.com', 'bg3.wiki'].includes(options.headers.Host));
      assert.equal(options.maxRedirects, 0); assert.equal(options.proxy, false);
      assert.equal(options.httpsAgent.options.rejectUnauthorized, true);
      return new Promise((done, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port: publisher.address().port,
          path: new URL(url).pathname, signal: options.signal }, response => done({
          data: response, headers: response.headers, status: response.statusCode, request: outgoing }));
        outgoing.on('error', reject); outgoing.end();
      });
    };
    const auth = await load('chatgpt/gamingAuth.js');
    const { GAMING_MCP_PATH, GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE } = await load('shared/chatgpt/gamingMcpContract.js');
    const configuration = auth.readGamingAuthConfiguration(name => ({ CHATGPT_GAMING_ENABLED: 'true',
      CHATGPT_GAMING_ISSUER: 'https://fixture-issuer.invalid/', CHATGPT_GAMING_RESOURCE: `https://fixture.invalid${GAMING_MCP_PATH}`,
      CHATGPT_GAMING_JWKS_URL: 'https://fixture-issuer.invalid/jwks', CHATGPT_GAMING_OWNER_SUBJECT: 'synthetic-owner',
      CHATGPT_GAMING_AUTO_STORE_APPROVED: 'true' })[name]);
    assert.equal(configuration.status, 'ready');
    const keys = await generateKeyPair('RS256');
    const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' }] });
    const token = (claims = {}) => new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
      scope: `${GAMING_QUERY_SCOPE} ${GAMING_WRITE_SCOPE}`, ...claims }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' }).sign(keys.privateKey);
    const bearer = await token();
    const application = express();
    application.use((await load('routes/chatgptGamingMcp.js')).createChatGptGamingMcpRouter({ configuration,
      verification: { keyResolver, readEnvironmentValue: () => undefined } }));
    server = application.listen(0, '127.0.0.1');
    await new Promise(done => server.on('listening', done));
    let ownerWindowStartedAt = Date.now();
    let ownerWindowRequests = 0;
    async function rpc(name, args, signed = bearer, method = 'tools/call') {
      // Keep the expanded authored transcript within the real 30/minute owner
      // admission limit. No limiter, clock, execution or provider guard is mocked.
      if (ownerWindowRequests >= 30) {
        await new Promise(done => setTimeout(done, Math.max(0, 60_000 - (Date.now() - ownerWindowStartedAt)) + 50));
        ownerWindowStartedAt = Date.now(); ownerWindowRequests = 0;
      }
      ownerWindowRequests += 1;
      const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, ...(method === 'tools/call' ? { params: { name, arguments: args } } : {}) });
      return new Promise((done, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port: server.address().port, path: GAMING_MCP_PATH, method: 'POST',
          headers: { Authorization: `Bearer ${signed}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
          let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
          response.on('end', () => done({ status: response.statusCode, body: JSON.parse(text) }));
        }); outgoing.on('error', reject); outgoing.end(body);
      });
    }
    const unwrap = response => {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.error, undefined, JSON.stringify(response.body));
      assert.ok(response.body.result.structuredContent, JSON.stringify(response.body));
      return response.body.result.structuredContent;
    };
    const jobs = await load('core/db/repositories/jobRepository.js');
    const catalog = await rpc(undefined, undefined, bearer, 'tools/list');
    check('actual MCP catalog ceiling', () => assert.ok(Buffer.byteLength(JSON.stringify(catalog.body)) <= 65536));
    const { executeQueuedGptRequest } = await load('workers/jobRunner.js');
    async function work(id, cancellationSignal) {
      const claimed = await jobs.claimNextPendingJob({ workerId: 'synthetic-gaming-http', leaseMs: 30000, priorityQueueEnabled: false });
      assert.equal(claimed?.id, id);
      const result = await executeQueuedGptRequest({ jobId: id, rawInput: claimed.input, cancellationSignal });
      const fence = jobs.createClaimedJobFence('synthetic-gaming-http', claimed.claim_generation);
      const finished = result.retryable ? await jobs.scheduleJobRetry(id, { fence, delayMs: 0, errorMessage: result.errorMessage })
        : await jobs.updateClaimedJobTerminal(id, result.status, { fence, output: result.output, errorMessage: result.errorMessage });
      assert.ok(finished); return result;
    }
    const write = path => ({ game: GAME, sourceUrls: [`https://guides.example.org${path}`], idempotencyKey: randomUUID(), storagePolicy: 'ask_before_store', confirmStore: true });
    const verifiedInput = write('/verified');
    const admitted = unwrap(await rpc('arcanos_gaming_ingest_sources', verifiedInput));
    check('authenticated durable queue', () => assert.equal(admitted.statusCode, 202));
    const duplicate = unwrap(await rpc('arcanos_gaming_ingest_sources', verifiedInput));
    check('idempotency preserves job identity', () => assert.equal(duplicate.result.ingestionId, admitted.result.ingestionId));
    const conflict = unwrap(await rpc('arcanos_gaming_ingest_sources', { ...verifiedInput, sourceUrls: ['https://guides.example.org/reference'] }));
    check('changed-body same-key conflict', () => assert.equal(conflict.statusCode, 409));
    const completed = await work(admitted.result.ingestionId);
    const verified = completed.output.sources[0];
    check('verified current source stored', () => assert.equal(verified.classification, 'verified'));
    const beforeDeniedJobs = (await admin.query('SELECT COUNT(*)::int AS count FROM job_data')).rows[0].count;
    const beforeDeniedAcquisitions = acquiredPaths.length;
    const denied = await rpc('arcanos_gaming_ingest_sources', write('/wrong'), await token({ sub: 'other-owner' }));
    check('cross-owner HTTP fails closed', () => assert.equal(denied.status, 401));
    const readOnly = await rpc('arcanos_gaming_ingest_sources', write('/wrong'), await token({ scope: GAMING_QUERY_SCOPE }));
    check('write scope enforced', () => {
      assert.equal(readOnly.body.result.isError, true);
      assert.equal(readOnly.body.result.content[0].text, 'GAMING_PERMISSION_DENIED');
    });
    check('denials have no queue or acquisition effects', () => assert.equal(acquiredPaths.length, beforeDeniedAcquisitions));
    const afterDeniedJobs = (await admin.query('SELECT COUNT(*)::int AS count FROM job_data')).rows[0].count;
    check('denials create no jobs', () => assert.equal(afterDeniedJobs, beforeDeniedJobs));
    const states = [{ ...verified, eligible: true }];
    for (const path of ['/reference', '/unverified']) {
      const response = unwrap(await rpc('arcanos_gaming_ingest_sources', write(path)));
      const result = await work(response.result.ingestionId);
      const item = result.output.sources[0];
      check(`${path} retained non-authoritative`, () => assert.equal(item.generationEligible, false));
      states.push({ ...item, eligible: false });
    }
    const wrong = unwrap(await rpc('arcanos_gaming_ingest_sources', write('/wrong')));
    const wrongResult = await work(wrong.result.ingestionId);
    check('conflicting identity rejected', () => assert.equal(wrongResult.output.sources[0].status, 'rejected'));
    const unverified = states[2];
    pages.set('/unverified', html(PASSAGE));
    const refresh = unwrap(await rpc('arcanos_gaming_refresh_sources', { sourceIds: [unverified.sourceId], idempotencyKey: randomUUID(), storagePolicy: 'ask_before_store', confirmStore: true }));
    const refreshed = (await work(refresh.result.ingestionId)).output.sources[0];
    check('refresh cannot grant authority', () => assert.equal(refreshed.generationEligible, false));
    states[2] = { ...refreshed, eligible: false };
    for (const version of ['gaming-hybrid-v1', 'gaming-hybrid-v2']) {
      const beforeReferenceProviders = providerRequests.length;
      const hybridGame = version === 'gaming-hybrid-v1' ? 'Catalog Pilgrim' : 'Catalog Voyager';
      const path = `/reference-${version}`;
      pages.set(path, html('Welcome to the community wiki catalog. Browse the index of locations, items and walkthrough chapters. The observatory entry lists the telescope, eastern beacon, bridge and amber gate article titles. These topics are part of the encyclopedia directory and related article collection.', '', hybridGame));
      const query = unwrap(await rpc('arcanos_gaming_hybrid_query', { contractVersion: version, game: hybridGame,
        question: PROMPT, storagePolicy: 'ask_before_store', idempotencyKey: randomUUID() })).result;
      const found = unwrap(await rpc('arcanos_gaming_submit_candidates', { contractVersion: version, workflowId: query.workflowId,
        ...(version === 'gaming-hybrid-v2' ? { expectedRevision: query.revision } : {}), candidates: [{ url: `https://guides.example.org${path}` }],
        idempotencyKey: randomUUID() })).result;
      check(`${version} catalog no selected evidence`, () => assert.equal(found.evidenceSelected, false));
      check(`${version} catalog no answer`, () => assert.equal(found.answer, undefined));
      const storage = { contractVersion: version, workflowId: query.workflowId, candidateIds: [found.candidates[0].candidateId],
        storagePolicy: 'ask_before_store', confirmStore: true, idempotencyKey: randomUUID() };
      const automaticReference = await rpc('arcanos_gaming_ingest_candidates', { ...storage, storagePolicy: 'auto_store_approved', confirmStore: false, idempotencyKey: randomUUID() });
      check(`${version} storage policy substitution denied`, () => assert.ok(automaticReference.body.result.isError
        || automaticReference.body.result.structuredContent.statusCode >= 400));
      const forged = unwrap(await rpc('arcanos_gaming_ingest_candidates', { ...storage, candidateIds: [randomUUID()], idempotencyKey: randomUUID() }));
      check(`${version} substituted candidate denied`, () => assert.equal(forged.statusCode, 404));
      if (version === 'gaming-hybrid-v1') {
        const deniedReference = await rpc('arcanos_gaming_ingest_candidates', storage);
        check('v1 reference cannot become approved evidence', () => assert.ok(deniedReference.body.result.isError
          || deniedReference.body.result.structuredContent.statusCode >= 400));
        check('v1 reference invokes no generation', () => assert.equal(providerRequests.length, beforeReferenceProviders));
        continue;
      }
      const stored = unwrap(await rpc('arcanos_gaming_ingest_candidates', storage));
      assert.ok(stored?.result?.ingestion, JSON.stringify(stored));
      const result = (await work(stored.result.ingestion.ingestionId)).output.sources[0];
      check(`${version} confirmed reference excluded`, () => assert.equal(result.generationEligible, false));
      check(`${version} reference invokes no generation`, () => assert.equal(providerRequests.length, beforeReferenceProviders));
      states.push({ ...result, eligible: false, game: hybridGame });
    }
    // Authored synthetic bytes exercise the existing reviewed community policy;
    // no real publisher is contacted and no real-game accuracy is claimed.
    const confirmedGame = "Baldur's Gate 3";
    const confirmedPath = '/wiki/Synthetic_observatory_1592';
    const confirmedUrl = `https://bg3.wiki${confirmedPath}`;
    pages.set(confirmedPath, html(PASSAGE, '', confirmedGame));
    const confirmedProviderStart = providerRequests.length;
    const confirmedQuery = unwrap(await rpc('arcanos_gaming_hybrid_query', { contractVersion: 'gaming-hybrid-v2',
      game: confirmedGame, edition: 'base-game', question: PROMPT, storagePolicy: 'ask_before_store', idempotencyKey: randomUUID() })).result;
    const confirmedFound = unwrap(await rpc('arcanos_gaming_submit_candidates', { contractVersion: 'gaming-hybrid-v2',
      workflowId: confirmedQuery.workflowId, expectedRevision: confirmedQuery.revision,
      candidates: [{ url: confirmedUrl }], idempotencyKey: randomUUID() })).result;
    check('owner-confirmed verified hybrid selects grounded evidence', () => {
      assert.equal(confirmedFound.state, 'answer_ready', JSON.stringify(confirmedFound));
      assert.equal(confirmedFound.evidenceSelected, true);
      assert.equal(confirmedFound.answer?.provenance, 'arcanos-trinity');
      assert.ok(confirmedFound.answer.sources.some(source => source.url === confirmedUrl));
      assert.ok(confirmedFound.answer.response.includes('silver telescope'));
    });
    const confirmedStored = unwrap(await rpc('arcanos_gaming_ingest_candidates', { contractVersion: 'gaming-hybrid-v2',
      workflowId: confirmedQuery.workflowId, candidateIds: [confirmedFound.candidates[0].candidateId],
      storagePolicy: 'ask_before_store', confirmStore: true, idempotencyKey: randomUUID() }));
    assert.ok(confirmedStored.result.ingestion, JSON.stringify(confirmedStored));
    const confirmed = (await work(confirmedStored.result.ingestion.ingestionId)).output.sources[0];
    check('owner-confirmed verified hybrid persists through queued worker', () => {
      assert.equal(confirmed.classification, 'verified');
      assert.equal(confirmed.generationEligible, true);
      assert.equal(confirmed.canonicalUrl, confirmedUrl);
      assert.ok(confirmed.sourceId);
    });
    check('owner-confirmed verified hybrid uses real provider stages', () => {
      const requests = providerRequests.slice(confirmedProviderStart);
      assert.ok(requests.some(item => item.lane === 'structured-reasoning'));
      assert.ok(requests.some(item => item.model === process.env.FINETUNED_MODEL_ID));
      assert.equal(requests.filter(item => item.lane === 'gaming-answer-audit').length, 1);
    });
    states.push({ ...confirmed, eligible: true, game: confirmedGame, request: { edition: 'base-game' } });
    const autoGame = 'Star Wars: The Old Republic';
    const autoPath = '/patchnotes/synthetic-1592-authority';
    pages.set(autoPath, html(PASSAGE, '<p>Patch: 2.1. Published at: 2026-11-07. Platforms: all. Regions: all.</p>', autoGame)
      .replace(`<title>${autoGame} guide</title>`, `<title>${autoGame} patch notes</title>`));
    const autoDocument = await (await load('services/gamingDocumentResolution.js')).resolveGamingDocument(`https://swtor.com${autoPath}`);
    const autoFreshness = (await load('shared/gaming/gamingFreshnessCore.js')).extractGamingFreshnessMetadata(autoDocument, { game: autoGame });
    assert.equal(autoFreshness.autoStoreAllowed, true, JSON.stringify(autoFreshness));
    const autoEvaluated = await (await load('services/gamingHybridCandidates.js')).evaluateGamingHybridCandidates({ game: autoGame, edition: 'base-game',
      prompt: PROMPT, mode: 'guide', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: `https://swtor.com${autoPath}` }] }, { actorKey: 'synthetic-precondition' });
    assert.equal(autoEvaluated.accepted[0]?.sourcePolicy.autoStoreAllowed, true, JSON.stringify(autoEvaluated.accepted.map(value => ({
      sourcePolicy: value.sourcePolicy, freshness: value.freshness, quality: value.sourceAssessment.qualityEligible, truncated: value.document.metrics.truncated }))));
    assert.equal(autoEvaluated.accepted[0]?.sourceAssessment.qualityEligible, true, JSON.stringify(autoEvaluated.accepted[0]?.sourceAssessment));
    const autoQuery = unwrap(await rpc('arcanos_gaming_hybrid_query', { contractVersion: 'gaming-hybrid-v2', game: autoGame, edition: 'base-game', version: '2.1',
      question: PROMPT, storagePolicy: 'auto_store_approved', idempotencyKey: randomUUID() })).result;
    const autoFound = unwrap(await rpc('arcanos_gaming_submit_candidates', { contractVersion: 'gaming-hybrid-v2', workflowId: autoQuery.workflowId,
      expectedRevision: autoQuery.revision, candidates: [{ url: `https://swtor.com${autoPath}` }], idempotencyKey: randomUUID() })).result;
    const autoStored = unwrap(await rpc('arcanos_gaming_ingest_candidates', { contractVersion: 'gaming-hybrid-v2', workflowId: autoQuery.workflowId,
      candidateIds: [autoFound.candidates[0].candidateId], storagePolicy: 'auto_store_approved', confirmStore: true, idempotencyKey: randomUUID() }));
    assert.ok(autoStored.result.ingestion, JSON.stringify(autoStored));
    const automatic = (await work(autoStored.result.ingestion.ingestionId)).output.sources[0];
    check('automatic storage requires and preserves verified assessment', () => assert.equal(automatic.generationEligible, true, JSON.stringify(automatic)));
    // A verified patch authority can support an evidence set; it cannot alone
    // establish a complete gameplay route or the latest official patch.
    states.push({ ...automatic, eligible: true, answerEligible: false, game: autoGame, request: { edition: 'base-game', requestedVersion: '2.1' } });
    const autoReferenceGame = 'Automatic Voyager';
    pages.set('/auto-reference', html('Welcome to the community wiki catalog. Browse the index of locations, items and walkthrough chapters. The observatory entry lists the telescope, eastern beacon, bridge and amber gate article titles.', '', autoReferenceGame));
    const autoReferenceQuery = unwrap(await rpc('arcanos_gaming_hybrid_query', { contractVersion: 'gaming-hybrid-v2', game: autoReferenceGame,
      question: PROMPT, storagePolicy: 'auto_store_approved', idempotencyKey: randomUUID() })).result;
    const autoReferenceFound = unwrap(await rpc('arcanos_gaming_submit_candidates', { contractVersion: 'gaming-hybrid-v2', workflowId: autoReferenceQuery.workflowId,
      expectedRevision: autoReferenceQuery.revision, candidates: [{ url: 'https://guides.example.org/auto-reference' }], idempotencyKey: randomUUID() })).result;
    // Rejected automatic candidates expose no usable backend storage handle.
    // A syntactically valid forged handle still must fail the owned-candidate check.
    const automaticReferenceId = autoReferenceFound.candidates[0].candidateId;
    const autoReferenceDenied = unwrap(await rpc('arcanos_gaming_ingest_candidates', { contractVersion: 'gaming-hybrid-v2', workflowId: autoReferenceQuery.workflowId,
      candidateIds: [/^[a-f0-9-]{36}$/iu.test(automaticReferenceId ?? '') ? automaticReferenceId : randomUUID()],
      storagePolicy: 'auto_store_approved', confirmStore: true, idempotencyKey: randomUUID() }));
    check('automatic reference cannot gain storage approval', () => assert.ok(autoReferenceDenied.statusCode >= 400));
    check('automatic reference no answer evidence', () => assert.equal(autoReferenceFound.evidenceSelected, false));
    const retryJob = unwrap(await rpc('arcanos_gaming_ingest_sources', { ...write('/retry'), game: 'Retry Pilgrim' }));
    const failedAttempt = await work(retryJob.result.ingestionId);
    check('transient source retryable', () => assert.equal(failedAttempt.retryable, true));
    retry = false;
    const retried = await work(retryJob.result.ingestionId);
    check('retry completes through worker', () => assert.equal(retried.status, 'completed'));
    const cancelled = unwrap(await rpc('arcanos_gaming_ingest_sources', write('/cancel')));
    const controller = new AbortController(); controller.abort(new Error('Synthetic cancellation'));
    const cancelledResult = await work(cancelled.result.ingestionId, controller.signal);
    check('worker cancellation', () => assert.equal(cancelledResult.status, 'cancelled'));
    check('cancelled source not acquired', () => assert.ok(!acquiredPaths.includes('/cancel')));
    const knowledge = await buildStoredGamingKnowledgeContext({ game: GAME, prompt: PROMPT, mode: 'guide', requireRequestCoverage: true, failOnUnavailable: true });
    check('stored evidence CLEAR accept', () => assert.equal(knowledge.clearEvidenceAssessment.decision, 'accept'));
    check('only eligible SQL sources selected', () => assert.ok(knowledge.evidence.every(chunk => !states.filter(state => !state.eligible).some(state => state.sourceId === chunk.sourceId))));
    const answer = unwrap(await rpc('arcanos_gaming_query', { game: GAME, prompt: PROMPT, mode: 'guide' }));
    check('real compiled grounded response', () => assert.equal(answer.result.data.grounding.groundingStatus, 'grounded'));
    check('real answer audit executed', () => assert.ok(generated > 0 && audited > 0, JSON.stringify({ providerRequests, generated, audited, answer })));
    check('real answer is completed without fallback', () => assert.equal(answer.result.data.fallbackReason, undefined));
    check('grounded response includes exact source', () => assert.ok(answer.result.data.sources.some(source => source.url === verified.canonicalUrl || source.sourceId === verified.sourceId)));
    for (const state of states) {
      const source = await repository.getGamingSourceById(state.sourceId);
      assert.ok(source?.latestRevision?.id);
      state.revisionId = source.latestRevision.id;
    }
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--read', schema, JSON.stringify(states)], { cwd: root,
      env: { ...process.env, JOB_CLAIM_FENCING_TEST_DATABASE_URL: database }, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    check('fresh process receipt', () => assert.ok(child.stdout.includes('GAMING_HTTP_RECEIPT')));
    check('no unauthorized network attempted', () => assert.equal(blockedNetwork, 0));
    check('real structured reasoning reached provider transport', () => assert.ok(providerRequests.some(item => item.lane === 'structured-reasoning')));
    check('real final authority reached provider transport', () => assert.ok(providerRequests.some(item => item.model === process.env.FINETUNED_MODEL_ID)));
    check('every grounded generation request received selected evidence', () => {
      const groundedRequests = providerRequests.filter(item => item.lane === 'structured-reasoning' || item.model === process.env.FINETUNED_MODEL_ID);
      assert.equal(groundedRequests.length, 4);
      assert.ok(groundedRequests.every(item => item.selectedEvidenceReceived === true));
    });
    console.log('GAMING_HTTP_RECEIPT ' + JSON.stringify({ schema, compiled: true, sourceIdentity, provider: 'synthetic loopback HTTP; real SDK/adapter/Trinity', checks,
      acquiredPaths, generated, audited, providerRequests, freshProcess: JSON.parse(child.stdout.split('GAMING_HTTP_RECEIPT ').at(-1).split(/\r?\n/u)[0]), states }));
  }
} finally {
  if (server) await new Promise(done => server.close(done));
  if (publisher) await new Promise(done => publisher.close(done));
  if (provider) await new Promise(done => provider.close(done));
  if (db) await db.close();
  if (!readMode) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
