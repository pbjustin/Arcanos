#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseNativePrPreviewE2eArguments, expectedNativePrPreviewResponseBody } from './native-pr-preview-e2e.mjs';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from './native-pr-preview-contract.mjs';

const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptGaming;
const migration = NATIVE_PR_PREVIEW_E2E_CONTRACT.pluginMigration;
const hash = value => createHash('sha256').update(value).digest('hex');
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 'gaming-preview', method, params });
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const assert = (condition, code, id) => { if (!condition) throw new Error(`${code}:${id}`); };
const sourceWrite = { game: contract.game, sourceUrls: ['https://example.com/synthetic-guide'],
  idempotencyKey: 'gaming-preview-write', storagePolicy: 'ask_before_store', confirmStore: true };

export function buildGamingMcpPreviewRequestPlan() {
  const request = (id, body, extra = {}) => ({ id, body, method: 'POST', path: contract.path, role: 'web', status: 200, ...extra });
  return [
    ...['web', 'worker'].map(role => request(`${role}-ready`, undefined, { method: 'GET', path: '/readyz', role })),
    request('initialize', rpc('initialize', { protocolVersion: contract.protocolVersion, capabilities: {},
      clientInfo: { name: 'sealed-gaming-verifier', version: '1.0.0' } })),
    request('initialized', { jsonrpc: '2.0', method: 'notifications/initialized' }, { status: 202 }),
    request('catalog', rpc('tools/list')),
    request('query', call('arcanos_gaming_query', contract.queryInput), { proof: true }),
    request('hybrid', call('arcanos_gaming_hybrid_query', contract.hybridInput), { proof: true }),
    request('unknown-tool', call('modules.invoke', {}), { error: 'GAMING_PREVIEW_TOOL_UNAVAILABLE' }),
    request('authority-input', call('arcanos_gaming_query', { ...contract.queryInput, callerRole: 'operator' }), { error: 'GAMING_PREVIEW_INPUT_UNSUPPORTED' }),
    request('candidate-bound', call('arcanos_gaming_submit_candidates', { contractVersion: 'gaming-hybrid-v1', workflowId: contract.workflowId,
      idempotencyKey: 'gaming-preview-candidates', candidates: Array.from({ length: 4 }, (_, index) => ({ url: `https://example.com/${index}` })) }),
    { error: 'GAMING_PREVIEW_INPUT_UNSUPPORTED' }),
    ...['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates']
      .map(name => request(name, call(name, name === 'arcanos_gaming_ingest_sources' ? sourceWrite
        : name === 'arcanos_gaming_refresh_sources' ? { sourceIds: [contract.workflowId], idempotencyKey: 'gaming-preview-refresh', storagePolicy: 'ask_before_store', confirmStore: true }
          : { workflowId: contract.workflowId, contractVersion: 'gaming-hybrid-v1', candidateIds: [contract.workflowId], idempotencyKey: 'gaming-preview-store', storagePolicy: 'ask_before_store', confirmStore: true }),
      { error: 'GAMING_PREVIEW_WRITE_UNAUTHORIZED' })),
    request('missing-confirmation', call('arcanos_gaming_ingest_sources', { ...sourceWrite, confirmStore: false }), { error: 'GAMING_PREVIEW_WRITE_UNAUTHORIZED' }),
    request('authorization', call('arcanos_gaming_query', contract.queryInput), { status: 404, denied: true, headers: { authorization: 'Bearer test-synthetic-invalid-preview' } }),
    request('cookie', call('arcanos_gaming_query', contract.queryInput), { status: 404, denied: true, headers: { cookie: 'synthetic_preview=invalid' } }),
    request('malformed', '{', { status: 400, raw: true }),
    request('oversized', JSON.stringify(call('arcanos_gaming_query', contract.queryInput)).padEnd(4_097, ' '), { status: 404, denied: true, raw: true }),
    request('worker-denial', call('arcanos_gaming_query', contract.queryInput), { role: 'worker', status: 404, denied: true }),
    ...['web', 'worker'].map(role => request(`${role}-metadata-denial`, undefined, { method: 'GET', path: contract.metadataPath, role, status: 404, denied: true })),
  ];
}

export async function runGamingMcpPreviewE2e({ args = [], localGitState, fetchImpl = globalThis.fetch } = {}) {
  // Reuse the maintained canonical-repository, clean exact-head and isolated HTTPS-origin guards.
  const options = parseNativePrPreviewE2eArguments(args, localGitState === undefined ? {} : { localGitState });
  const plan = buildGamingMcpPreviewRequestPlan();
  const target = { repository: options.repository, prNumber: options.prNumber, commitSha: options.commitSha,
    webHost: new URL(options.webBaseUrl).hostname, workerHost: new URL(options.workerBaseUrl).hostname };
  const limits = { maxRequests: plan.length, maxResponseBytes: Math.min(options.maxResponseBytes, 65_536), maxAggregateResponseBytes: 128 * 1_024,
    requestTimeoutMs: Math.min(options.requestTimeoutMs, 5_000), totalTimeoutMs: Math.min(options.totalTimeoutMs, 60_000) };
  if (!options.execute) return { kind: 'gaming_mcp_sealed_preview', executed: false, networkAttempted: false, target, limits,
    checks: [], summary: { status: 'PASS', code: 'EXACT_HEAD_TARGETS_VALIDATED_NO_NETWORK' } };
  const deadline = Date.now() + limits.totalTimeoutMs;
  const checks = [];
  let totalBytes = 0;
  for (const item of plan) {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'GAMING_PREVIEW_TOTAL_TIMEOUT', item.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, limits.requestTimeoutMs));
    try {
      const response = await fetchImpl((item.role === 'web' ? options.webBaseUrl : options.workerBaseUrl) + item.path, {
        method: item.method, redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json, text/event-stream', ...(item.method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...item.headers },
        ...(item.body === undefined ? {} : { body: item.raw ? item.body : JSON.stringify(item.body) }),
      });
      assert(response.status === item.status, 'GAMING_PREVIEW_HTTP_STATUS', item.id);
      assert(!response.headers.has('set-cookie') && !response.headers.has('mcp-session-id'), 'GAMING_PREVIEW_STATE_HEADER', item.id);
      const chunks = []; let length = 0;
      if (response.body) for await (const chunk of response.body) {
        length += chunk.byteLength; totalBytes += chunk.byteLength;
        assert(length <= limits.maxResponseBytes && totalBytes <= limits.maxAggregateResponseBytes, 'GAMING_PREVIEW_RESPONSE_BOUND', item.id);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('utf8');
      for (const [name, version] of [[contract.proofHeader, contract.proofVersion], [migration.proofHeader, migration.proofVersion]])
        assert(item.proof ? response.headers.get(name) === version : !response.headers.has(name), 'GAMING_PREVIEW_SUCCESS_PROOF', item.id);
      assert(!response.headers.has(NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptTutor.honestyProofHeader), 'GAMING_PREVIEW_CROSS_FAMILY_PROOF', item.id);
      if (item.denied) assert(text === 'not found', 'GAMING_PREVIEW_DENIAL_BODY', item.id);
      else if (item.id === 'initialized') assert(text === '', 'GAMING_PREVIEW_NOTIFICATION_BODY', item.id);
      else {
        const body = JSON.parse(text);
        if (item.path === '/readyz') assert(isDeepStrictEqual(body, expectedNativePrPreviewResponseBody({ expectedType: `${item.role}-readiness` }, options)), 'GAMING_PREVIEW_EXACT_ROLE_IDENTITY', item.id);
        else {
          assert(response.headers.get(NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name) === 'sealed-synthetic', 'GAMING_PREVIEW_SYNTHETIC_MARKER', item.id);
          assert(response.headers.get('cache-control')?.includes('no-store'), 'GAMING_PREVIEW_NO_STORE', item.id);
          if (item.id === 'malformed') assert(isDeepStrictEqual(body, { error: 'PREVIEW_REQUEST_INVALID' }), 'GAMING_PREVIEW_MALFORMED_BODY', item.id);
          else {
            assert(body.jsonrpc === '2.0' && body.id === 'gaming-preview', 'GAMING_PREVIEW_RPC_ENVELOPE', item.id);
            if (item.id === 'initialize') assert(isDeepStrictEqual(body.result, { protocolVersion: contract.protocolVersion, capabilities: { tools: {} },
              serverInfo: { name: 'arcanos-gaming-sealed-preview', version: '1.0.0' }, instructions: contract.instructions }), 'GAMING_PREVIEW_INITIALIZE', item.id);
            else if (item.id === 'catalog') assert(hash(JSON.stringify(body.result?.tools)) === contract.catalogSha256, 'GAMING_PREVIEW_EXACT_CATALOG', item.id);
            else if (item.proof) {
              const output = item.id === 'query' ? contract.queryOutput : contract.hybridOutput;
              assert(isDeepStrictEqual(body.result, { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] }), 'GAMING_PREVIEW_SYNTHETIC_OUTPUT', item.id);
            } else assert(isDeepStrictEqual(body.result, { isError: true, content: [{ type: 'text', text: item.error }] }), 'GAMING_PREVIEW_TOOL_DENIAL', item.id);
          }
        }
      }
      checks.push({ caseId: item.id, httpStatus: response.status, role: item.role, responseBytes: length, bodySha256: hash(bytes),
        ...(item.proof ? { gamingMcpCoreVerified: true, pluginMigrationPackageCoreVerified: true } : {}) });
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return { kind: 'gaming_mcp_sealed_preview', executed: true, networkAttempted: true, target, limits, checks,
    evidenceScope: 'Credential-free served schemas, catalog, synthetic protocol and write-policy components. No OAuth, production service, provider, database or source storage proof.',
    summary: { status: 'PASS', code: 'GAMING_MCP_SEALED_PREVIEW_PASS', requestsMade: checks.length, totalResponseBytes: totalBytes } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runGamingMcpPreviewE2e({ args: process.argv.slice(2) }), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'GAMING_PREVIEW_FAILED'); process.exitCode = 1; }
}
