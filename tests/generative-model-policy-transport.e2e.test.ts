import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import {
  startGenerativeModelPolicyProvider, type GenerativeModelPolicyProvider
} from './fixtures/generative-model-policy-provider.js';

const authority = 'ft:gpt-4.1:synthetic:transport-Authority';
const messages = [{ role: 'user' as const, content: 'Synthetic bounded transport request.' }];
const originalEnvironment = process.env;
const isolatedKeys = [
  'FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID',
  'RAILWAY_FINE_TUNED_MODEL_ID', 'AI_MODEL', 'RAILWAY_AI_MODEL', 'OPENAI_MODEL',
  'RAILWAY_OPENAI_MODEL', 'RAILWAY_RAILWAY_OPENAI_MODEL',
  'DATABASE_URL', 'RAILWAY_DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
  'REDIS_URL', 'RAILWAY_REDIS_URL', 'RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_ID',
  'ARCANOS_PROCESS_KIND', 'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN', 'ARCANOS_GPT_ACCESS_TOKEN'
];
let provider: GenerativeModelPolicyProvider;
let adapter: OpenAIAdapter;
let chatFlow: typeof import('../src/services/openai/chatFlow/index.js');
let chatFallbacks: typeof import('../src/services/openai/chatFallbacks.js');
let responseRunner: typeof import('../src/lib/runResponse.js');
let responsesClient: typeof import('../src/services/openaiClient.js');
let adapterModule: typeof import('../src/core/adapters/openai.adapter.js');

async function createStream(signal?: AbortSignal): Promise<AsyncIterable<unknown>> {
  const result = await chatFlow.createCentralizedCompletion(messages, {
    stream: true, max_tokens: 64, signal
  });
  if (!(Symbol.asyncIterator in result)) throw new Error('Expected the actual SDK Responses stream.');
  return result;
}

async function collectEvents(stream: AsyncIterable<unknown>, received: unknown[] = []) {
  for await (const event of stream) received.push(event);
  return received;
}

beforeEach(async () => {
  jest.resetModules();
  process.env = { ...originalEnvironment };
  // Blank sentinels prevent dotenv from reintroducing local credentials/configuration.
  isolatedKeys.forEach(key => { process.env[key] = ''; });
  process.env.NODE_ENV = 'test';
  process.env.RUN_WORKERS = 'false';
  process.env.ARCANOS_CONTEXT_MODE = 'disabled';
  process.env.FINETUNED_MODEL_ID = authority;
  process.env.ROUTING_MAX_TOKENS = '64';
  process.env.OPENAI_MAX_RETRIES = '0';
  process.env.WORKER_API_TIMEOUT_MS = '1000';
  process.env.OPENAI_STORE = 'false';
  process.env.LOG_LEVEL = 'error';
  // These retired knobs cannot select a final model or change helper roles.
  process.env.GPT5_MODEL = 'gpt-5.1';
  process.env.TRINITY_FINAL_MODEL = 'gpt-6.1-sol';
  process.env.TRINITY_REASONING_MODEL = 'gpt-4.1-mini';
  provider = await startGenerativeModelPolicyProvider({ authorityModel: authority });
  process.env.OPENAI_API_KEY = provider.apiKey;
  process.env.OPENAI_BASE_URL = provider.baseURL;
  adapterModule = await import('../src/core/adapters/openai.adapter.js');
  adapter = adapterModule.getOpenAIAdapter({
    apiKey: provider.apiKey, baseURL: provider.baseURL,
    maxRetries: 0, timeout: 1000, fetch: provider.fetch
  });
  chatFlow = await import('../src/services/openai/chatFlow/index.js');
  chatFallbacks = await import('../src/services/openai/chatFallbacks.js');
  responseRunner = await import('../src/lib/runResponse.js');
  responsesClient = await import('../src/services/openaiClient.js');
});

afterEach(async () => {
  try {
    await provider.close();
  } finally {
    adapterModule.resetOpenAIAdapter();
    process.env = originalEnvironment;
    jest.resetModules();
  }
});

describe('generative policy through the actual OpenAI SDK and loopback HTTP provider', () => {
  it('sends authoritative defaults through Responses and legacy-chat wrappers and returns provider text/usage', async () => {
    provider.enqueue(
      { kind: 'completion', text: 'Synthetic raw Responses answer.' },
      { kind: 'completion', text: 'Synthetic validated Responses answer.' },
      { kind: 'completion', text: 'Synthetic legacy-chat answer.' },
      { kind: 'completion', text: 'Synthetic centralized answer.' },
      { kind: 'completion', text: 'Synthetic generic answer.' }
    );
    const raw = await responseRunner.runResponse({ input: messages[0].content });
    const response = await responsesClient.createResponses({
      model: authority, input: messages[0].content, max_output_tokens: 64, store: false
    });
    const chat = await chatFallbacks.createSingleChatCompletion(adapter, { messages, max_tokens: 64 });
    const centralized = await chatFlow.createCentralizedCompletion(messages, { max_tokens: 64 });
    const generic = await chatFlow.callOpenAI(authority, messages[0].content, 64, false, { maxRetries: 0 });

    expect(raw).toMatchObject({ model: authority, output_text: 'Synthetic raw Responses answer.' });
    expect(response).toMatchObject({ model: authority, output_text: 'Synthetic validated Responses answer.' });
    expect(chat).toMatchObject({
      activeModel: authority, fallbackFlag: false,
      choices: [{ message: { content: 'Synthetic legacy-chat answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    });
    if (Symbol.asyncIterator in centralized) throw new Error('Unexpected stream for non-stream request.');
    expect(centralized.choices[0].message.content).toBe('Synthetic centralized answer.');
    expect(generic).toMatchObject({ model: authority, output: 'Synthetic generic answer.', cached: false });
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests.every(request => request.path === '/v1/responses' && request.authorizationAccepted)).toBe(true);
    expect(provider.requests.map(request => request.model)).toEqual(Array(5).fill(authority));
    expect(provider.requests[0].body.store).toBe(false);
    for (const request of provider.requests.slice(1)) {
      expect(request.body.max_output_tokens).toBe(64);
      expect(request.body).not.toHaveProperty('messages');
    }
    expect(JSON.stringify(provider.requests[2].body.input)).toContain(messages[0].content);
  });

  it.each([
    ['intake', 'gpt-6-luna'], ['reasoning', 'gpt-6.1-sol'],
    ['audit', 'gpt-6-luna'], ['audit-escalation', 'gpt-6.1-sol']
  ] as const)('transports approved %s helpers independently of missing final authority', async (modelRole, model) => {
    process.env.FINETUNED_MODEL_ID = '';
    const response = await responseRunner.runResponse({ input: messages[0].content, modelRole });
    const helper = await chatFlow.createGPT5Reasoning(adapter, messages[0].content, undefined, {
      modelRole, reasoningEffort: 'low'
    });
    expect(response.model).toBe(model);
    expect(helper).toMatchObject({ model, content: 'Synthetic local provider answer.' });
    expect(helper.error).toBeUndefined();
    expect(provider.requests.map(request => request.model)).toEqual([model, model]);
    expect(provider.requests[1].body.reasoning).toEqual({ effort: 'low' });
    for (const request of provider.requests) {
      expect(request.body).not.toHaveProperty('temperature');
      expect(request.body).not.toHaveProperty('top_p');
      expect(request.authorizationAccepted).toBe(true);
    }
  });

  it.each(['gpt-4.1-mini', 'gpt-6.1-sol', 'ft:gpt-4.1:synthetic:unapproved'])
  ('denies arbitrary final/base override %s before any HTTP transport', async model => {
    const expected = { code: 'MODEL_OVERRIDE_CONFLICT' };
    await expect(responseRunner.runResponse({ model, input: messages[0].content })).rejects.toMatchObject(expected);
    await expect(responsesClient.createResponses({ model, input: messages[0].content })).rejects.toMatchObject(expected);
    await expect(chatFallbacks.createSingleChatCompletion(adapter, { model, messages })).rejects.toMatchObject(expected);
    await expect(chatFallbacks.createChatCompletionWithFallback(adapter, { model, messages })).rejects.toMatchObject(expected);
    await expect(chatFlow.callOpenAI(model, messages[0].content, 64, false)).rejects.toMatchObject(expected);
    await expect(chatFlow.call_gpt5_strict(messages[0].content, { model })).rejects.toMatchObject(expected);
    await expect(chatFlow.createCentralizedCompletion(messages, { model, stream: true })).rejects.toMatchObject(expected);
    expect(provider.requests).toEqual([]);
  });

  it.each(['', 'gpt-6.1-sol'])('rejects unavailable/non-fine-tuned authority %p with zero HTTP transports', async configured => {
    process.env.FINETUNED_MODEL_ID = configured;
    const expected = { code: 'FINAL_AUTHORITY_UNAVAILABLE' };
    await expect(responseRunner.runResponse({ input: messages[0].content })).rejects.toMatchObject(expected);
    await expect(responsesClient.createResponses({ model: authority, input: messages[0].content })).rejects.toMatchObject(expected);
    await expect(chatFallbacks.createSingleChatCompletion(adapter, { messages })).rejects.toMatchObject(expected);
    await expect(chatFallbacks.createChatCompletionWithFallback(adapter, { messages })).rejects.toMatchObject(expected);
    await expect(chatFlow.callOpenAI(authority, messages[0].content, 64, false)).rejects.toMatchObject(expected);
    await expect(chatFlow.createCentralizedCompletion(messages, { stream: true })).rejects.toMatchObject(expected);
    expect(provider.requests).toEqual([]);
  });

  it.each([null, 'gpt-6.1-sol', `${authority}-other`, authority.toLowerCase()])
  ('rejects raw HTTP provider identity %p before accepting Responses or legacy-chat output', async model => {
    provider.enqueue(
      { kind: 'completion', model, text: 'Untrusted raw provider answer.' },
      { kind: 'completion', model, text: 'Untrusted legacy provider answer.' }
    );
    await expect(responseRunner.runResponse({ input: messages[0].content })).rejects.toThrow(/model/i);
    await expect(chatFallbacks.createSingleChatCompletion(adapter, { messages, max_tokens: 64 })).rejects.toThrow(/model/i);
    expect(provider.requests.map(request => request.model)).toEqual([authority, authority]);
  });

  it('recovers HTTP failure and incomplete output without changing final authority', async () => {
    provider.enqueue(
      { kind: 'error', status: 503 },
      { kind: 'completion', status: 'incomplete', text: 'Synthetic incomplete answer.' },
      { kind: 'completion', text: 'Synthetic recovered complete answer.' }
    );
    const response = await chatFallbacks.createChatCompletionWithFallback(adapter, { messages, max_tokens: 64 });
    expect(response).toMatchObject({ activeModel: authority, fallbackFlag: true });
    expect(response.choices[0].message.content).toBe('Synthetic recovered complete answer.');
    expect(response.choices[0].finish_reason).toBe('stop');
    expect(provider.requests.map(request => request.model)).toEqual([authority, authority, authority]);
    expect(provider.requests.every(request => request.body.max_output_tokens === 64)).toBe(true);
  });

  it('recovers a routine audit HTTP failure on Luna without automatic escalation', async () => {
    provider.enqueue({ kind: 'error', status: 503 }, { kind: 'completion' });
    const response = await chatFallbacks.createChatCompletionWithFallback(adapter, { messages, max_tokens: 64 }, 'audit');
    expect(response.activeModel).toBe('gpt-6-luna');
    expect(provider.requests.map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6-luna']);
  });

  it('passes actual SSE response metadata and deltas only after final identity is verified', async () => {
    provider.enqueue({ kind: 'stream', text: 'Synthetic streamed authority answer.' });
    const events = await collectEvents(await createStream()) as Array<Record<string, unknown>>;
    expect(events.map(event => event.type)).toEqual(['response.created', 'response.output_text.delta', 'response.completed']);
    expect(events[1].delta).toBe('Synthetic streamed authority answer.');
    expect(events[0].response).toMatchObject({ model: authority });
    expect(events[2].response).toMatchObject({ model: authority, status: 'completed' });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].body).toMatchObject({ model: authority, stream: true, store: false, max_output_tokens: 64 });
  });

  it.each([null, 'gpt-6.1-sol'])('withholds every SSE event when initial HTTP provider identity is %p', async model => {
    provider.enqueue({ kind: 'stream', model, text: 'Untrusted stream delta.' });
    const received: unknown[] = [];
    await expect(collectEvents(await createStream(), received)).rejects.toThrow(/model/i);
    expect(received).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it('rechecks later SSE identity before forwarding that metadata or output', async () => {
    provider.enqueue({ kind: 'stream', laterModel: 'gpt-6.1-sol', text: 'Untrusted later delta.' });
    const received: unknown[] = [];
    await expect(collectEvents(await createStream(), received)).rejects.toThrow(/model/i);
    expect(received).toEqual([expect.objectContaining({ type: 'response.created', response: expect.objectContaining({ model: authority }) })]);
  });

  it.each(['early-break', 'before-first-read', 'parent-abort'] as const)
  ('closes the real held SSE transport on %s', async scenario => {
    provider.enqueue({ kind: 'stream', holdOpen: true });
    const parent = new AbortController();
    const stream = await createStream(parent.signal);
    if (scenario === 'early-break') {
      for await (const event of stream) {
        expect(event).toMatchObject({ type: 'response.created' });
        break;
      }
    } else {
      const iterator = stream[Symbol.asyncIterator]();
      if (scenario === 'before-first-read') {
        expect(await iterator.return?.()).toMatchObject({ done: true });
      } else {
        expect((await iterator.next()).value).toMatchObject({ type: 'response.created' });
        parent.abort(new Error('Synthetic parent cancellation'));
        await expect(iterator.next()).rejects.toThrow(/cancel|abort/i);
      }
    }
    await provider.waitForStreamClose(0);
    expect(provider.requests[0].streamClosed).toBe(true);
    expect(provider.requests).toHaveLength(1);
  });
});
