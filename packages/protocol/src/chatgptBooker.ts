import contract from '../schemas/v1/tools/arcanos-booker/contract.schema.json' with { type: 'json' };
import type {
  BackstageGenerateBookingRequest,
  BackstageGenerateBookingWithHrcRequest,
  BackstageQueryContinuityRequest,
  BackstageSimulateMatchRequest,
} from './backstageBooker.js';

type JsonSchema = Record<string, unknown>;
export type ChatGptBookerToolName = keyof typeof contract.tools;
export const CHATGPT_BOOKER_TOOL_NAMES = Object.freeze(Object.keys(contract.tools) as ChatGptBookerToolName[]);
export interface ChatGptBookerOutput { statusCode: number; result: Record<string, unknown> }
export interface ChatGptBookerInputMap {
  queryContinuity: BackstageQueryContinuityRequest;
  generateBooking: BackstageGenerateBookingRequest & { universeId: string; idempotencyKey?: string };
  generateBookingWithHRC: BackstageGenerateBookingWithHrcRequest & { universeId: string; idempotencyKey?: string };
  simulateMatch: BackstageSimulateMatchRequest & { universeId: string };
  getBackstageUniverse: { universeId: string };
  getBackstageStoryline: { universeId: string; storylineKey: string; offset?: number; expectedVersion?: number };
  getBackstageBookerJobResult: { universeId: string; jobId: string; waitForResultMs?: number };
}

/** Include reachable validation definitions only; keep repeated prose out of discovery. */
function resolveSchema(schema: JsonSchema, connectorInput = false): JsonSchema & { type: 'object' } {
  const definitions = contract.$defs as Record<string, JsonSchema>;
  const reachable: Record<string, JsonSchema> = {};
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as JsonSchema;
    if (typeof record.$ref === 'string') {
      const name = record.$ref.split('/').at(-1)!;
      if (!reachable[name]) { reachable[name] = definitions[name]; visit(reachable[name]); }
    }
    Object.values(record).forEach(visit);
  }
  visit(schema);
  function compact(value: unknown, field?: string): unknown {
    // Preserve non-whitespace search semantics for clients that match the whole input string.
    if (connectorInput && field === 'pattern' && value === '\\S') return '^[\\s\\S]*\\S[\\s\\S]*$';
    if (Array.isArray(value)) return value.map(child => compact(child, field));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'description' || field === 'idempotencyKey')
      .map(([key, child]) => [key, compact(child, key)]));
  }
  return compact({ ...schema, type: 'object', ...(Object.keys(reachable).length ? { $defs: reachable } : {}) }) as JsonSchema & { type: 'object' };
}

export const chatGptBookerSchemas = Object.fromEntries(CHATGPT_BOOKER_TOOL_NAMES.map(name => [name, {
  input: resolveSchema(contract.tools[name].input, true), output: resolveSchema(contract.tools[name].output),
}])) as Record<ChatGptBookerToolName, { input: JsonSchema & { type: 'object' }; output: JsonSchema & { type: 'object' } }>;
