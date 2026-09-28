import { readFileSync } from 'node:fs';
import { chatGptGamingSchemas, CHATGPT_GAMING_TOOL_NAMES } from '@arcanos/protocol/chatgptGaming';
import { isGamingMcpInput, gamingMcpTools } from '../src/shared/chatgpt/gamingMcpContract.js';

const openapi = JSON.parse(readFileSync(new URL('../contracts/arcanos_gaming.openapi.v1.json', import.meta.url), 'utf8'));
const contract = JSON.parse(readFileSync(new URL('../packages/protocol/schemas/v1/tools/arcanos-gaming.schema.json', import.meta.url), 'utf8'));
describe('Gaming MCP contracts preserve the service contract', () => {
  it('keeps shared source definitions equal to Action 1.5.0, with local schema references', () => {
    expect(openapi.info.version).toBe('1.5.0');
    for (const [name, schema] of Object.entries(contract.$defs)) {
      if (name.startsWith('Mcp')) continue;
      expect(schema).toEqual(JSON.parse(JSON.stringify(openapi.components.schemas[name]).replaceAll('#/components/schemas/', '#/$defs/')));
    }
  });
  it('exposes exactly the requested fixed names, with no runtime selector inputs', () => {
    expect(CHATGPT_GAMING_TOOL_NAMES).toEqual(['arcanos_gaming_query', 'arcanos_gaming_canary', 'arcanos_gaming_hybrid_query',
      'arcanos_gaming_submit_candidates', 'arcanos_gaming_ingestion_status', 'arcanos_gaming_ingest_sources',
      'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates']);
    for (const name of CHATGPT_GAMING_TOOL_NAMES) {
      expect(chatGptGamingSchemas[name].input.additionalProperties).toBe(false);
      expect(chatGptGamingSchemas[name].output.additionalProperties).toBe(false);
      expect(JSON.stringify(chatGptGamingSchemas[name])).not.toContain('#/components/');
    }
  });
  it('permits gameplay role context while rejecting authority, module, host and token injection', () => {
    const input = { mode: 'build', prompt: 'Build for this class', game: 'Fixture Game', role: 'healer' };
    expect(isGamingMcpInput('arcanos_gaming_query', input)).toBe(true);
    for (const key of ['callerRole', 'scope', 'scopes', 'actorKey', 'bearerToken', 'backendHost', 'module', 'sessionId']) {
      expect(isGamingMcpInput('arcanos_gaming_query', { ...input, [key]: 'untrusted' })).toBe(false);
    }
  });
  it('requires affirmative consent and idempotency for every durable tool', () => {
    for (const name of ['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates'] as const) {
      const schema = chatGptGamingSchemas[name].input;
      expect(schema.required).toEqual(expect.arrayContaining(['idempotencyKey', 'storagePolicy', 'confirmStore']));
      expect((schema.properties as Record<string, unknown>).confirmStore).toEqual({ type: 'boolean', const: true });
    }
  });
  it('keeps catalog bounded and distinct from private instructions or registration', () => {
    expect(Buffer.byteLength(JSON.stringify(gamingMcpTools))).toBeLessThan(65_536);
    expect(JSON.stringify(gamingMcpTools)).not.toMatch(/asdk_app_|ARCANOS_GAMING_SOURCE_ACCESS_TOKEN|arcanos:tutor/u);
  });
});
