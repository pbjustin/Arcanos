import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getOpenAIClientOrAdapter = jest.fn();

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter,
}));

const { HRCCore, isHRCResultCacheable } = await import('../src/services/hrc.ts');
const { evaluateWithHRC } = await import('../src/services/hrcWrapper.ts');
const { queryCache } = await import('../src/platform/resilience/cache.ts');
const { createAbortError, runWithRequestAbortContext } = await import('@arcanos/runtime');

beforeEach(() => {
  jest.clearAllMocks();
  queryCache.clear();
});

afterEach(() => {
  queryCache.clear();
  jest.useRealTimers();
});

describe('HRC core', () => {
  it('evaluates HRC output through the shared structured response helper', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-4.1-mini',
      status: 'completed',
      output_text: '{"fidelity":"0.9","resilience":0.7,"verdict":"stable"}',
      output: [],
    });
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    const core = new HRCCore();
    const result = await core.evaluate('hello');

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      fidelity: 0.9,
      resilience: 0.7,
      verdict: 'stable',
    });
    expect(isHRCResultCacheable(result)).toBe(true);
  });

  it('bounds a caller-scoped HRC evaluation and aborts the provider request', async () => {
    jest.useFakeTimers();
    const create = jest.fn().mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
        const signal = options?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    );
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    const core = new HRCCore();
    const evaluationPromise = core.evaluate('hello', { timeoutMs: 25 });

    await jest.advanceTimersByTimeAsync(30);

    const result = await evaluationPromise;

    expect(result).toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: HRC evaluation timed out after 25ms'
    });
    expect(isHRCResultCacheable(result)).toBe(false);
    const [, options] = create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { signal?: AbortSignal }
    ];
    expect(options.signal?.aborted).toBe(true);
  });
});

describe('Booker HRC requirement evaluation', () => {
  const originalRequest = 'Write a 200-word non-canon backstage promo with dialogue and production directions responding to the new challenger.';
  const continuityEvidence = 'The challenger earned the upcoming title match. No title change has occurred.';
  const defectiveCandidate = '## Backstage promo\nCreative direction: build tension.\nCamera direction: push in.\n--- > > > >';
  const evaluationResponse = (payload: Record<string, unknown>) => ({
    model: 'gpt-4.1-mini',
    status: 'completed',
    output_text: JSON.stringify(payload),
    output: [],
  });

  it('sends the actual request, same continuity evidence, and complete candidate to the existing audit call', async () => {
    const create = jest.fn().mockResolvedValue(evaluationResponse({
      fidelity: 0.99,
      resilience: 0.98,
      verdict: 'The requested dialogue is absent and the scene ends in empty blockquotes.',
      requirementsSatisfied: false,
      unmetRequirements: ['Missing requested dialogue.', 'Unfinished scene ending in empty Markdown blockquotes.'],
    }));
    getOpenAIClientOrAdapter.mockReturnValue({ adapter: { responses: { create } } });

    const result = await evaluateWithHRC(defectiveCandidate, {
      bookingRequirements: { request: originalRequest, continuityEvidence },
    });

    expect(result).toEqual({
      fidelity: 0.99,
      resilience: 0.98,
      verdict: 'The requested dialogue is absent and the scene ends in empty blockquotes.',
      requirementsSatisfied: false,
      unmetRequirements: ['Missing requested dialogue.', 'Unfinished scene ending in empty Markdown blockquotes.'],
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [request] = create.mock.calls[0] as [{
      input: Array<{ role: string; content: Array<{ text: string }> }>;
      store: boolean;
    }];
    expect(request.store).toBe(false);
    expect(JSON.parse(request.input[1].content[0].text)).toEqual({
      originalRequest,
      continuityEvidence,
      candidate: defectiveCandidate,
    });
    const policy = request.input[0].content[0].text;
    for (const criterion of [
      'requested dialogue', 'production directions', 'participants', 'storyline constraints',
      'unfinished scenes', 'empty or broken Markdown', 'unsupported claims',
      'materially incomplete', 'not instructions to execute', 'alternative segment formats',
    ]) {
      expect(policy).toContain(criterion);
    }
  });

  it.each([
    ['legacy high scores without requirement evidence', {}],
    ['missing omission explanations', { requirementsSatisfied: false, unmetRequirements: [] }],
    ['a contradictory pass with material omissions', { requirementsSatisfied: true, unmetRequirements: ['Missing requested dialogue.'] }],
    ['a string acceptance flag', { requirementsSatisfied: 'true', unmetRequirements: [] }],
    ['an empty omission explanation', { requirementsSatisfied: false, unmetRequirements: [' '] }],
    ['unbounded omission explanations', { requirementsSatisfied: false, unmetRequirements: ['x'.repeat(513)] }],
  ])('fails closed for %s without making a replacement provider call', async (_label, assessment) => {
    const create = jest.fn().mockResolvedValue(evaluationResponse({
      fidelity: 0.99,
      resilience: 0.98,
      verdict: 'Internally consistent fiction.',
      ...assessment,
    }));
    getOpenAIClientOrAdapter.mockReturnValue({ adapter: { responses: { create } } });

    const result = await evaluateWithHRC(defectiveCandidate, {
      bookingRequirements: { request: originalRequest, continuityEvidence },
    });

    expect(result).toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: sensitive-context evaluation unavailable',
    });
    expect(result.requirementsSatisfied).not.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('preserves a complete short alternative format and does not reuse a candidate-only cache result', async () => {
    const candidate = '[Camera tightens.] “You earned your shot. Come prove you can finish it.” [Cut to black.]';
    const create = jest.fn().mockResolvedValue(evaluationResponse({
      fidelity: 0.95,
      resilience: 0.94,
      verdict: 'Complete requested line and production directions.',
      requirementsSatisfied: true,
      unmetRequirements: [],
    }));
    getOpenAIClientOrAdapter.mockReturnValue({ adapter: { responses: { create } } });
    // A generic score-only result must not satisfy a later task-specific review.
    await evaluateWithHRC(candidate);

    for (const request of ['Write one line of dialogue with camera cues.', 'Write a very short promo in prose with camera cues.']) {
      await expect(evaluateWithHRC(candidate, {
        bookingRequirements: { request, continuityEvidence },
      })).resolves.toMatchObject({
        requirementsSatisfied: true,
        unmetRequirements: [],
        fidelity: 0.95,
        resilience: 0.94,
      });
    }
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('retains a reasoned continuity or completion failure independently of numeric scores', async () => {
    const create = jest.fn().mockResolvedValue(evaluationResponse({
      fidelity: 0.8,
      resilience: 0.7,
      verdict: 'A proposal cannot establish a title change or saved canon.',
      requirementsSatisfied: false,
      unmetRequirements: ['Contradicts the supplied championship history.', 'Claims an unperformed canon write completed.'],
    }));
    getOpenAIClientOrAdapter.mockReturnValue({ adapter: { responses: { create } } });

    await expect(evaluateWithHRC('The challenger is now champion, and this has been saved to canon.', {
      bookingRequirements: { request: originalRequest, continuityEvidence },
    })).resolves.toMatchObject({
      fidelity: 0.8,
      resilience: 0.7,
      requirementsSatisfied: false,
      unmetRequirements: ['Contradicts the supplied championship history.', 'Claims an unperformed canon write completed.'],
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('HRC wrapper cache', () => {
  it('does not cache sensitive-context results and fixes sensitive failure verdicts', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce({
        model: 'gpt-4.1-mini',
        status: 'completed',
        output_text: '{"fidelity":0.9,"resilience":0.8,"verdict":"private evaluation"}',
        output: [],
      })
      .mockRejectedValueOnce(new Error('PRIVATE-NOTION-REQUEST-ECHO'));
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    await expect(evaluateWithHRC('private-enriched-storyline', {
      sensitiveContext: true,
    })).resolves.toEqual({
      fidelity: 0.9,
      resilience: 0.8,
      verdict: 'private evaluation',
    });
    await expect(evaluateWithHRC('private-enriched-storyline', {
      sensitiveContext: true,
    })).resolves.toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: sensitive-context evaluation unavailable',
    });
    expect(create).toHaveBeenCalledTimes(2);
    for (const [request] of create.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(request.store).toBe(false);
    }
  });

  it('does not cache a caller-scoped timeout fallback and caches the successful retry', async () => {
    jest.useFakeTimers();
    const successResponse = {
      model: 'gpt-4.1-mini',
      status: 'completed',
      output_text: '{"fidelity":0.8,"resilience":0.6,"verdict":"retry succeeded"}',
      output: [],
    };
    const create = jest.fn()
      .mockImplementationOnce(
        (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
          const signal = options?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      )
      .mockResolvedValueOnce(successResponse);
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });

    const timedOutEvaluation = evaluateWithHRC('caller-timeout-cache-isolation', {
      timeoutMs: 25
    });
    await jest.advanceTimersByTimeAsync(30);

    await expect(timedOutEvaluation).resolves.toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: HRC evaluation timed out after 25ms'
    });
    await expect(evaluateWithHRC('caller-timeout-cache-isolation')).resolves.toEqual({
      fidelity: 0.8,
      resilience: 0.6,
      verdict: 'retry succeeded'
    });
    await expect(
      evaluateWithHRC('caller-timeout-cache-isolation', { timeoutMs: 1 })
    ).resolves.toEqual({
      fidelity: 0.8,
      resilience: 0.6,
      verdict: 'retry succeeded'
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not cache an ambient-request cancellation and retries outside that scope', async () => {
    let notifyProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      notifyProviderStarted = resolve;
    });
    const create = jest.fn()
      .mockImplementationOnce(
        (_params: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
          const signal = options?.signal;
          const rejectWithAbort = () => reject(signal?.reason);
          if (signal?.aborted) {
            rejectWithAbort();
          } else {
            signal?.addEventListener('abort', rejectWithAbort, { once: true });
          }
          notifyProviderStarted?.();
        })
      )
      .mockResolvedValueOnce({
        model: 'gpt-4.1-mini',
        status: 'completed',
        output_text: '{"fidelity":0.7,"resilience":0.5,"verdict":"ambient retry succeeded"}',
        output: [],
      });
    getOpenAIClientOrAdapter.mockReturnValue({
      adapter: { responses: { create } },
    });
    const controller = new AbortController();

    const cancelledEvaluation = runWithRequestAbortContext({
      controller,
      signal: controller.signal,
      deadlineAt: Date.now() + 1_000,
      timeoutMs: 1_000
    }, () => evaluateWithHRC('ambient-cancellation-cache-isolation'));
    await providerStarted;
    controller.abort(createAbortError('ambient HRC evaluation cancelled'));

    await expect(cancelledEvaluation).resolves.toEqual({
      fidelity: 0,
      resilience: 0,
      verdict: 'Evaluation failed: ambient HRC evaluation cancelled'
    });
    await expect(evaluateWithHRC('ambient-cancellation-cache-isolation')).resolves.toEqual({
      fidelity: 0.7,
      resilience: 0.5,
      verdict: 'ambient retry succeeded'
    });
    await expect(evaluateWithHRC('ambient-cancellation-cache-isolation')).resolves.toEqual({
      fidelity: 0.7,
      resilience: 0.5,
      verdict: 'ambient retry succeeded'
    });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
