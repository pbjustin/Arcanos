/**
 * Real MCP SDK interoperability with the contained preview's fixed Tutor mock.
 * No production Tutor, OAuth verifier, provider or storage dependency is used.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Ajv } from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chatGptTutorInputSchema, chatGptTutorOutputSchema } from '@arcanos/protocol';
import { createNativePrPreviewApplication } from '../src/nativePrPreviewApplication.js';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';

const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptTutor;
const provenance = NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader;
const validateOutput = new Ajv().compile(chatGptTutorOutputSchema);
const identity = { prNumber: 1508, sourceCommit: 'a'.repeat(40) };
const realFetch = globalThis.fetch;
const notionProbe = jest.fn(async () => { throw new Error('Unexpected Notion connectivity probe'); });
const clients: Client[] = [];
const unexpectedNetwork: string[] = [];
let server: Server;
let origin: string;

async function withDeadline<T>(pending: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Preview fixture cleanup timed out')), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
const loopbackFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin) {
    unexpectedNetwork.push(url.origin);
    throw new Error('Unexpected request outside the preview test listener');
  }
  return realFetch(input, { ...init, redirect: 'error' });
};

beforeEach(async () => {
  unexpectedNetwork.length = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(loopbackFetch);
  const app = createNativePrPreviewApplication({
    identity,
    readinessState: { applicationImported: true, fixturesSealed: true, ready: true, draining: false },
    notionConnectivityProbe: notionProbe,
  });
  server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener');
  origin = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => {
  try {
    await withDeadline(Promise.all(clients.splice(0).map(client => client.close())));
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await withDeadline(closed);
    expect(notionProbe).not.toHaveBeenCalled();
    expect(unexpectedNetwork).toEqual([]);
  } finally { jest.restoreAllMocks(); }
});

function envelope(method: string, params: unknown = {}, id: string | number = 1) {
  return { jsonrpc: '2.0', id, method, params };
}
function tutorArguments(prompt = contract.prompt) {
  return { name: contract.toolName, arguments: { prompt } };
}
async function post(body: unknown, headers: Record<string, string> = {}, path = contract.path) {
  return loopbackFetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function connect() {
  const client = new Client({ name: 'sealed-tutor-interoperability-test', version: '1.0.0' });
  clients.push(client);
  const methods: string[] = [];
  const observed: Array<{ method: string; status: number; headers: Headers; body: unknown }> = [];
  const transport = new StreamableHTTPClientTransport(new URL(origin + contract.path), {
    fetch: async (url, init) => {
      const method = typeof init?.body === 'string' ? JSON.parse(init.body).method : init?.method;
      if (typeof method === 'string') methods.push(method);
      const response = await loopbackFetch(url, init);
      observed.push({
        method, status: response.status, headers: response.headers,
        body: response.status === 200 ? await response.clone().json() : null,
      });
      return response;
    },
  });
  await client.connect(transport);
  return { client, transport, methods, observed };
}

describe('sealed Tutor preview through the actual MCP SDK HTTP client', () => {
  it('initializes, lists canonical schemas, and returns the fixed answer explicitly labelled mock', async () => {
    const { client, transport, methods, observed } = await connect();
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]).toMatchObject({
      name: contract.toolName,
      title: 'ARCANOS Tutor (synthetic preview)',
      inputSchema: chatGptTutorInputSchema,
      outputSchema: chatGptTutorOutputSchema,
      _meta: { securitySchemes: [{ type: 'noauth' }] },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    });
    const result = await client.callTool(tutorArguments());
    expect(result.isError).not.toBe(true);
    expect(validateOutput(result.structuredContent)).toBe(true);
    expect(result.structuredContent).toEqual(contract.output);
    expect(result.structuredContent).toMatchObject({
      answer: contract.answer,
      metadata: { module: 'ARCANOS:TUTOR', generation: 'mock', memory: 'unavailable', execution: 'synchronous' },
    });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(contract.output) }]);
    expect(transport.sessionId).toBeUndefined();
    expect(methods).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']));
    const initialized = observed.find(value => value.method === 'initialize');
    expect(initialized?.body).toMatchObject({
      result: { protocolVersion: contract.protocolVersion, serverInfo: { name: 'arcanos-tutor-sealed-preview' } },
    });
    expect(observed.find(value => value.method === 'notifications/initialized')?.status).toBe(202);
    for (const response of observed) {
      expect(response.headers.get(contract.honestyProofHeader)).toBe(
        response.method === 'tools/call' ? contract.honestyProofVersion : null);
    }
    for (const response of observed.filter(value => value.status === 200)) {
      expect(response.headers.get(provenance.name)).toBe(provenance.value);
      expect(response.headers.get(contract.proofHeader)).toBe(contract.proofVersion);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('mcp-session-id')).toBeNull();
    }
  });

  it.each([
    { prompt: 'Explain a different topic.' },
    { prompt: '' },
    { prompt: 'Sealed Tutor preview: explain one half. ', sessionId: 'synthetic-session' },
    { prompt: 'Sealed Tutor preview: explain one half.', module: 'ARCANOS:CORE' },
    { prompt: 'Sealed Tutor preview: explain one half.', credentials: 'synthetic-forbidden' },
  ])('rejects non-fixture or privileged arguments without substituting a success (%#)', async argumentsValue => {
    const { client } = await connect();
    const denied = await client.callTool({ name: contract.toolName, arguments: argumentsValue });
    expect(denied).toMatchObject({ isError: true, content: [{ type: 'text', text: 'TUTOR_PREVIEW_INPUT_UNSUPPORTED' }] });
    expect(denied.structuredContent).toBeUndefined();
    expect((await client.callTool(tutorArguments())).structuredContent).toEqual(contract.output);
  });

  it.each(['modules.invoke', 'memory.search', 'jobs.get'])('denies unadvertised direct tool %s', async name => {
    const { client } = await connect();
    expect(await client.callTool({ name, arguments: { prompt: contract.prompt } })).toMatchObject({
      isError: true, content: [{ type: 'text', text: 'TUTOR_PREVIEW_TOOL_UNAVAILABLE' }],
    });
  });

  it('rejects malformed JSON and JSON-RPC batches with bounded errors', async () => {
    const malformed = await post('{malformed JSON');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'PREVIEW_REQUEST_INVALID' });
    const batch = await post([envelope('tools/call', tutorArguments()), envelope('tools/list', {}, 2)]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
  });

  it.each(['authorization', 'cookie', 'mcp-session-id', 'x-session-id', 'x-api-key'])(
    'denies %s before parsing even malformed JSON', async header => {
      for (const body of [envelope('tools/call', tutorArguments()), '{malformed JSON']) {
        const response = await post(body, { [header]: 'synthetic-rejected-preview-value' });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('not found');
        expect(response.headers.get(contract.proofHeader)).toBeNull();
        expect(response.headers.get(contract.honestyProofHeader)).toBeNull();
      }
    },
  );

  it('preserves the sealed 4 KiB body cap, JSON media type and encoding boundary', async () => {
    const exactBody = JSON.stringify(envelope('tools/call', tutorArguments())).padEnd(4_096, ' ');
    const exact = await post(exactBody);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ result: { structuredContent: contract.output } });
    for (const [body, headers] of [
      ['x'.repeat(4_097), {}],
      [JSON.stringify(envelope('tools/call', tutorArguments())), { 'Content-Type': 'text/plain' }],
      [JSON.stringify(envelope('tools/call', tutorArguments())), { 'Content-Encoding': 'gzip' }],
    ] as const) {
      const response = await post(body, headers);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('not found');
    }
  });

  it('accepts bounded reserved MCP metadata without treating it as tool arguments or returning it', async () => {
    const marker = 'synthetic-progress-metadata';
    const response = await post(envelope('tools/call', {
      ...tutorArguments(), _meta: { progressToken: marker },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ result: { structuredContent: contract.output } });
    expect(JSON.stringify(body)).not.toContain(marker);
    const invalid = await post(envelope('tools/call', { ...tutorArguments(), _meta: marker }));
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ error: { code: -32602 } });
  });

  it('rejects unsupported and duplicated protocol-version headers', async () => {
    const body = JSON.stringify(envelope('tools/list'));
    const unsupported = await post(body, { 'Mcp-Protocol-Version': '2024-01-01' });
    expect(unsupported.status).toBe(404);
    const duplicateStatus = await withDeadline(new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(new URL(origin + contract.path), {
        method: 'POST', headers: [
          'Host', new URL(origin).host,
          'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)),
          'Mcp-Protocol-Version', contract.protocolVersion,
          'Mcp-Protocol-Version', contract.protocolVersion,
        ],
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
        response.once('error', reject);
      });
      outgoing.once('error', reject);
      outgoing.setTimeout(2_000, () => outgoing.destroy(new Error('Duplicate-header fixture timed out')));
      outgoing.end(body);
    }));
    expect(duplicateStatus).toBe(404);
  });

  it('keeps OAuth metadata, streaming, alternate methods and noncanonical paths unavailable', async () => {
    const streaming = await loopbackFetch(origin + contract.path, { method: 'GET' });
    expect(streaming.status).toBe(405);
    expect(streaming.headers.get('allow')).toBe('POST');
    expect(await streaming.text()).toBe('method not allowed');
    for (const method of ['HEAD', 'DELETE', 'OPTIONS']) {
      const response = await loopbackFetch(origin + contract.path, { method });
      expect(response.status).toBe(404);
      expect(response.headers.get(contract.proofHeader)).toBeNull();
    }
    for (const path of [contract.path + '?fixture=1', '/chatgpt/%6dcp']) {
      const response = await post(envelope('tools/call', tutorArguments()), {}, path);
      expect(response.status).toBe(404);
    }
    expect((await loopbackFetch(origin + contract.metadataPath)).status).toBe(404);
  });
});
