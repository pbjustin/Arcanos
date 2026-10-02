import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { InitializeResultSchema, ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';
import { gamingMcpTools } from '../src/shared/chatgpt/gamingMcpContract.js';
const actualMigration = await import('../src/shared/chatgpt/pluginMigrationPreviewFixture.js');
const migrationAssertion = jest.fn(actualMigration.assertPluginMigrationPreviewFixture);
jest.unstable_mockModule('../src/shared/chatgpt/pluginMigrationPreviewFixture.js', () => ({ assertPluginMigrationPreviewFixture: migrationAssertion }));
const actualComposition = await import('../src/shared/chatgpt/gamingCompositionPreviewFixture.js');
const compositionAssertion = jest.fn(actualComposition.assertGamingCompositionPreviewFixture);
jest.unstable_mockModule('../src/shared/chatgpt/gamingCompositionPreviewFixture.js', () => ({ assertGamingCompositionPreviewFixture: compositionAssertion }));
const { handleGamingMcpPreviewRequest: handle, assertGamingMcpPreviewFixture } = await import('../src/shared/chatgpt/gamingMcpPreviewFixture.js');
const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptGaming;
const request = (method: string, params: unknown = {}, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, params });
const call = (name = 'arcanos_gaming_query', args: unknown = contract.queryInput) => request('tools/call', { name, arguments: args });
beforeEach(() => {
  migrationAssertion.mockReset().mockImplementation(actualMigration.assertPluginMigrationPreviewFixture);
  compositionAssertion.mockReset().mockImplementation(actualComposition.assertGamingCompositionPreviewFixture);
});

describe('sealed Gaming MCP protocol and production pure-core fixture', () => {
  it('executes Gaming schema/count/authority/confirmation assertions and the shared migration core', () => {
    expect(assertGamingMcpPreviewFixture).not.toThrow();
    expect(migrationAssertion).toHaveBeenCalledTimes(1);
    expect(compositionAssertion).toHaveBeenCalledTimes(1);
  });
  it('initializes with explicit synthetic limits and lists exactly the canonical Gaming catalog', () => {
    const initialized = handle(request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }));
    const result = InitializeResultSchema.parse(initialized.payload?.result);
    expect(result.serverInfo.name).toBe('arcanos-gaming-sealed-preview');
    expect(result.instructions).toContain('No OAuth');
    const listed = handle(request('tools/list'));
    const catalog = ListToolsResultSchema.parse(listed.payload?.result);
    expect(catalog.tools).toHaveLength(8);
    expect(listed.payload?.result).toEqual({ tools: gamingMcpTools });
    expect(createHash('sha256').update(JSON.stringify(gamingMcpTools)).digest('hex')).toBe(contract.catalogSha256);
    expect(initialized.gamingVerified).toBeUndefined();
    expect(listed.gamingVerified).toBeUndefined();
    expect(listed.migrationVerified).toBeUndefined();
  });
  it.each([
    ['arcanos_gaming_query', contract.queryInput, contract.queryOutput],
    ['arcanos_gaming_hybrid_query', contract.hybridInput, contract.hybridOutput],
  ] as const)('returns only fixed synthetic output with success-only evidence for %s', (name, input, output) => {
    const response = handle(call(name, input));
    expect(response).toMatchObject({ statusCode: 200, gamingVerified: true, migrationVerified: true, compositionVerified: true });
    expect(CallToolResultSchema.parse(response.payload?.result)).toEqual({ structuredContent: output,
      content: [{ type: 'text', text: JSON.stringify(output) }] });
  });
  it.each(['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates'])
  ('denies %s even with confirmation because the sealed peer has no OAuth write grant', name => {
    for (const confirmStore of [true, false]) {
      const response = handle(call(name, { confirmStore, storagePolicy: 'ask_before_store' }));
      expect(response.payload?.result).toEqual({ isError: true, content: [{ type: 'text', text: 'GAMING_PREVIEW_WRITE_UNAUTHORIZED' }] });
      expect(response.gamingVerified).toBeUndefined();
      expect(response.migrationVerified).toBeUndefined();
    }
  });
  it.each(['arcanos_tutor', 'modules.invoke', 'jobs.get', 'memory.search', 'backstage_booker', 'database.inspect', 'railway.admin'])
  ('denies cross-family tool %s', name => {
    expect(handle(call(name)).payload?.result).toEqual({ isError: true, content: [{ type: 'text', text: 'GAMING_PREVIEW_TOOL_UNAVAILABLE' }] });
  });
  it.each(['callerRole', 'actorKey', 'bearerToken', 'scopes', 'host', 'module'])('denies authority field %s', field => {
    const response = handle(call('arcanos_gaming_query', { ...contract.queryInput, [field]: 'synthetic-forbidden' }));
    expect(response.payload?.result).toEqual({ isError: true, content: [{ type: 'text', text: 'GAMING_PREVIEW_INPUT_UNSUPPORTED' }] });
    expect(response.gamingVerified).toBeUndefined();
  });
  it('withholds success output and every evidence flag if the shared migration assertion fails', () => {
    migrationAssertion.mockImplementation(() => { throw new Error('synthetic mutation'); });
    const response = handle(call());
    expect(response.statusCode).toBe(500);
    expect(response.payload?.error).toEqual({ code: -32603, message: 'GAMING_PREVIEW_ASSERTION_FAILED' });
    expect(response.payload?.result).toBeUndefined();
    expect(response.gamingVerified).toBeUndefined();
    expect(response.migrationVerified).toBeUndefined();
  });
  it('withholds every success marker and body when a Gaming annotation assertion fails', () => {
    const prior = gamingMcpTools[0].annotations.readOnlyHint;
    gamingMcpTools[0].annotations.readOnlyHint = !prior;
    try {
      const response = handle(call());
      expect(response.statusCode).toBe(500);
      expect(response.payload?.result).toBeUndefined();
      expect(response.gamingVerified).toBeUndefined();
      expect(response.migrationVerified).toBeUndefined();
      expect(migrationAssertion).not.toHaveBeenCalled();
    } finally { gamingMcpTools[0].annotations.readOnlyHint = prior; }
  });
  it.each([
    ['arcanos_gaming_query', contract.queryInput],
    ['arcanos_gaming_hybrid_query', contract.hybridInput],
  ] as const)('withholds every success flag and output when instruction composition fails for %s', (name, input) => {
    compositionAssertion.mockImplementation(() => { throw new Error('synthetic private detail'); });
    const response = handle(call(name, input));
    expect(response).toEqual({ statusCode: 500, payload: { jsonrpc: '2.0', id: 1,
      error: { code: -32603, message: 'GAMING_PREVIEW_ASSERTION_FAILED' } } });
  });
  it.each([null, [], { jsonrpc: '2.0', method: 'tools/list', id: {} }, [call()], { ...call(), authority: 'operator' }])
  ('rejects malformed JSON-RPC envelope %#', body => {
    expect(handle(body)).toMatchObject({ statusCode: 400, payload: { error: { code: -32600 } } });
  });
});
