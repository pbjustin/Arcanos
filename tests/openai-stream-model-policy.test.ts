import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getOpenAIAdapter, resetOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { resetCredentialCache } from '../src/services/openai/credentialProvider.js';
import { createCentralizedCompletion } from '../src/services/openai/chatFlow/index.js';
import { executeSimulationRequest } from '../src/services/arcanos-sim.js';
import { runtime } from '../src/services/openaiRuntime.js';

const authority = 'ft:gpt-4.1:synthetic:stream-Authority';
const authorityKeys = ['FINETUNED_MODEL_ID', 'RAILWAY_FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL'];
const envKeys = [...authorityKeys, 'OPENAI_API_KEY', 'GPT5_MODEL', 'TRINITY_FINAL_MODEL'];
const messages = [{ role: 'user' as const, content: 'Synthetic streaming prompt' }];
let savedEnv: Record<string, string | undefined>;
let sentPayloads: Array<Record<string, unknown>>;
let transportSignals: AbortSignal[];
let syntheticFetch: ReturnType<typeof jest.fn<typeof fetch>>;
let sessionIds: string[];

type StreamEvent = Record<string, unknown>;

function metadataEvent(type = 'response.created', model: unknown = authority): StreamEvent {
  return { type, sequence_number: 0, response: {
    id: 'resp_synthetic_stream', object: 'response', model, status: 'in_progress', output: []
  } };
}

const deltaEvent = { type: 'response.output_text.delta', sequence_number: 1,
  item_id: 'synthetic_message', output_index: 0, content_index: 0, delta: 'Synthetic authority output' };

function encodeEvent(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(events: StreamEvent[]): Response {
  return new Response(events.map(encodeEvent).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' }
  });
}

function recordTransport(init?: RequestInit): void {
  sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  if (init?.signal) transportSignals.push(init.signal);
}

async function stream(options: Parameters<typeof createCentralizedCompletion>[1] = {}): Promise<AsyncIterable<unknown>> {
  const result = await createCentralizedCompletion(messages, { ...options, stream: true });
  if (!(Symbol.asyncIterator in result)) throw new Error('Synthetic test expected a stream');
  return result;
}

async function collect(iterable: AsyncIterable<unknown>, received: unknown[] = []): Promise<unknown[]> {
  for await (const event of iterable) received.push(event);
  return received;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  authorityKeys.forEach(key => { delete process.env[key]; });
  process.env.FINETUNED_MODEL_ID = authority;
  process.env.OPENAI_API_KEY = 'test-stream-policy-key';
  process.env.GPT5_MODEL = 'gpt-5.1';
  process.env.TRINITY_FINAL_MODEL = 'gpt-6.1-sol';
  resetCredentialCache();
  resetOpenAIAdapter();
  sentPayloads = [];
  transportSignals = [];
  sessionIds = [];
  const createSession = runtime.createSession.bind(runtime);
  jest.spyOn(runtime, 'createSession').mockImplementation(() => {
    const id = createSession();
    sessionIds.push(id);
    return id;
  });
  syntheticFetch = jest.fn<typeof fetch>(async (_input, init) => {
    recordTransport(init);
    return sseResponse([metadataEvent(), deltaEvent, metadataEvent('response.completed')]);
  });
  getOpenAIAdapter({ apiKey: 'test-stream-policy-key', maxRetries: 0, fetch: syntheticFetch });
});

afterEach(() => {
  sessionIds.forEach(id => runtime.reset(id));
  envKeys.forEach(key => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
  resetCredentialCache();
  resetOpenAIAdapter();
  jest.restoreAllMocks();
});

describe('centralized final streaming uses the actual policy and synthetic SDK transport', () => {
  it('selects configured authority and forwards the existing Responses events unchanged', async () => {
    const events = [metadataEvent(), deltaEvent, metadataEvent('response.completed')];
    expect(await collect(await stream({ max_tokens: 321, model: authority }))).toEqual(events);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({ model: authority, stream: true, store: false, max_output_tokens: 321 });
    expect(sentPayloads[0]).not.toHaveProperty('messages');
    expect(JSON.stringify(sentPayloads[0].input)).toContain(messages[0].content);
  });

  it('enforces the same streaming boundary through the production SIM module', async () => {
    const result = await executeSimulationRequest({ scenario: 'Synthetic simulation', parameters: { stream: true } });
    expect(result.mode).toBe('stream');
    if (result.mode !== 'stream') throw new Error('Synthetic test expected streaming SIM');
    expect(await collect(result.stream)).toEqual([metadataEvent(), deltaEvent, metadataEvent('response.completed')]);
    expect(sentPayloads[0]).toMatchObject({ model: authority, stream: true });
    expect(JSON.stringify(sentPayloads[0].input)).toContain('Simulate the following scenario: Synthetic simulation');
  });

  it.each(['gpt-6.1-sol', 'ft:synthetic:other', `${authority}-other`, authority.toLowerCase(), ''])
  ('rejects provider identity %s before exposing any event', async model => {
    syntheticFetch.mockImplementation(async (_input, init) => {
      recordTransport(init);
      return sseResponse([metadataEvent('response.created', model), deltaEvent]);
    });
    const received: unknown[] = [];
    await expect(collect(await stream(), received)).rejects.toThrow(/model/);
    expect(received).toEqual([]);
    expect(transportSignals[0].aborted).toBe(true);
  });

  it.each(['created-without-model', 'delta-before-metadata', 'empty'])
  ('fails closed for %s without leaking generated content', async scenario => {
    const created = metadataEvent();
    delete (created.response as Record<string, unknown>).model;
    const events = scenario === 'empty' ? []
      : scenario === 'delta-before-metadata' ? [deltaEvent, metadataEvent()]
      : [created, deltaEvent];
    syntheticFetch.mockImplementation(async (_input, init) => {
      recordTransport(init);
      return sseResponse(events);
    });
    const received: unknown[] = [];
    await expect(collect(await stream(), received)).rejects.toThrow(/model/);
    expect(received).toEqual([]);
  });

  it.each(['gpt-6.1-sol', authority.toLowerCase(), `${authority}-other`])
  ('revalidates later response metadata %s before forwarding that event or its output', async model => {
    syntheticFetch.mockImplementation(async (_input, init) => {
      recordTransport(init);
      return sseResponse([metadataEvent(), metadataEvent('response.in_progress', model), deltaEvent]);
    });
    const received: unknown[] = [];
    await expect(collect(await stream(), received)).rejects.toThrow(/model/);
    expect(received).toEqual([metadataEvent()]);
  });

  it.each(['gpt-5.1', 'gpt-6.1-sol', 'ft:synthetic:other'])
  ('rejects module override %s before invoking transport', async model => {
    await expect(stream({ model })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('rejects unavailable authority before transport without using a helper', async () => {
    delete process.env.FINETUNED_MODEL_ID;
    process.env.AI_MODEL = 'gpt-6.1-sol';
    await expect(stream()).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('keeps request cancellation linked during iteration and releases the linkage after completion', async () => {
    const parent = new AbortController();
    const iterator = (await stream({ signal: parent.signal }))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(metadataEvent());
    const reason = new Error('Synthetic stream cancellation');
    parent.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    expect(transportSignals[0].aborted).toBe(true);

    const completedParent = new AbortController();
    await collect(await stream({ signal: completedParent.signal }));
    completedParent.abort();
    expect(transportSignals[1].aborted).toBe(false);
  });

  it('closes the SDK transport when the consumer stops iterating early', async () => {
    let cancelled = false;
    syntheticFetch.mockImplementation(async (_input, init) => {
      recordTransport(init);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(encodeEvent(metadataEvent()) + encodeEvent(deltaEvent)));
        },
        cancel() { cancelled = true; }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    for await (const event of await stream()) {
      expect(event).toEqual(metadataEvent());
      break;
    }
    expect(cancelled).toBe(true);
    expect(transportSignals[0].aborted).toBe(true);
  });

  it('cancels the opened transport when closed before the first event is read', async () => {
    const iterator = (await stream())[Symbol.asyncIterator]();
    expect(transportSignals[0].aborted).toBe(false);
    expect(await iterator.return?.()).toMatchObject({ done: true });
    expect(transportSignals[0].aborted).toBe(true);
  });

  it('cancels the opened transport when an error is thrown before the first read', async () => {
    const iterator = (await stream())[Symbol.asyncIterator]();
    const error = new Error('Synthetic consumer failure');
    await expect(iterator.throw?.(error)).rejects.toBe(error);
    expect(transportSignals[0].aborted).toBe(true);
  });
});
