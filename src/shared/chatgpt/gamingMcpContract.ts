import { Ajv } from 'ajv';
import { CHATGPT_GAMING_TOOL_NAMES, chatGptGamingSchemas, type ChatGptGamingToolName } from '@arcanos/protocol/chatgptGaming';

export const GAMING_QUERY_SCOPE = 'arcanos:gaming:query';
export const GAMING_WRITE_SCOPE = 'arcanos:gaming:sources:write';
export const GAMING_MCP_PATH = '/chatgpt/gaming/mcp';
export const GAMING_METADATA_PATH = '/.well-known/oauth-protected-resource/chatgpt/gaming/mcp';
const writes = new Set<ChatGptGamingToolName>(['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates']);
const descriptions: Record<ChatGptGamingToolName, string> = {
  arcanos_gaming_query: 'Ask ARCANOS for gameplay guide, build or meta guidance with player progress and spoiler constraints. May use providers and bounded public sources. Does not save sources or player progress.',
  arcanos_gaming_canary: 'Check the fixed public Gaming pipeline fixture. Does not call providers or inspect infrastructure; success does not prove live generation or storage.',
  arcanos_gaming_hybrid_query: 'Query stored Gaming evidence and start a bounded, temporary owner workflow. Preserve state, nextAction, freshness and provenance. No durable source storage.',
  arcanos_gaming_submit_candidates: 'Evaluate up to three candidate public source URLs within the same owned workflow. May fetch sources and generate a grounded answer. Retains temporary evidence only; never stores sources durably.',
  arcanos_gaming_ingestion_status: 'Read the sanitized status and per-source outcomes for this OAuth owner\'s Gaming ingestion. At most three polls per interaction. Legacy Action jobs are not accessible.',
  arcanos_gaming_ingest_sources: 'Durably ingest up to four explicitly requested public Gaming source URLs. Requires separate write permission, explicit storage policy, confirmStore=true and a stable idempotency key. Poll status after acceptance.',
  arcanos_gaming_refresh_sources: 'Refresh up to four known sources in the private owner\'s Gaming corpus. Changes stored revisions. Requires separate write permission, storage policy, confirmStore=true and a stable idempotency key.',
  arcanos_gaming_ingest_candidates: 'Durably ingest selected backend-approved candidates from this owned workflow. Requires separate write permission, matching storage policy, confirmStore=true and a stable idempotency key. Candidate approval and eligibility are checked again.',
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
