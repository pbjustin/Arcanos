import { describe, expect, it, jest } from '@jest/globals';
import type OpenAI from 'openai';
import { createSelfHealingInferenceClient } from '../src/services/selfImprove/selfHealingInferenceClient.js';

describe('self-healing one-call provider facade (offline fixtures)', () => {
  it('retains the original adapter method and forces bounded tokens, timeout, and zero SDK retries', async () => {
    const create = jest.fn(async () => ({ id: 'fixture-response' }));
    const original = { responses: { create } } as unknown as OpenAI;
    const bounded = createSelfHealingInferenceClient(original);
    await bounded.client.responses.create({ model: 'fixture-model', input: 'fixture prompt', max_output_tokens: 8000 }, {
      maxRetries: 10, timeout: 120_000
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_output_tokens: 512, stream: false }),
      expect.objectContaining({ maxRetries: 0, timeout: 30_000 }));
    expect(original.responses.create).toBe(create);
    expect(bounded.wasRequested()).toBe(true);
    expect(bounded.isPending()).toBe(false);
    expect(bounded.getFailure()).toBe(null);
  });

  it('claims the one-call budget before awaiting and refuses concurrent or sequential expansion', async () => {
    let resolveRequest!: (value: unknown) => void;
    const create = jest.fn(() => new Promise(resolve => { resolveRequest = resolve; }));
    const bounded = createSelfHealingInferenceClient({ responses: { create } } as unknown as OpenAI);
    const pending = bounded.client.responses.create({ model: 'fixture-model', input: 'first' });
    expect(bounded.isPending()).toBe(true);
    await expect(bounded.client.responses.create({ model: 'fixture-model', input: 'concurrent' }))
      .rejects.toThrow('budget exhausted');
    resolveRequest({ id: 'fixture-response' });
    await pending;
    await expect(bounded.client.responses.create({ model: 'fixture-model', input: 'fallback' }))
      .rejects.toThrow('budget exhausted');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps an authentication failure visible even when callers catch it and request a fallback', async () => {
    const authenticationFailure = Object.assign(new Error('Synthetic invalid credential'), { status: 401 });
    const create = jest.fn(async () => { throw authenticationFailure; });
    const bounded = createSelfHealingInferenceClient({ responses: { create } } as unknown as OpenAI);
    await expect(bounded.client.responses.create({ model: 'fixture-model', input: 'fixture' })).rejects.toBe(authenticationFailure);
    await expect(bounded.client.responses.create({ model: 'fixture-model', input: 'retry' })).rejects.toThrow('budget exhausted');
    expect(bounded.getFailure()).toBe(authenticationFailure);
    expect(bounded.isPending()).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps smaller caller limits, refuses streaming, and leaves other clients unchanged', async () => {
    const create = jest.fn(async () => ({}));
    const original = { responses: { create } } as unknown as OpenAI;
    const bounded = createSelfHealingInferenceClient(original);
    await expect(bounded.client.responses.create({ model: 'fixture', input: 'fixture', stream: true }))
      .rejects.toThrow('non-streaming');
    expect(create).not.toHaveBeenCalled();
    await bounded.client.responses.create({ model: 'fixture', input: 'fixture', max_output_tokens: 16 }, { timeout: 4000 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_output_tokens: 16 }),
      expect.objectContaining({ timeout: 4000, maxRetries: 0 }));
    await original.responses.create({ model: 'fixture', input: 'unrelated' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
