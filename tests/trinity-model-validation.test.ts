import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createAbortError, runWithRequestAbortContext } from '@arcanos/runtime';
import { createOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { runThroughBrain } from '../src/core/logic/trinity.js';
import { validateModel } from '../src/core/logic/trinityStages.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';

const intakeModel = 'gpt-6-luna';
const modelUrl = `https://api.openai.com/v1/models/${intakeModel}`;
const authority = 'ft:gpt-4.1:synthetic:validation-authority';
const cacheTtlMs = 10 * 60_000;
const budget = () => createRuntimeBudgetWithLimit(20_000, 0);
const metadata = () => Response.json({ id: intakeModel, object: 'model', created: 1, owned_by: 'fixture' });

/** Exercise the real SDK and adapter with an entirely local transport. */
function fixture(scope: string, lookup: (signal?: AbortSignal) => Response | Promise<Response> = metadata) {
  const fetch = jest.fn<typeof globalThis.fetch>(async (input, options) => {
    if (String(input) !== modelUrl || options?.method !== 'GET') {
      throw new Error('Unexpected generation in offline metadata fixture');
    }
    return lookup(options.signal ?? undefined);
  });
  const client = createOpenAIAdapter({ apiKey: `fixture-only-${scope}`, baseURL: 'https://api.openai.com/v1',
    maxRetries: 0, timeout: 10_000, fetch }).getClient();
  return { client, fetch };
}

/** Let the transport announce entry before the test cancels or advances time. */
function pendingLookup() {
  let announce!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { announce = resolve; });
  return {
    started,
    lookup(signal?: AbortSignal): Promise<Response> {
      if (!signal) throw new Error('The SDK omitted the validation abort signal');
      announce(signal);
      return new Promise((_resolve, reject) => {
        const cancel = () => reject(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    }
  };
}

function requestContext(controller: AbortController) {
  return { controller, signal: controller.signal, deadlineAt: Date.now() + 20_000, timeoutMs: 20_000 };
}

describe('Trinity intake model availability validation', () => {
  let clock = Date.now();
  let previousAuthority: string | undefined;

  beforeEach(() => {
    // Advance beyond the preceding fixture's cache lifetime without real waiting.
    clock += cacheTtlMs * 2;
    jest.useFakeTimers({ now: clock });
    previousAuthority = process.env.FINETUNED_MODEL_ID;
    process.env.FINETUNED_MODEL_ID = authority;
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (previousAuthority === undefined) delete process.env.FINETUNED_MODEL_ID;
    else process.env.FINETUNED_MODEL_ID = previousAuthority;
  });

  it('reuses successful metadata for the same client until expiry while honoring a spent budget', async () => {
    const lane = fixture('cache');
    await expect(validateModel(lane.client, budget())).resolves.toBe(intakeModel);
    await expect(validateModel(lane.client, budget())).resolves.toBe(intakeModel);
    expect(lane.fetch).toHaveBeenCalledTimes(1);

    const spent = createRuntimeBudgetWithLimit(1, 0);
    jest.advanceTimersByTime(1);
    await expect(validateModel(lane.client, spent)).rejects.toMatchObject({ name: 'RuntimeBudgetExceededError' });
    expect(lane.fetch).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(cacheTtlMs - 1);
    await expect(validateModel(lane.client, budget())).resolves.toBe(intakeModel);
    expect(lane.fetch).toHaveBeenCalledTimes(2);
  });

  it('checks a separate client before starting any Gaming generation even when the model ID was validated elsewhere', async () => {
    const allowed = fixture('allowed');
    const denied = fixture('denied', () => Response.json({ error: { message: 'Fixture model unavailable to this client',
      code: 'model_not_found' } }, { status: 404 }));
    await expect(validateModel(allowed.client, budget())).resolves.toBe(intakeModel);

    const failure = await runThroughBrain(denied.client, 'Assess the supplied fixture guide and explain its starting steps.',
      undefined, undefined, { disableMemoryAccess: true, disableOptionalSideEffects: true,
        sourceEndpoint: 'arcanos-gaming.guide', gamingGuideIntakePolicy: 'compact-v1', gamingPresentationPolicy: 'gaming-clear-presentation/v1' },
      budget()).catch((error: unknown) => error);
    expect(denied.fetch.mock.calls.map(([url, options]) => [String(url), options?.method])).toEqual([[modelUrl, 'GET']]);
    expect(failure).toMatchObject({ message: expect.stringContaining('Fixture model unavailable to this client') });

    // A later explicit attempt still checks the provider after a failed lookup.
    await expect(validateModel(denied.client, budget())).rejects.toThrow('Fixture model unavailable to this client');
    expect(denied.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an already cancelled request when the same client has cached metadata', async () => {
    const lane = fixture('cached-cancellation');
    await expect(validateModel(lane.client, budget())).resolves.toBe(intakeModel);
    const controller = new AbortController();
    controller.abort(createAbortError('Fixture request cancelled'));
    await expect(runWithRequestAbortContext(requestContext(controller), () => validateModel(lane.client, budget())))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(lane.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation to an in-flight metadata request and leaves it uncached', async () => {
    const pending = pendingLookup();
    const lookup = jest.fn<(signal?: AbortSignal) => Promise<Response> | Response>(metadata)
      .mockImplementationOnce(pending.lookup);
    const lane = fixture('inflight-cancellation', lookup);
    const controller = new AbortController();
    const result = expect(runWithRequestAbortContext(requestContext(controller), () => validateModel(lane.client, budget())))
      .rejects.toMatchObject({ name: 'AbortError' });

    const signal = await pending.started;
    controller.abort(createAbortError('Fixture request cancelled'));
    await result;
    expect(signal.aborted).toBe(true);
    await expect(validateModel(lane.client, budget())).resolves.toBe(intakeModel);
    expect(lane.fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds metadata timeout by the remaining runtime budget and aborts the SDK transport', async () => {
    const pending = pendingLookup();
    const lane = fixture('timeout', pending.lookup);
    const result = expect(validateModel(lane.client, createRuntimeBudgetWithLimit(80, 20), 2_000))
      .rejects.toThrow('Trinity model validation timed out after 60ms');
    const signal = await pending.started;
    await jest.advanceTimersByTimeAsync(59);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await result;
    expect(signal.aborted).toBe(true);
    expect(lane.fetch).toHaveBeenCalledTimes(1);
  });
});
