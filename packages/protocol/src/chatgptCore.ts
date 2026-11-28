import contract from '../schemas/v1/tools/arcanos-core/contract.schema.json' with { type: 'json' };

export type CoreMcpToolName = keyof typeof contract.tools;
export type CoreDiagnosticArea = 'runtime' | 'workers' | 'queue' | 'overview';

export interface CoreMcpInputs {
  coreAsk: {
    prompt: string;
    idempotencyKey: string;
    sessionId?: string;
    answerMode?: 'direct' | 'explained';
    maxOutputTokens?: number;
  };
  getCoreJobResult: { jobId: string };
  startCoreSession: { idempotencyKey: string };
  readCoreMemory: { sessionId: string };
  writeCoreMemory: { sessionId: string; text: string; idempotencyKey: string; confirmationToken?: string };
  inspectCoreDiagnostics: { area: CoreDiagnosticArea };
  readCoreProductivity: { view: 'summary' | 'focus' };
}

export const CHATGPT_CORE_TOOL_NAMES = Object.freeze(Object.keys(contract.tools) as CoreMcpToolName[]);

type JsonSchema = Record<string, unknown>;
type ToolSchema = JsonSchema & { type: 'object' };

/** Publish each tool with its referenced definitions so the host can validate it independently. */
function standaloneSchema(schema: JsonSchema): ToolSchema {
  const definitions = contract.$defs as Record<string, JsonSchema>;
  const referenced: Record<string, JsonSchema> = {};
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const ref = (value as JsonSchema).$ref;
    if (typeof ref === 'string') {
      const name = ref.split('/').at(-1)!;
      if (!Object.hasOwn(referenced, name)) {
        referenced[name] = definitions[name];
        visit(referenced[name]);
      }
    }
    Object.values(value).forEach(visit);
  }
  visit(schema);
  return { ...schema, type: 'object', ...(Object.keys(referenced).length ? { $defs: referenced } : {}) };
}

export const chatGptCoreSchemas = Object.fromEntries(CHATGPT_CORE_TOOL_NAMES.map(name => [
  name, {
    input: standaloneSchema(contract.tools[name].input),
    output: standaloneSchema(contract.tools[name].output),
  },
])) as Record<CoreMcpToolName, { input: ToolSchema; output: ToolSchema }>;
