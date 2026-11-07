import { Ajv } from 'ajv';
import { CHATGPT_GAMING_TOOL_NAMES, chatGptGamingSchemas, type ChatGptGamingToolName } from '@arcanos/protocol/chatgptGaming';

export const GAMING_QUERY_SCOPE = 'arcanos:gaming:query';
export const GAMING_WRITE_SCOPE = 'arcanos:gaming:sources:write';
export const GAMING_MCP_PATH = '/chatgpt/gaming/mcp';
export const GAMING_METADATA_PATH = '/.well-known/oauth-protected-resource/chatgpt/gaming/mcp';
const writes = new Set<ChatGptGamingToolName>(['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates']);
const descriptions: Record<ChatGptGamingToolName, string> = {
  arcanos_gaming_query: 'Gaming guidance with progress/spoiler limits. May use providers/sources. Saves nothing.',
  arcanos_gaming_canary: 'Synthetic fixture; no providers/infrastructure/live proof.',
  arcanos_gaming_hybrid_query: 'Bounded owner workflow; released gaming-hybrid-v2, explicit v1 supported. V2 clarify: original query + resolved context, workflowId, expectedRevision, new key. Keeps evidence/budgets. Follow state/nextAction/freshness/provenance. No storage.',
  arcanos_gaming_submit_candidates: 'Acquire 1-3 public URLs/granted owner submission. Hints untrusted. V2 recovery: expectedRevision; v1 one round. May generate; no storage.',
  arcanos_gaming_ingestion_status: 'Owner ingestion outcomes; at most 3 polls. Excludes legacy Action jobs.',
  arcanos_gaming_ingest_sources: 'Store 1-4 explicit public URLs: write scope, storagePolicy, confirmStore=true, stable key. Poll status.',
  arcanos_gaming_refresh_sources: 'Refresh 1-4 owner revisions: write scope, storagePolicy, confirmStore=true, stable key.',
  arcanos_gaming_ingest_candidates: 'Store owned IDs: write scope, matching policy, confirmStore=true, stable key. Recheck approval. References require ask_before_store.',
};
const ajv = new Ajv({ allErrors: false, strict: true });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
ajv.addFormat('date-time', { type: 'string', validate: value => /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value)) });
ajv.addFormat('uri', { type: 'string', validate: value => { try { new URL(value); return true; } catch { return false; } } });
const validators = Object.fromEntries(CHATGPT_GAMING_TOOL_NAMES.map(name => [name, {
  input: ajv.compile(chatGptGamingSchemas[name].input), output: ajv.compile(chatGptGamingSchemas[name].output),
}])) as Record<ChatGptGamingToolName, { input: ReturnType<typeof ajv.compile>; output: ReturnType<typeof ajv.compile> }>;
export const isGamingMcpToolName = (name: string): name is ChatGptGamingToolName => CHATGPT_GAMING_TOOL_NAMES.includes(name as ChatGptGamingToolName);
export const isGamingMcpWrite = (name: ChatGptGamingToolName): boolean => writes.has(name);
export const isGamingMcpInput = (name: ChatGptGamingToolName, value: unknown): value is Record<string, unknown> => validators[name].input(value) === true;
export const isGamingMcpOutput = (name: ChatGptGamingToolName, value: unknown): boolean => validators[name].output(value) === true;

export const gamingMcpTools = CHATGPT_GAMING_TOOL_NAMES.map(name => {
  const write = isGamingMcpWrite(name);
  const securitySchemes = [{ type: 'oauth2', scopes: write ? [GAMING_QUERY_SCOPE, GAMING_WRITE_SCOPE] : [GAMING_QUERY_SCOPE] }];
  return { name, title: name.replaceAll('_', ' '), description: descriptions[name],
    inputSchema: chatGptGamingSchemas[name].input, outputSchema: chatGptGamingSchemas[name].output,
    securitySchemes, _meta: { securitySchemes },
    annotations: { readOnlyHint: !write && !['arcanos_gaming_hybrid_query', 'arcanos_gaming_submit_candidates'].includes(name), destructiveHint: write,
      openWorldHint: !['arcanos_gaming_canary', 'arcanos_gaming_ingestion_status'].includes(name),
      idempotentHint: !['arcanos_gaming_query', 'arcanos_gaming_hybrid_query', 'arcanos_gaming_submit_candidates'].includes(name) },
  };
});

/** Confirmation is separate from OAuth authority. The service still validates accepted sources. */
export function gamingMcpWritePolicyError(input: Record<string, unknown>, canAutoStore: boolean): string | undefined {
  if (input.confirmStore !== true) return 'GAMING_CONFIRMATION_REQUIRED';
  if (input.storagePolicy === 'transient_only') return 'GAMING_STORAGE_POLICY_DENIED';
  if (input.storagePolicy === 'auto_store_approved' && !canAutoStore) return 'GAMING_AUTO_STORAGE_FORBIDDEN';
  if (!['ask_before_store', 'auto_store_approved'].includes(String(input.storagePolicy))) return 'GAMING_STORAGE_POLICY_DENIED';
  return undefined;
}
