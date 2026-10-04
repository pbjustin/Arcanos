import contract from '../schemas/v1/tools/arcanos-gaming/contract.schema.json' with { type: 'json' };

type JsonSchema = Record<string, unknown>;
export type ChatGptGamingToolName = keyof typeof contract.tools;
export const CHATGPT_GAMING_TOOL_NAMES = Object.freeze(Object.keys(contract.tools) as ChatGptGamingToolName[]);
export interface ChatGptGamingOutput { statusCode: number; result: Record<string, unknown> }

/** Self-contained schemas: include only reachable definitions, never HTTP auth or hosts. */
function resolveSchema(schema: JsonSchema, compactOutput = false): JsonSchema & { type: 'object' } {
  const definitions = contract.$defs as Record<string, JsonSchema>;
  const root = typeof schema.$ref === 'string' ? definitions[schema.$ref.split('/').at(-1)!] : schema;
  const required: Record<string, JsonSchema> = {};
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as JsonSchema;
    if (typeof record.$ref === 'string') {
      const name = record.$ref.split('/').at(-1)!;
      if (!required[name]) { required[name] = definitions[name]; visit(required[name]); }
    }
    Object.values(record).forEach(visit);
  }
  visit(root);
  const result = { ...root, type: 'object' as const, ...(Object.keys(required).length ? { $defs: required } : {}) };
  // Annotation text repeats across tools. Retain the canonical contract's
  // documentation while bounding the catalog; validation keywords are unchanged.
  // Preserve actionable input discovery, revision, consent and retry guidance.
  const documentedInputFields = new Set(['idempotencyKey', 'discoveryType', 'expectedRevision', 'sourceTypeHint']);
  function compact(value: unknown, field?: string): unknown {
    if (Array.isArray(value)) return value.map(child => compact(child, field));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description'
      || (!compactOutput && field !== undefined && documentedInputFields.has(field)))
      .map(([key, child]) => [key, compact(child, key)]));
  }
  return compact(result) as JsonSchema & { type: 'object' };
}

export const chatGptGamingSchemas = Object.fromEntries(CHATGPT_GAMING_TOOL_NAMES.map(name => [name, {
  input: resolveSchema(contract.tools[name].input), output: resolveSchema(contract.tools[name].output, true),
}])) as Record<ChatGptGamingToolName, { input: JsonSchema & { type: 'object' }; output: JsonSchema & { type: 'object' } }>;
