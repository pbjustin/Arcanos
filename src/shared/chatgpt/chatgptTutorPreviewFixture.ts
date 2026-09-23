// eslint-disable-next-line no-restricted-imports -- Sealed preview contract and canonical JSON only; no production graph.
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../../../scripts/native-pr-preview-contract.mjs';

const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptTutor;
const instructions = 'Synthetic preview only. No OAuth, model provider, memory or saved progress. '
  + `Use only this exact prompt: "${contract.prompt}"`;
const securitySchemes = Object.freeze([Object.freeze({ type: 'noauth' })]);
const tool = Object.freeze({
  name: contract.toolName,
  title: 'ARCANOS Tutor (synthetic preview)',
  description: 'Sealed synthetic Tutor fixture only. '
    + `Use exactly: "${contract.prompt}" No OAuth, model generation, memory or saved progress.`,
  inputSchema: contract.inputSchema,
  outputSchema: contract.outputSchema,
  securitySchemes,
  _meta: Object.freeze({ securitySchemes }),
  annotations: Object.freeze({
    readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
  }),
});

export interface ChatGptTutorPreviewResponse {
  statusCode: number;
  payload?: Record<string, unknown>;
}

type RequestId = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'number' ? Number.isSafeInteger(value)
    : typeof value === 'string' && /^[\x21-\x7e]{1,64}$/u.test(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && value === value.trim();
}

function emptyParams(value: unknown): boolean {
  return value === undefined || (isRecord(value) && hasOnlyKeys(value, ['_meta']) && validMeta(value));
}

function validMeta(value: Record<string, unknown>): boolean {
  return !Object.hasOwn(value, '_meta') || isRecord(value._meta);
}

function rpcError(id: RequestId | null, code: number, message: string, statusCode = 200): ChatGptTutorPreviewResponse {
  return { statusCode, payload: { jsonrpc: '2.0', id, error: { code, message } } };
}

function invalidRequest(): ChatGptTutorPreviewResponse {
  return rpcError(null, -32600, 'Invalid sealed Tutor preview request.', 400);
}

function invalidParams(id: RequestId): ChatGptTutorPreviewResponse {
  return rpcError(id, -32602, 'Invalid sealed Tutor preview parameters.');
}

function result(id: RequestId, value: Record<string, unknown>): ChatGptTutorPreviewResponse {
  return { statusCode: 200, payload: { jsonrpc: '2.0', id, result: value } };
}

function toolError(id: RequestId, code: string): ChatGptTutorPreviewResponse {
  return result(id, { isError: true, content: [{ type: 'text', text: code }] });
}

/**
 * A finite, stateless MCP peer for the sealed preview. Only fixed synthetic
 * output is available; this never imports production OAuth or Tutor execution.
 * The containing HTTP boundary owns byte limits and rejects credentials.
 */
export function handleChatGptTutorPreviewRequest(body: unknown): ChatGptTutorPreviewResponse {
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
    || !hasOnlyKeys(body, ['jsonrpc', 'id', 'method', 'params'])) return invalidRequest();

  if (body.method === 'notifications/initialized') {
    return !Object.hasOwn(body, 'id') && emptyParams(body.params)
      ? { statusCode: 202 } : invalidRequest();
  }
  if (!isRequestId(body.id)) return invalidRequest();
  const id = body.id;
  const params = body.params;

  if (body.method === 'initialize') {
    if (!isRecord(params) || !hasOnlyKeys(params, ['protocolVersion', 'capabilities', 'clientInfo', '_meta'])
      || !validMeta(params)
      || typeof params.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(params.protocolVersion)
      || !isRecord(params.capabilities) || !isRecord(params.clientInfo)
      || !boundedText(params.clientInfo.name) || !boundedText(params.clientInfo.version)) return invalidParams(id);
    return result(id, {
      protocolVersion: contract.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'arcanos-tutor-sealed-preview', version: '1.0.0' },
      instructions,
    });
  }
  if (body.method === 'ping') return emptyParams(params) ? result(id, {}) : invalidParams(id);
  if (body.method === 'tools/list') {
    return emptyParams(params) ? result(id, { tools: [tool] }) : invalidParams(id);
  }
  if (body.method !== 'tools/call') {
    return rpcError(id, -32601, 'Sealed Tutor preview method unavailable.');
  }
  if (!isRecord(params) || !hasOnlyKeys(params, ['name', 'arguments', '_meta']) || !validMeta(params)
    || typeof params.name !== 'string') {
    return invalidParams(id);
  }
  if (params.name !== contract.toolName) return toolError(id, 'TUTOR_PREVIEW_TOOL_UNAVAILABLE');
  if (!isRecord(params.arguments) || !hasOnlyKeys(params.arguments, ['prompt'])
    || params.arguments.prompt !== contract.prompt) return toolError(id, 'TUTOR_PREVIEW_INPUT_UNSUPPORTED');
  return result(id, {
    structuredContent: contract.output,
    content: [{ type: 'text', text: JSON.stringify(contract.output) }],
  });
}
