import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getOpenAIAdapter, resetOpenAIAdapter, type OpenAIAdapter
} from '../src/core/adapters/openai.adapter.js';
import {
  callOpenAI, call_gpt5_strict, createCentralizedCompletion,
  createGPT5Reasoning, createGPT5ReasoningLayer
} from '../src/services/openai/chatFlow/index.js';
import {
  createChatCompletionWithFallback, createSingleChatCompletion
} from '../src/services/openai/chatFallbacks.js';
import {
  GenerativeModelPolicyError, resetCredentialCache, type GenerativeModelRole
} from '../src/services/openai/credentialProvider.js';
import { getCircuitBreakerSnapshot } from '../src/services/openai/resilience.js';

const authority = 'ft:gpt-4.1-2025-04-14:synthetic:authority:shared';
const authorityKeys = ['FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL',
  'RAILWAY_OPENAI_MODEL', 'RAILWAY_FINETUNED_MODEL_ID', 'RAILWAY_FINE_TUNED_MODEL_ID',
  'RAILWAY_AI_MODEL', 'RAILWAY_RAILWAY_OPENAI_MODEL'];
const saved = new Map(authorityKeys.map(key => [key, process.env[key]]));
type RequestPayload = { model: string; input?: unknown; max_output_tokens?: number; reasoning?: unknown; stream?: boolean };
type SyntheticReply = { status?: number; model?: string | null; incomplete?: boolean; error?: string };
let requests: RequestPayload[];
let replies: SyntheticReply[];
let adapter: OpenAIAdapter;

function responseBody(model: string | null, incomplete = false) {
  return {
    id: 'resp_synthetic_offline', object: 'response', created_at: 1,
    ...(model === null ? {} : { model }), status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    output: [{ type: 'message', id: 'msg_synthetic', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'Synthetic complete answer.', annotations: [] }] }],
    output_text: 'Synthetic complete answer.',
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
  };
}

// Exercise the installed SDK and real backend adapter. Only native fetch is synthetic;
// every unexpected endpoint throws before a request can reach a network transport.
const nativeFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  expect(request.url).toBe('https://synthetic.invalid/v1/responses');
  const payload = JSON.parse(await request.text()) as RequestPayload;
  requests.push(payload);
  const reply = replies.shift() ?? {};
  const status = reply.status ?? 200;
  const body = status === 200
    ? responseBody(reply.model === undefined ? payload.model : reply.model, reply.incomplete)
    : { error: { message: reply.error ?? 'Synthetic provider failure', type: 'server_error', code: 'fixture_error' } };
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' }
  });
});

async function recoverCircuitBreaker(): Promise<void> {
  const snapshot = getCircuitBreakerSnapshot();
  if (snapshot.state === 'CLOSED' && snapshot.failureCount === 0) return;
  const now = snapshot.state === 'OPEN'
    ? jest.spyOn(Date, 'now').mockReturnValue(snapshot.lastFailureTime + snapshot.constants.CIRCUIT_BREAKER_RESET_TIMEOUT_MS + 1)
    : undefined;
  replies = [];
  try {
    for (let index = 0; index < (snapshot.state === 'CLOSED' ? 1 : 2); index += 1) {
      await createSingleChatCompletion(adapter, { messages: [{ role: 'user', content: 'Restore test isolation.' }] });
    }
  } finally {
    now?.mockRestore();
  }
}

beforeEach(async () => {
  authorityKeys.forEach(key => { delete process.env[key]; });
  process.env.FINETUNED_MODEL_ID = authority;
  resetCredentialCache();
  resetOpenAIAdapter();
  requests = [];
  replies = [];
  adapter = getOpenAIAdapter({
    apiKey: 'test-offline-policy-key', baseURL: 'https://synthetic.invalid/v1',
    maxRetries: 0, timeout: 1_000, fetch: nativeFetch
  });
  await recoverCircuitBreaker();
  requests = [];
  nativeFetch.mockClear();
});
afterEach(async () => {
  process.env.FINETUNED_MODEL_ID = authority;
  await recoverCircuitBreaker();
  resetOpenAIAdapter();
  resetCredentialCache();
  saved.forEach((value, key) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  jest.restoreAllMocks();
});

describe('shared generative policy through real wrappers and SDK transport', () => {
  it.each(['final', 'final-escalation'] as const)('keeps configured authority for %s composition', async role => {
    const result = await createSingleChatCompletion(adapter, {
      messages: [{ role: 'user', content: 'Compose a synthetic final answer.' }],
      max_completion_tokens: 500
    }, role);
    expect(result.activeModel).toBe(authority);
    expect(result.choices[0]?.message.content).toBe('Synthetic complete answer.');
    expect(requests).toEqual([expect.objectContaining({ model: authority, max_output_tokens: 500 })]);
  });

  it('routes generic, centralized, strict and refinement finals through the same authority', async () => {
    await callOpenAI(authority, 'Synthetic summary.', 200, false, { maxRetries: 0 });
    await createCentralizedCompletion([{ role: 'user', content: 'Synthetic simulation.' }]);
    await call_gpt5_strict('Synthetic diagnostic.', { max_completion_tokens: 200 });
    const refinement = await createGPT5ReasoningLayer(adapter, 'Synthetic draft.', 'Synthetic question.');
    expect(refinement).toMatchObject({ model: authority, reasoningUsed: true });
    expect(requests).toHaveLength(4);
    expect(requests.map(request => request.model)).toEqual([authority, authority, authority, authority]);
  });

  it.each([
    ['intake', 'gpt-6-luna'], ['reasoning', 'gpt-6.1-sol'],
    ['audit', 'gpt-6-luna'], ['audit-escalation', 'gpt-6.1-sol']
  ] as const)('routes an explicit %s helper without using authority', async (role, model) => {
    const reasoning = await createGPT5Reasoning(adapter, 'Synthetic helper task.', undefined, { modelRole: role });
    expect(reasoning).toMatchObject({ content: 'Synthetic complete answer.', model });
    await callOpenAI(model, 'Synthetic helper task.', 100, false, { modelRole: role, maxRetries: 0 });
    expect(requests.map(request => request.model)).toEqual([model, model]);
  });

  it.each(['gpt-5.1', 'gpt-6-luna', 'gpt-6.1-sol', authority + '-other']) (
    'rejects conflicting final override %s before native transport', async model => {
      await expect(createSingleChatCompletion(adapter, { model, messages: [] })).rejects.toBeInstanceOf(GenerativeModelPolicyError);
      await expect(createChatCompletionWithFallback(adapter, { model, messages: [] })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
      await expect(callOpenAI(model, 'Synthetic final.', 100, false)).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
      await expect(createCentralizedCompletion([{ role: 'user', content: 'Synthetic final.' }], { model })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
      await expect(call_gpt5_strict('Synthetic final.', { model })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
      expect(nativeFetch).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    }
  );

  it.each([undefined, 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-4.1-mini']) (
    'fails unavailable/non-fine-tuned authority %p before transport', async configured => {
      delete process.env.FINETUNED_MODEL_ID;
      if (configured !== undefined) process.env.AI_MODEL = configured;
      await expect(createSingleChatCompletion(adapter, { messages: [] })).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
      await expect(createChatCompletionWithFallback(adapter, { messages: [] })).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
      await expect(callOpenAI(authority, 'Synthetic final.', 100, false)).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
      expect(nativeFetch).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    }
  );

  it('recovers provider errors through existing attempts without changing final authority', async () => {
    replies = [{ status: 503 }, { status: 503 }, { status: 503 }, {}];
    const result = await createChatCompletionWithFallback(adapter, { messages: [{ role: 'user', content: 'Synthetic final.' }] });
    expect(requests.map(request => request.model)).toEqual([authority, authority, authority, authority]);
    expect(result).toMatchObject({ activeModel: authority, fallbackFlag: true });
  });

  it('retries incomplete output through the same final authority', async () => {
    replies = [{ incomplete: true }, {}];
    const result = await createChatCompletionWithFallback(adapter, { messages: [{ role: 'user', content: 'Synthetic final.' }] });
    expect(requests.map(request => request.model)).toEqual([authority, authority]);
    expect(result.choices[0]?.finish_reason).toBe('stop');
  });

  it('keeps routine audit recovery on Luna without automatic Sol escalation', async () => {
    replies = [{ status: 503 }, { status: 503 }, { status: 503 }, {}];
    const result = await createChatCompletionWithFallback(adapter, { messages: [{ role: 'user', content: 'Synthetic audit.' }] }, 'audit');
    expect(result.activeModel).toBe('gpt-6-luna');
    expect(requests.map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna']);
  });

  it.each(['gpt-6-luna', 'gpt-6.1-sol', authority + '-different', authority.replace(':shared', ':SHARED'), null]) (
    'rejects missing/mismatched provider authority %p instead of relabeling it', async model => {
      replies = [{ model }];
      await expect(createSingleChatCompletion(adapter, { messages: [{ role: 'user', content: 'Synthetic final.' }] })).rejects.toThrow();
      expect(requests.map(request => request.model)).toEqual([authority]);
    }
  );

  it('rejects an unexpected provider model through generic completion parsing', async () => {
    replies = [{ model: 'gpt-6.1-sol' }];
    await expect(callOpenAI(authority, 'Synthetic final.', 100, false, { maxRetries: 0 })).rejects.toThrow();
    expect(requests.map(request => request.model)).toEqual([authority]);
  });

  it('does not let the reasoning helper claim a final role', async () => {
    await expect(createGPT5Reasoning(adapter, 'Synthetic final.', undefined, {
      modelRole: 'final' as GenerativeModelRole
    })).rejects.toThrow('requires a helper role');
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
