import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Synthetic local transport fixture, not provider availability or model-quality proof. */
export interface GenerativeModelPolicyProviderRequest {
  method: string;
  path: string;
  model: string;
  body: Record<string, unknown>;
  authorizationAccepted: boolean;
  streamClosed: boolean;
}

export type GenerativeModelPolicyProviderReply =
  | {
    kind: 'completion';
    text?: string;
    /** Omission echoes the request model; null deliberately omits provider identity. */
    model?: string | null;
    status?: 'completed' | 'incomplete';
    usage?: { inputTokens: number; outputTokens: number };
  }
  | { kind: 'error'; status: 400 | 503; errorCode?: string }
  | {
    kind: 'stream';
    text?: string;
    model?: string | null;
    /** Later mismatched metadata is emitted before the output delta. */
    laterModel?: string | null;
    /** Keep the HTTP response open so cancellation must close the real socket. */
    holdOpen?: boolean;
  };

export interface GenerativeModelPolicyProvider {
  baseURL: string;
  apiKey: string;
  requests: GenerativeModelPolicyProviderRequest[];
  /** Uses native fetch, with an exact-origin/path guard before any transport. */
  fetch: typeof globalThis.fetch;
  enqueue: (...replies: GenerativeModelPolicyProviderReply[]) => void;
  waitForStreamClose: (requestIndex: number, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

const SYNTHETIC_API_KEY = 'sk-synthetic-local-generative-model-policy-key';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_REPLY_TEXT_CHARS = 16 * 1024;
const DEFAULT_REPLY_TEXT = 'Synthetic local provider answer.';

function responseBody(
  request: GenerativeModelPolicyProviderRequest,
  reply: Extract<GenerativeModelPolicyProviderReply, { kind: 'completion' }>
) {
  const model = reply.model === undefined ? request.model : reply.model;
  const text = reply.text ?? DEFAULT_REPLY_TEXT;
  if (text.length > MAX_REPLY_TEXT_CHARS) throw new Error('Synthetic reply text limit exceeded.');
  const inputTokens = reply.usage?.inputTokens ?? 11;
  const outputTokens = reply.usage?.outputTokens ?? 7;
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 128)) {
    throw new Error('Synthetic usage limit exceeded.');
  }
  const status = reply.status ?? 'completed';
  return {
    id: 'resp_synthetic_local_policy', object: 'response', created_at: 1,
    ...(model === null ? {} : { model }), status,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    output_text: text,
    output: [{
      type: 'message', id: 'msg_synthetic_local_policy', role: 'assistant', status,
      content: [{ type: 'output_text', text, annotations: [] }]
    }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Synthetic request byte limit exceeded.');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Synthetic provider requires an object body.');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
  response.end(JSON.stringify(body));
}

/** Start only an ephemeral IPv4 loopback HTTP server with a bounded synthetic transcript. */
export async function startGenerativeModelPolicyProvider({
  authorityModel,
  maxRequests = 24
}: {
  authorityModel: string;
  maxRequests?: number;
}): Promise<GenerativeModelPolicyProvider> {
  if (!authorityModel.startsWith('ft:') || !authorityModel.includes(':synthetic:')) {
    throw new Error('Provider fixture requires a synthetic fine-tune identity.');
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 64) {
    throw new Error('Synthetic request limit must be between 1 and 64.');
  }
  const requests: GenerativeModelPolicyProviderRequest[] = [];
  const replies: GenerativeModelPolicyProviderReply[] = [];
  const allowedModels = new Set([authorityModel, 'gpt-6-luna', 'gpt-6.1-sol']);
  const streamClosures = new Map<number, Promise<void>>();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const server = createServer((incoming, response) => {
    void (async () => {
      const path = incoming.url ?? '';
      const method = incoming.method ?? '';
      const isModelRead = method === 'GET' && path === '/v1/models/gpt-6-luna';
      const isResponseCreate = method === 'POST' && path === '/v1/responses';
      if (!isModelRead && !isResponseCreate) {
        sendJson(response, 404, { error: { message: 'Unexpected synthetic endpoint.', type: 'fixture_error' } });
        return;
      }
      const body: Record<string, unknown> = isResponseCreate ? await readBody(incoming) : {};
      const model = isModelRead ? 'gpt-6-luna' : typeof body.model === 'string' ? body.model : '';
      const request: GenerativeModelPolicyProviderRequest = {
        method, path, model, body,
        authorizationAccepted: incoming.headers.authorization === `Bearer ${SYNTHETIC_API_KEY}`,
        streamClosed: false
      };
      const requestIndex = requests.push(request) - 1;
      if (requests.length > maxRequests || !request.authorizationAccepted || !allowedModels.has(model)) {
        sendJson(response, 400, { error: { message: 'Synthetic request admission failed.', type: 'fixture_error' } });
        return;
      }
      if (isModelRead) {
        sendJson(response, 200, { id: model, object: 'model', created: 1, owned_by: 'synthetic-local-fixture' });
        return;
      }
      const reply: GenerativeModelPolicyProviderReply = replies.shift() ?? { kind: 'completion' };
      if (reply.kind === 'error') {
        sendJson(response, reply.status, { error: {
          message: 'Synthetic bounded provider rejection.', type: 'synthetic_provider_error',
          code: reply.errorCode ?? 'synthetic_rejection'
        } });
        return;
      }
      if (reply.kind === 'completion') {
        sendJson(response, 200, responseBody(request, reply));
        return;
      }
      if (body.stream !== true) throw new Error('Synthetic stream reply requires a streaming request.');
      let resolveClosed!: () => void;
      streamClosures.set(requestIndex, new Promise<void>(resolve => { resolveClosed = resolve; }));
      response.once('close', () => {
        request.streamClosed = true;
        resolveClosed();
      });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let sequenceNumber = 0;
      const emit = (type: string, fields: Record<string, unknown>) => {
        const event = { type, sequence_number: sequenceNumber++, ...fields };
        response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const initial = responseBody(request, { kind: 'completion', model: reply.model, text: reply.text });
      emit('response.created', { response: { ...initial, status: 'in_progress', output: [], output_text: '' } });
      if (reply.laterModel !== undefined) {
        const later = responseBody(request, { kind: 'completion', model: reply.laterModel, text: reply.text });
        emit('response.in_progress', { response: { ...later, status: 'in_progress', output: [], output_text: '' } });
      }
      emit('response.output_text.delta', {
        item_id: 'msg_synthetic_local_policy', output_index: 0, content_index: 0,
        delta: reply.text ?? DEFAULT_REPLY_TEXT
      });
      if (!reply.holdOpen) {
        emit('response.completed', { response: initial });
        response.end('data: [DONE]\n\n');
      }
    })().catch(error => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: {
          message: error instanceof Error ? error.message : 'Synthetic fixture failure.', type: 'fixture_error'
        } });
      } else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseURL: `${origin}/v1`, apiKey: SYNTHETIC_API_KEY, requests,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin || !['/v1/responses', '/v1/models/gpt-6-luna'].includes(url.pathname)) {
        throw new Error('Provider fixture blocked a non-loopback or unexpected transport.');
      }
      return nativeFetch(input, init);
    },
    enqueue: (...nextReplies) => {
      if (replies.length + nextReplies.length > maxRequests) throw new Error('Synthetic reply queue limit exceeded.');
      replies.push(...nextReplies);
    },
    waitForStreamClose: async (requestIndex, timeoutMs = 1_000) => {
      const closure = streamClosures.get(requestIndex);
      if (!closure) throw new Error('No stream closure registered for this request.');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closure,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Synthetic HTTP stream did not close.')), timeoutMs);
          })
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    }
  };
}
