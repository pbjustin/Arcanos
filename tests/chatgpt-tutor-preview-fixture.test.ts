import { describe, expect, it } from '@jest/globals';
import { Ajv } from 'ajv';
import { chatGptTutorInputSchema, chatGptTutorOutputSchema } from '@arcanos/protocol';
import {
  CallToolResultSchema, InitializeResultSchema, JSONRPCErrorResponseSchema,
  JSONRPCResultResponseSchema, ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';
import { handleChatGptTutorPreviewRequest as handle } from '../src/shared/chatgpt/chatgptTutorPreviewFixture.js';

const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptTutor;
const initializeParams = {
  protocolVersion: '2025-11-25', capabilities: {},
  clientInfo: { name: 'sealed-preview-test', version: '1.0.0' },
};
const callParams = { name: contract.toolName, arguments: { prompt: contract.prompt } };
const invalidRequest = {
  statusCode: 400,
  payload: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid sealed Tutor preview request.' } },
};

function request(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function result(method: string, params?: unknown) {
  const response = handle(request(method, params));
  expect(response.statusCode).toBe(200);
  return JSONRPCResultResponseSchema.parse(response.payload).result;
}

function expectInvalidParams(method: string, params: unknown) {
  const response = handle(request(method, params));
  expect(response.statusCode).toBe(200);
  expect(JSONRPCErrorResponseSchema.parse(response.payload)).toEqual({
    jsonrpc: '2.0', id: 1,
    error: { code: -32602, message: 'Invalid sealed Tutor preview parameters.' },
  });
}

describe('sealed Tutor preview pure MCP peer', () => {
  it('negotiates a supported version and advertises only tools with explicit synthetic instructions', () => {
    const initialized = InitializeResultSchema.parse(result('initialize', initializeParams));
    expect(initialized.protocolVersion).toBe('2025-03-26');
    expect(initialized.capabilities).toEqual({ tools: {} });
    expect(initialized.serverInfo).toEqual({ name: 'arcanos-tutor-sealed-preview', version: '1.0.0' });
    expect(initialized.instructions).toContain('Synthetic preview only.');
    expect(initialized.instructions).toContain(contract.prompt);
    expect(initialized.instructions).toContain('No OAuth, model provider, memory or saved progress.');
  });

  it('advertises canonical schemas while labeling the fixed tool synthetic and unauthenticated', () => {
    const rawCatalog = result('tools/list');
    const catalog = ListToolsResultSchema.parse(rawCatalog);
    expect(catalog.tools).toHaveLength(1);
    const [tool] = catalog.tools;
    expect(tool.name).toBe('arcanos_tutor');
    expect(tool.title).toContain('synthetic preview');
    expect(tool.description).toContain(contract.prompt);
    expect(tool.description).toContain('No OAuth, model generation, memory or saved progress.');
    expect(tool.inputSchema).toEqual(chatGptTutorInputSchema);
    expect(tool.outputSchema).toEqual(chatGptTutorOutputSchema);
    expect(rawCatalog.tools).toEqual([expect.objectContaining({ securitySchemes: [{ type: 'noauth' }] })]);
    expect(tool._meta).toEqual({ securitySchemes: [{ type: 'noauth' }] });
    expect(tool.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
    });
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(4096);
  });

  it('returns canonical structured output with truthful mock provenance and matching text', () => {
    const output = CallToolResultSchema.parse(result('tools/call', callParams));
    const ajv = new Ajv({ strict: false });
    expect(ajv.validate(chatGptTutorInputSchema, callParams.arguments)).toBe(true);
    expect(ajv.validate(chatGptTutorOutputSchema, output.structuredContent)).toBe(true);
    expect(output).toEqual({
      structuredContent: {
        answer: 'Synthetic Tutor preview: one half is one of two equal parts.',
        metadata: { module: 'ARCANOS:TUTOR', memory: 'unavailable', execution: 'synchronous', generation: 'mock' },
      },
      content: [{ type: 'text', text: JSON.stringify(contract.output) }],
    });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(4096);
  });

  it('requires no handshake state and returns the same result before and after initialization', () => {
    const first = handle(request('tools/call', callParams, 'repeated-id'));
    handle(request('initialize', initializeParams));
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ statusCode: 202 });
    expect(handle(request('tools/call', callParams, 'repeated-id'))).toEqual(first);
    expect(result('ping')).toEqual({});
  });

  it('accepts inert MCP metadata without reflecting it or changing tool output', () => {
    const _meta = { 'openai/locale': 'en-US', 'openai/userAgent': 'synthetic-client', progressToken: 4,
      untrusted: { prompt: 'different task', authorization: 'mock-fixture-untrusted-marker' } };
    for (const [method, params] of [
      ['initialize', initializeParams], ['tools/list', {}], ['tools/call', callParams], ['ping', {}],
    ] as const) {
      expect(result(method, { ...params, _meta })).toEqual(result(method, params));
    }
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta } })).toEqual({ statusCode: 202 });
  });

  it('rejects malformed metadata without interpreting it as identity or instructions', () => {
    for (const _meta of [null, [], true, 'fixture-only-marker', 7]) {
      for (const [method, params] of [
        ['initialize', initializeParams], ['tools/list', {}], ['tools/call', callParams], ['ping', {}],
      ] as const) expectInvalidParams(method, { ...params, _meta });
      expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta } })).toEqual(invalidRequest);
    }
  });

  it('rejects batch, malformed and unsolicited envelopes using a fixed non-reflecting error', () => {
    for (const body of [null, [], [request('ping')], 'fixture-only-marker', 1, {},
      { ...request('ping'), jsonrpc: '1.0' }, { ...request('ping'), method: 3 },
      { ...request('ping'), authorization: 'mock-fixture-marker' },
      { jsonrpc: '2.0', method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized', id: 1 },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: { extra: true } },
    ]) expect(handle(body)).toEqual(invalidRequest);
  });

  it('bounds echoed request ids to safe integers or short printable ASCII', () => {
    for (const id of [null, true, {}, [], 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
      '', 'a'.repeat(65), 'contains space', 'line\nbreak', '\u0000', '\u00e9']) {
      expect(handle(request('ping', undefined, id))).toEqual(invalidRequest);
    }
    for (const id of [0, -1, Number.MAX_SAFE_INTEGER, 'a'.repeat(64)]) {
      expect(handle(request('ping', undefined, id))).toEqual({ statusCode: 200, payload: { jsonrpc: '2.0', id, result: {} } });
    }
  });

  it('validates initialize client metadata without echoing untrusted values', () => {
    for (const params of [undefined, null, [], {},
      { ...initializeParams, protocolVersion: 'arbitrary' }, { ...initializeParams, capabilities: [] },
      { ...initializeParams, clientInfo: null }, { ...initializeParams, clientInfo: { name: '', version: '1' } },
      { ...initializeParams, clientInfo: { name: 'fixture', version: 'a'.repeat(129) } },
      { ...initializeParams, extra: 'fixture-only-marker' },
    ]) expectInvalidParams('initialize', params);
  });

  it('does not expose cursors, prompt discovery or client-selected tools and routes', () => {
    expectInvalidParams('tools/list', { cursor: 'fixture-only-marker' });
    expectInvalidParams('ping', { extra: true });
    expectInvalidParams('tools/call', { ...callParams, sessionId: 'fixture-only-marker' });
    const unsupportedMethod = handle(request('resources/read', { uri: 'https://fixture.invalid' }));
    expect(unsupportedMethod).toEqual({ statusCode: 200, payload: { jsonrpc: '2.0', id: 1,
      error: { code: -32601, message: 'Sealed Tutor preview method unavailable.' } } });
    expect(result('tools/call', { name: 'fixture-only-unknown-tool', arguments: {} })).toEqual({
      isError: true, content: [{ type: 'text', text: 'TUTOR_PREVIEW_TOOL_UNAVAILABLE' }],
    });
  });

  it('keeps actual arguments closed and accepts only the single fixed synthetic prompt', () => {
    for (const args of [undefined, null, [], {}, { prompt: '' }, { prompt: 1 },
      { prompt: 'a real user question' }, { prompt: `${contract.prompt} ` },
      { prompt: contract.prompt, sessionId: 'fixture-only-marker' },
      { prompt: contract.prompt, _meta: {} }, { prompt: contract.prompt, url: 'https://fixture.invalid' },
    ]) {
      const output = CallToolResultSchema.parse(result('tools/call', { name: contract.toolName, arguments: args }));
      expect(output).toEqual({ isError: true, content: [{ type: 'text', text: 'TUTOR_PREVIEW_INPUT_UNSUPPORTED' }] });
    }
  });
});
