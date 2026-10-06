// eslint-disable-next-line no-restricted-imports -- Fixed public synthetic contract; no production execution graph.
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../../../scripts/native-pr-preview-contract.mjs';
import { assertPluginMigrationPreviewFixture } from './pluginMigrationPreviewFixture.js';
import { assertGamingCompositionPreviewFixture } from './gamingCompositionPreviewFixture.js';
import {
  gamingMcpTools, gamingMcpWritePolicyError, isGamingMcpInput, isGamingMcpOutput,
  isGamingMcpToolName, isGamingMcpWrite, GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE,
} from './gamingMcpContract.js';

const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptGaming;
const expectedNames = [
  'arcanos_gaming_query', 'arcanos_gaming_canary', 'arcanos_gaming_hybrid_query',
  'arcanos_gaming_submit_candidates', 'arcanos_gaming_ingestion_status',
  'arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates',
];
const FAILURE = 'GAMING_PREVIEW_ASSERTION_FAILED';
type RequestId = string | number;
export interface GamingMcpPreviewResponse {
  statusCode: number;
  payload?: Record<string, unknown>;
  /** Success-only component evidence; never part of the tool output. */
  gamingVerified?: true;
  migrationVerified?: true;
  compositionVerified?: true;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const validId = (value: unknown): value is RequestId => typeof value === 'number'
  ? Number.isSafeInteger(value) : typeof value === 'string' && /^[\x21-\x7e]{1,64}$/u.test(value);
const validMeta = (value: Record<string, unknown>): boolean => !Object.hasOwn(value, '_meta') || isRecord(value._meta);
const empty = (value: unknown): boolean => value === undefined || isRecord(value) && only(value, ['_meta']) && validMeta(value);
const rpcResult = (id: RequestId, result: Record<string, unknown>): GamingMcpPreviewResponse =>
  ({ statusCode: 200, payload: { jsonrpc: '2.0', id, result } });
const rpcError = (id: RequestId | null, code: number, message: string, statusCode = 200): GamingMcpPreviewResponse =>
  ({ statusCode, payload: { jsonrpc: '2.0', id, error: { code, message } } });
const toolError = (id: RequestId, text: string): GamingMcpPreviewResponse =>
  rpcResult(id, { isError: true, content: [{ type: 'text', text }] });
function requireProof(value: unknown): asserts value { if (!value) throw new Error(FAILURE); }

/** Production schema/catalog/write-policy cores only; no OAuth, provider, network, queue, or database. */
export function assertGamingMcpPreviewFixture(): void {
  requireProof(JSON.stringify(gamingMcpTools.map(tool => tool.name)) === JSON.stringify(expectedNames));
  requireProof(gamingMcpTools.filter(tool => isGamingMcpWrite(tool.name)).length === 3);
  // Exact reviewed catalog size; the unchanged HTTP/verifier cap remains 65,536 bytes.
  requireProof(Buffer.byteLength(JSON.stringify(gamingMcpTools), 'utf8') === 65_103);
  for (const tool of gamingMcpTools) {
    const write = isGamingMcpWrite(tool.name);
    requireProof(tool.inputSchema.type === 'object' && tool.outputSchema.type === 'object');
    requireProof(tool.inputSchema.additionalProperties === false);
    const stateful = write || ['arcanos_gaming_hybrid_query', 'arcanos_gaming_submit_candidates'].includes(tool.name);
    requireProof(tool.annotations.readOnlyHint === !stateful);
    requireProof(tool.annotations.destructiveHint === write);
    requireProof(JSON.stringify(tool.securitySchemes) === JSON.stringify([
      { type: 'oauth2', scopes: write ? [GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE] : [GAMING_QUERY_SCOPE] },
    ]));
    requireProof(!isGamingMcpInput(tool.name, { bearerToken: 'test-synthetic-invalid', callerRole: 'operator' }));
  }
  requireProof(isGamingMcpInput('arcanos_gaming_query', contract.queryInput));
  requireProof(isGamingMcpOutput('arcanos_gaming_query', contract.queryOutput));
  requireProof(isGamingMcpInput('arcanos_gaming_hybrid_query', contract.hybridInput));
  requireProof(isGamingMcpOutput('arcanos_gaming_hybrid_query', contract.hybridOutput));
  const sources = { game: contract.game, sourceUrls: ['https://example.com/synthetic-guide'],
    idempotencyKey: 'gaming-preview-write', storagePolicy: 'ask_before_store', confirmStore: true };
  requireProof(isGamingMcpInput('arcanos_gaming_ingest_sources', sources));
  requireProof(!isGamingMcpInput('arcanos_gaming_ingest_sources', { ...sources,
    sourceUrls: Array.from({ length: 5 }, (_, index) => `https://example.com/synthetic-${index}`) }));
  requireProof(!isGamingMcpInput('arcanos_gaming_ingest_sources', { ...sources, confirmStore: false }));
  requireProof(!isGamingMcpInput('arcanos_gaming_ingest_sources', { ...sources, sourceUrls: ['http://example.com/guide'] }));
  const candidates = { contractVersion: 'gaming-hybrid-v1', workflowId: contract.workflowId,
    idempotencyKey: 'gaming-preview-candidates', candidates: [{ url: 'https://example.com/synthetic-guide' }] };
  requireProof(isGamingMcpInput('arcanos_gaming_submit_candidates', candidates));
  requireProof(!isGamingMcpInput('arcanos_gaming_submit_candidates', { ...candidates,
    candidates: Array.from({ length: 4 }, (_, index) => ({ url: `https://example.com/synthetic-${index}` })) }));
  requireProof(!isGamingMcpInput('arcanos_gaming_submit_candidates', { ...candidates, actorKey: 'operator' }));
  requireProof(gamingMcpWritePolicyError({ ...sources, confirmStore: false }, false) === 'GAMING_CONFIRMATION_REQUIRED');
  requireProof(gamingMcpWritePolicyError({ ...sources, storagePolicy: 'transient_only' }, false) === 'GAMING_STORAGE_POLICY_DENIED');
  requireProof(gamingMcpWritePolicyError({ ...sources, storagePolicy: 'auto_store_approved' }, false) === 'GAMING_AUTO_STORAGE_FORBIDDEN');
  assertPluginMigrationPreviewFixture();
  assertGamingCompositionPreviewFixture();
}

/** Finite stateless synthetic peer. Credentials are rejected before this function by the HTTP boundary. */
export function handleGamingMcpPreviewRequest(body: unknown): GamingMcpPreviewResponse {
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
    || !only(body, ['jsonrpc', 'id', 'method', 'params']))
    return rpcError(null, -32600, 'Invalid sealed Gaming preview request.', 400);
  if (body.method === 'notifications/initialized') return !Object.hasOwn(body, 'id') && empty(body.params)
    ? { statusCode: 202 } : rpcError(null, -32600, 'Invalid sealed Gaming preview request.', 400);
  if (!validId(body.id)) return rpcError(null, -32600, 'Invalid sealed Gaming preview request.', 400);
  const id = body.id;
  const params = body.params;
  if (body.method === 'initialize') {
    if (!isRecord(params) || !only(params, ['protocolVersion', 'capabilities', 'clientInfo', '_meta']) || !validMeta(params)
      || typeof params.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(params.protocolVersion)
      || !isRecord(params.capabilities) || !isRecord(params.clientInfo)
      || !['name', 'version'].every(key => typeof params.clientInfo === 'object'
        && typeof (params.clientInfo as Record<string, unknown>)[key] === 'string'
        && String((params.clientInfo as Record<string, unknown>)[key]).length >= 1
        && String((params.clientInfo as Record<string, unknown>)[key]).length <= 128))
      return rpcError(id, -32602, 'Invalid sealed Gaming preview parameters.');
    return rpcResult(id, { protocolVersion: contract.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'arcanos-gaming-sealed-preview', version: '1.0.0' }, instructions: contract.instructions });
  }
  if (body.method === 'ping') return empty(params) ? rpcResult(id, {}) : rpcError(id, -32602, 'Invalid sealed Gaming preview parameters.');
  if (body.method === 'tools/list') return empty(params) ? rpcResult(id, { tools: gamingMcpTools })
    : rpcError(id, -32602, 'Invalid sealed Gaming preview parameters.');
  if (body.method !== 'tools/call') return rpcError(id, -32601, 'Sealed Gaming preview method unavailable.');
  if (!isRecord(params) || !only(params, ['name', 'arguments', '_meta']) || !validMeta(params) || typeof params.name !== 'string')
    return rpcError(id, -32602, 'Invalid sealed Gaming preview parameters.');
  if (!isGamingMcpToolName(params.name)) return toolError(id, 'GAMING_PREVIEW_TOOL_UNAVAILABLE');
  // The sealed peer has no principal or write grant, including when confirmation is supplied.
  if (isGamingMcpWrite(params.name)) return toolError(id, 'GAMING_PREVIEW_WRITE_UNAUTHORIZED');
  if (!isGamingMcpInput(params.name, params.arguments)) return toolError(id, 'GAMING_PREVIEW_INPUT_UNSUPPORTED');
  const argumentsValue = params.arguments;
  const isQuery = params.name === 'arcanos_gaming_query';
  const isHybrid = params.name === 'arcanos_gaming_hybrid_query';
  const expected = isQuery ? contract.queryInput : isHybrid ? contract.hybridInput : undefined;
  if (!expected || Object.keys(argumentsValue).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => argumentsValue[key] !== value))
    return toolError(id, 'GAMING_PREVIEW_INPUT_UNSUPPORTED');
  try { assertGamingMcpPreviewFixture(); } catch { return rpcError(id, -32603, FAILURE, 500); }
  const output = isQuery ? contract.queryOutput : contract.hybridOutput;
  return { ...rpcResult(id, { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] }),
    gamingVerified: true, migrationVerified: true, compositionVerified: true };
}
