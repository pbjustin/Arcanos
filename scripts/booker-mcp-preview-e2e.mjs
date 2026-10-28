#!/usr/bin/env node
// Supplemental Booker matrix using the existing native preview target guards.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseNativePrPreviewE2eArguments, expectedNativePrPreviewResponseBody } from './native-pr-preview-e2e.mjs';
import { signBookerPreviewToken, BOOKER_PREVIEW_ISSUER, BOOKER_PREVIEW_UNIVERSE_ID } from './booker-mcp-preview-key.mjs';

const path = '/chatgpt/booker/mcp';
const metadataPath = '/.well-known/oauth-protected-resource/chatgpt/booker/mcp';
const evidencePath = '/chatgpt/booker/preview-evidence';
const proofHeader = 'x-arcanos-preview-chatgpt-booker-version';
const proofVersion = 'chatgpt-booker-mcp-core/v1';
const catalogSha256 = 'b3cd8ade2cd280d2082fb8c2f0e4ff06380ccf6255c7ecfb1161aad46ed074a3'; // gitleaks:allow -- public catalog digest
const readCatalogSha256 = 'c41736ff3d0e18c348ae85bdca2601050c2de253dc96079b0fac443a448e36f0'; // gitleaks:allow -- public catalog digest
const universeId = BOOKER_PREVIEW_UNIVERSE_ID;
const tools = ['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch',
  'getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult'];
const readTools = ['queryContinuity', 'getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult'];
const hash = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, code, id) => { if (!condition) throw new Error(`BOOKER_PREVIEW_${code}:${id}`); };
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 'booker-preview', method, params });
const toolCall = (name, args) => rpc('tools/call', { name, arguments: { universeId, ...args } });

/** Bounded same-origin requests only. Tokens and response payloads never enter receipts. */
export async function runBookerMcpPreviewE2e({ args = [], localGitState, fetchImpl = globalThis.fetch,
  waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const options = parseNativePrPreviewE2eArguments(args, localGitState === undefined ? {} : { localGitState });
  assert(options.prNumber === 1566, 'PR_SCOPE', 'preflight');
  const target = { repository: options.repository, prNumber: options.prNumber, commitSha: options.commitSha,
    webHost: new URL(options.webBaseUrl).hostname, workerHost: new URL(options.workerBaseUrl).hostname };
  const limits = { maxRequests: 80, maxResponseBytes: Math.min(options.maxResponseBytes, 65_536), maxAggregateResponseBytes: 512 * 1024,
    requestTimeoutMs: Math.min(options.requestTimeoutMs, 5_000), totalTimeoutMs: options.totalTimeoutMs };
  if (!options.execute) return { kind: 'booker_mcp_synthetic_preview', executed: false, networkAttempted: false,
    target, limits, checks: [], summary: { status: 'PASS', code: 'EXACT_HEAD_TARGETS_VALIDATED_NO_NETWORK' } };
  const deadline = Date.now() + limits.totalTimeoutMs;
  const resource = options.webBaseUrl + path;
  const owner = await signBookerPreviewToken({ resource });
  const reader = await signBookerPreviewToken({ resource, readOnly: true });
  const checks = [];
  let aggregateBytes = 0;
  let authenticatedRpcCount = 0;
  const request = async (id, { role = 'web', route = path, method = 'POST', body,
    token = owner, headers = {}, status = 200, raw = false, deny = false, authenticated = true } = {}) => {
    // Keep the unchanged production 30/min owner limiter. One bounded window
    // rollover is part of the 120-second acceptance budget, never a retry loop.
    if (route === path && authenticated && authenticatedRpcCount++ === 28) {
      for (const delay of [30_000, 30_000, 1_000]) {
        assert(deadline - Date.now() > delay, 'TOTAL_TIMEOUT', id);
        await waitImpl(delay);
      }
    }
    assert(checks.length < limits.maxRequests && Date.now() < deadline, 'REQUEST_BOUND', id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(limits.requestTimeoutMs, deadline - Date.now()));
    try {
      const response = await fetchImpl((role === 'web' ? options.webBaseUrl : options.workerBaseUrl) + route, {
        method, redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json, text/event-stream', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      });
      assert(response.status === status, 'HTTP_STATUS', id);
      assert(!response.headers.has('set-cookie') && !response.headers.has('mcp-session-id'), 'STATE_HEADER', id);
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength; aggregateBytes += chunk.byteLength;
        assert(size <= limits.maxResponseBytes && aggregateBytes <= limits.maxAggregateResponseBytes, 'RESPONSE_BOUND', id);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8');
      let value;
      if (deny) {
        assert(text === 'not found' && !response.headers.has(proofHeader), 'WORKER_DENIAL', id);
      } else if (route === '/readyz') {
        value = JSON.parse(text);
        assert(isDeepStrictEqual(value, expectedNativePrPreviewResponseBody({ expectedType: `${role}-readiness` }, options)), 'EXACT_ROLE_IDENTITY', id);
      } else {
        if (route === '/chatgpt/mcp' || route === '/chatgpt/gaming/mcp') {
          assert(!response.headers.has(proofHeader) && response.headers.get('x-arcanos-preview-fixture') === 'sealed-synthetic', 'REGRESSION_ISOLATION', id);
        } else assert(response.headers.get(proofHeader) === proofVersion, 'ACTUAL_TRANSPORT_PROOF', id);
        assert(response.headers.get('cache-control')?.includes('no-store'), 'NO_STORE', id);
        value = text ? JSON.parse(text) : undefined;
      }
      checks.push({ caseId: id, role, httpStatus: response.status, responseBytes: size, bodySha256: hash(bytes) });
      return value;
    } finally { clearTimeout(timer); controller.abort(); }
  };
  const call = async (id, name, input, expectedStatus = 200, extra = {}) => {
    const body = await request(id, { body: toolCall(name, input), ...extra });
    assert(body?.jsonrpc === '2.0' && body.id === 'booker-preview', 'RPC_ENVELOPE', id);
    const output = body.result?.structuredContent;
    assert(output?.statusCode === expectedStatus && Boolean(body.result.isError) === (expectedStatus >= 400), 'TOOL_OUTPUT', id);
    assert(isDeepStrictEqual(body.result.content, [{ type: 'text', text: JSON.stringify(output) }]), 'STRUCTURED_PARITY', id);
    return output.result;
  };
  const deniedTool = async (id, name, input, code, extra = {}) => {
    const body = await request(id, { body: toolCall(name, input), ...extra });
    assert(body?.result?.isError === true && body.result.content?.[0]?.text === code && !body.result.structuredContent, 'TOOL_DENIAL', id);
  };
  const evidence = async id => {
    const result = await request(id, { route: evidencePath, method: 'GET', token: reader });
    assert(result?.transport === 'actual-production-core' && result.synthetic === true
      && result.providerRequests === 0 && result.notionRequests === 0 && result.databaseWrites === 0 && result.canonWrites === 0,
    'ISOLATED_EFFECTS', id);
    return result;
  };
  for (const role of ['web', 'worker']) await request(`${role}-ready-initial`, { role, route: '/readyz', method: 'GET', token: null, authenticated: false });
  const metadata = await request('metadata', { route: metadataPath, method: 'GET', token: null });
  assert(isDeepStrictEqual(metadata, { resource, authorization_servers: [BOOKER_PREVIEW_ISSUER],
    scopes_supported: ['arcanos:booker:read', 'arcanos:booker:generate'], bearer_methods_supported: ['header'] }), 'METADATA', 'metadata');
  await request('missing-token', { token: null, body: '{', raw: true, status: 401, authenticated: false });
  for (const [id, claims, status] of [
    ['wrong-audience', { aud: options.webBaseUrl + '/chatgpt/mcp' }, 401],
    ['multiple-audiences', { aud: [resource, options.webBaseUrl + '/chatgpt/gaming/mcp'] }, 401],
    ['wrong-owner', { sub: 'unauthorized-synthetic-owner' }, 401],
    ['wrong-client', { client_id: 'unauthorized-client' }, 401],
    ['wrong-issuer', { iss: 'https://other-issuer.invalid/' }, 401],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 1 }, 401],
    ['wrong-scope', { scope: 'arcanos:tutor' }, 403],
  ]) await request(id, { token: await signBookerPreviewToken({ resource, claims }), body: rpc('tools/list'), status, authenticated: false });
  const parts = owner.split('.'); parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
  await request('wrong-signature', { token: parts.join('.'), body: rpc('tools/list'), status: 401, authenticated: false });
  const initialized = await request('initialize', { body: rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'booker-synthetic-verifier', version: '1.0.0' } }) });
  assert(initialized?.result?.protocolVersion === '2025-03-26'
    && initialized.result.serverInfo?.name === 'arcanos-backstage-booker-private', 'INITIALIZE', 'initialize');
  for (const [id, token, names] of [['catalog-owner', owner, tools], ['catalog-reader', reader, readTools]]) {
    const body = await request(id, { token, body: rpc('tools/list') });
    assert(isDeepStrictEqual(body?.result?.tools?.map(tool => tool.name), names), 'EXACT_TOOLS', id);
    assert(hash(JSON.stringify(body.result.tools)) === (id === 'catalog-owner' ? catalogSha256 : readCatalogSha256), 'EXACT_CATALOG', id);
    for (const tool of body.result.tools) assert(tool.securitySchemes?.every(item => item.type === 'oauth2')
      && tool.annotations?.destructiveHint === false, 'TOOL_SECURITY', id);
  }
  await deniedTool('read-only-generation', 'generateBooking', { prompt: 'fixture:booking' }, 'BOOKER_PERMISSION_DENIED', { token: reader });
  await deniedTool('cross-universe', 'queryContinuity', { universeId: 'other-universe', query: 'fixture:continuity' }, 'BOOKER_UNIVERSE_DENIED');
  await deniedTool('canon-write-denied', 'saveStoryline', {}, 'BOOKER_TOOL_UNAVAILABLE');
  await deniedTool('administration-denied', 'modules.invoke', {}, 'BOOKER_TOOL_UNAVAILABLE');
  const scope = { pageTitle: 'Raw', pagePath: ['Universe', 'Raw'] };
  const exact = await call('continuity-exact-page', 'queryContinuity', { query: 'fixture:continuity', retrievalScope: scope });
  const content = exact.result;
  assert(content?.coverage?.scopeChunks === 2 && content.sources?.every(source => source.pageTitle === 'Raw')
    && !content.answer.includes('Smackdown') && !content.answer.includes('prior Raw exhibition'), 'EXACT_PAGE', 'continuity-exact-page');
  const section = await call('continuity-section', 'queryContinuity', { query: 'fixture:continuity', retrievalScope: { ...scope, sectionPath: ['Main event'] } });
  assert(section.result?.coverage?.scopeChunks === 1 && !section.result.answer.includes('opens'), 'SECTION_BOUNDARY', 'continuity-section');
  const subtree = await call('continuity-subtree', 'queryContinuity', { query: 'fixture:continuity', retrievalScope: { ...scope, scopeKind: 'subtree' } });
  assert(subtree.result?.coverage?.scopeChunks === 3 && subtree.result.answer.includes('prior Raw exhibition')
    && !subtree.result.answer.includes('Smackdown'), 'SUBTREE_BOUNDARY', 'continuity-subtree');
  const firstPage = await call('continuity-page-one', 'queryContinuity', { query: 'fixture:continuity', retrievalMode: 'complete_scope' });
  const cursor = firstPage.result?.coverage?.nextCursor;
  assert(firstPage.result?.coverage?.hasMore === true && typeof cursor === 'string', 'SNAPSHOT_CURSOR', 'continuity-page-one');
  const secondPage = await call('continuity-page-two', 'queryContinuity', { query: 'fixture:continuity', retrievalMode: 'complete_scope', cursor });
  assert(secondPage.result?.coverage?.hasMore === false && secondPage.result?.coverage?.exhaustive === true
    && secondPage.result?.authority === 'notion', 'SNAPSHOT_COMPLETE', 'continuity-page-two');
  await call('continuity-cursor-rejected', 'queryContinuity', { query: 'fixture:continuity', retrievalMode: 'complete_scope', cursor: 'invalid' }, 409);
  for (const scenario of ['stale', 'unavailable']) {
    const result = await call(`authority-${scenario}`, 'queryContinuity', { query: `fixture:${scenario}` }, 503);
    assert(result.official === false && result.fallbackPermitted === false, 'NO_FABRICATED_CANON', scenario);
  }
  for (const [name, prompt] of [['generateBooking', 'fixture:booking'], ['generateBookingWithHRC', 'fixture:hrc']]) {
    const result = await call(name, name, { prompt }); const output = result.result;
    assert(output?.universeId === universeId && output.storyline?.includes('Kay "Spotlight" Morales')
      && output.protectedGeneration?.official === true && output.protectedGeneration.snapshotStatus === 'current_complete'
      && output.protectedGeneration.fallbackUsed === false
      && (name !== 'generateBookingWithHRC' || output.hrc?.verdict?.includes('synthetic')), 'OFFICIAL_PROVENANCE', name);
  }
  await call('generation-protected-failure', 'generateBooking', { prompt: 'fixture:protected-failure' }, 503);
  const simulation = await call('simulation', 'simulateMatch', { match: { wrestler1: 'Synthetic A', wrestler2: 'Synthetic B', matchType: 'Singles' },
    rosters: [{ name: 'Synthetic A', overall: 90 }, { name: 'Synthetic B', overall: 60 }, { name: 'Synthetic C', overall: 70 }], winProbModifier: 0.1 });
  assert(simulation.result?.result?.winner === 'Synthetic A' && simulation.result.result.probability?.['Synthetic A'] === '0.85'
    && simulation.result.result.interference === 'Synthetic C' && simulation.result.result.rating === '4.0', 'MATCH_POLICY', 'simulation');
  await call('universe-quarantine', 'getBackstageUniverse', {}, 409);
  await call('storyline-quarantine', 'getBackstageStoryline', { storylineKey: 'Raw' }, 409);
  for (const mode of ['completed', 'cancelled', 'failed']) {
    const input = { prompt: `fixture:async:${mode}`, idempotencyKey: `booker-preview-${options.commitSha}-${mode}` };
    const accepted = await call(`async-${mode}-accepted`, 'generateBooking', input, 202);
    assert(typeof accepted.jobId === 'string' && accepted.instruction?.includes(accepted.jobId), 'ACCEPTED_JOB', mode);
    const before = await evidence(`async-${mode}-before`);
    if (mode === 'completed') {
      const replay = await call('async-idempotent-retry', 'generateBooking', input, 202);
      assert(replay.jobId === accepted.jobId, 'IDEMPOTENT_JOB', mode);
    }
    const pollInput = { jobId: accepted.jobId, waitForResultMs: 0 };
    const pending = await call(`async-${mode}-pending`, 'getBackstageBookerJobResult', pollInput);
    assert(pending.status === 'pending' && pending.jobId === accepted.jobId, 'PENDING_JOB', mode);
    const terminal = await call(`async-${mode}-terminal`, 'getBackstageBookerJobResult', pollInput);
    assert(terminal.jobStatus === mode && terminal.jobId === accepted.jobId, 'TERMINAL_JOB', mode);
    if (mode === 'completed') assert(terminal.result?.result?.protectedGeneration?.official === true, 'JOB_PROVENANCE', mode);
    else assert(terminal.result === null && terminal.official !== true, 'PROTECTED_JOB_FAILURE', mode);
    const after = await evidence(`async-${mode}-after`);
    assert(after.syntheticExecutions === before.syntheticExecutions && after.totalJobs === before.totalJobs, 'POLLING_NO_INFERENCE', mode);
  }
  await request('malformed-json', { body: '{', raw: true, status: 400 });
  await request('unsupported-charset', { body: '{}', raw: true, headers: { 'Content-Type': 'application/json; charset=utf-16' }, status: 415 });
  await request('oversized-json', { body: '{}'.padEnd(262_145, ' '), raw: true, status: 413 });
  await request('foreign-origin', { body: rpc('tools/list'), headers: { Origin: 'https://unauthorized.invalid' }, status: 403, authenticated: false });
  await request('cookie-carrier-denied', { body: rpc('tools/list'), headers: { Cookie: 'synthetic=invalid' }, status: 404, deny: true, authenticated: false });
  await request('streaming-denied', { method: 'GET', status: 405 });
  for (const route of [path, metadataPath, evidencePath]) await request(`worker-denial-${route}`, { role: 'worker', route,
    method: 'GET', token: null, status: 404, deny: true, authenticated: false });
  const finalEvidence = await evidence('effects-final');
  assert(finalEvidence.totalJobs === 3 && finalEvidence.terminalJobs === 3 && finalEvidence.pendingJobs === 0, 'JOBS_RECONCILED', 'effects-final');
  const tutor = await request('tutor-regression', { route: '/chatgpt/mcp', token: null, authenticated: false,
    body: rpc('tools/call', { name: 'arcanos_tutor', arguments: { prompt: 'Sealed Tutor preview: explain one half.' } }) });
  assert(tutor?.result?.structuredContent?.answer === 'Synthetic Tutor preview: one half is one of two equal parts.', 'TUTOR_REGRESSION', 'tutor-regression');
  const gaming = await request('gaming-regression', { route: '/chatgpt/gaming/mcp', token: null, authenticated: false, body: rpc('tools/list') });
  assert(gaming?.result?.tools?.length === 8 && !gaming.result.tools.some(tool => tools.includes(tool.name)), 'GAMING_REGRESSION', 'gaming-regression');
  for (const role of ['web', 'worker']) await request(`${role}-ready-final`, { role, route: '/readyz', method: 'GET', token: null, authenticated: false });
  return { kind: 'booker_mcp_synthetic_preview', executed: true, networkAttempted: true, target, limits, checks,
    effectEvidence: finalEvidence, evidenceScope: 'Actual shared MCP transport and unchanged signed verifier with deterministic services and process-local jobs. No real Auth0 grant, provider, Notion, SQL, active worker, production or installed ChatGPT proof.',
    summary: { status: 'PASS', code: 'BOOKER_MCP_SYNTHETIC_ACCEPTANCE_PASS', requestsMade: checks.length, totalResponseBytes: aggregateBytes } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runBookerMcpPreviewE2e({ args: process.argv.slice(2) }), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'BOOKER_PREVIEW_FAILED'); process.exitCode = 1; }
}
