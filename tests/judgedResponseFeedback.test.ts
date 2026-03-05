import { describe, expect, it, jest } from '@jest/globals';

type JudgedResponseFeedbackModule = typeof import('../src/services/judgedResponseFeedback.js');

interface JudgedResponseFeedbackHarness {
  module: JudgedResponseFeedbackModule;
  registerContextEntryMock: jest.Mock;
  saveSelfReflectionMock: jest.Mock;
  loadRecentSelfReflectionsByCategoryMock: jest.Mock;
}

/**
 * Load judged response feedback service with isolated persistence/context mocks.
 *
 * Purpose: verify judgment processing and hydration behavior without touching external services.
 * Inputs/outputs: optional persisted reflections -> module and dependency mocks.
 * Edge cases: resets module cache to avoid shared hydration state between tests.
 */
async function loadJudgedFeedbackHarness(options?: {
  persistedReflections?: Array<Record<string, unknown>>;
  cacheMaxEntries?: number;
}): Promise<JudgedResponseFeedbackHarness> {
  jest.resetModules();

  const registerContextEntryMock = jest.fn();
  const saveSelfReflectionMock = jest.fn(async () => undefined);
  const loadRecentSelfReflectionsByCategoryMock = jest.fn(async () => options?.persistedReflections ?? []);

  jest.unstable_mockModule('@services/contextualReinforcement.js', () => ({
    getReinforcementConfig: () => ({
      mode: 'reinforcement',
      window: 50,
      digestSize: 8,
      minimumClearScore: 0.85
    }),
    registerContextEntry: registerContextEntryMock
  }));

  jest.unstable_mockModule('@core/db/repositories/selfReflectionRepository.js', () => ({
    saveSelfReflection: saveSelfReflectionMock,
    loadRecentSelfReflectionsByCategory: loadRecentSelfReflectionsByCategoryMock
  }));
  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnv: (_key: string, defaultValue?: string) => defaultValue,
    getEnvNumber: (key: string, defaultValue: number) => {
      if (key === 'JUDGED_FEEDBACK_CACHE_MAX_ENTRIES') {
        return options?.cacheMaxEntries ?? defaultValue;
      }
      return defaultValue;
    },
    getEnvBoolean: (_key: string, defaultValue: boolean) => defaultValue
  }));

  const module = await import('../src/services/judgedResponseFeedback.js');
  return {
    module,
    registerContextEntryMock,
    saveSelfReflectionMock,
    loadRecentSelfReflectionsByCategoryMock
  };
}

describe('judgedResponseFeedback', () => {
  it('stores judged feedback and registers positive context for accepted scores', async () => {
    const harness = await loadJudgedFeedbackHarness();

    const result = await harness.module.processJudgedResponseFeedback(
      {
        prompt: 'How do I configure retries?',
        response: 'You can configure retries using exponential backoff.',
        score: 0.92,
        scoreScale: '0-1',
        feedback: 'Great clarity',
        improvements: ['Keep concrete examples']
      },
      'trace-001'
    );

    expect(result.accepted).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.traceId).toBe('trace-001');
    expect(harness.registerContextEntryMock).toHaveBeenCalledTimes(1);
    expect(harness.saveSelfReflectionMock).toHaveBeenCalledTimes(1);
    expect(harness.saveSelfReflectionMock.mock.calls[0][0]).toMatchObject({
      category: 'judged-response'
    });
  });

  it('rejects invalid payloads before persistence', async () => {
    const harness = await loadJudgedFeedbackHarness();

    await expect(
      harness.module.processJudgedResponseFeedback(
        {
          prompt: '',
          response: 'response text',
          score: 0.7
        },
        'trace-002'
      )
    ).rejects.toThrow('prompt');

    expect(harness.saveSelfReflectionMock).not.toHaveBeenCalled();
    expect(harness.registerContextEntryMock).not.toHaveBeenCalled();
  });

  it('suppresses duplicate judged writes within idempotency window', async () => {
    const harness = await loadJudgedFeedbackHarness();
    const untrustedMetadata = JSON.parse(
      '{"sourceEndpoint":"ask","nested":{"apiKey":"safe-value","__proto__":{"polluted":true},"constructor":{"nestedDanger":true},"safe":"value"}}'
    ) as Record<string, unknown>;
    const payload = {
      requestId: 'dup-req-1',
      prompt: 'Token sample sk-123456789012345678901234567890123456',
      response: 'Use retries with backoff.',
      score: 9.1,
      scoreScale: '0-10' as const,
      feedback: 'Concise response',
      judge: 'trinity-clear-audit',
      metadata: untrustedMetadata
    };

    const first = await harness.module.processJudgedResponseFeedback(payload, 'dup-req-1');
    const second = await harness.module.processJudgedResponseFeedback(payload, 'dup-req-1');

    expect(first).toEqual(second);
    expect(harness.saveSelfReflectionMock).toHaveBeenCalledTimes(1);
    expect(harness.registerContextEntryMock).toHaveBeenCalledTimes(1);

    const persistedMetadata = harness.saveSelfReflectionMock.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(String(persistedMetadata.prompt)).toContain('[REDACTED_OPENAI_KEY]');
    const nestedMetadata = persistedMetadata.nested as Record<string, unknown>;
    expect(nestedMetadata).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(nestedMetadata, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nestedMetadata, 'constructor')).toBe(false);
    expect(String(nestedMetadata.apiKey)).toBe('safe-value');
  });

  it('enforces idempotency cache max entries and tracks evictions', async () => {
    const harness = await loadJudgedFeedbackHarness({ cacheMaxEntries: 2 });

    await harness.module.processJudgedResponseFeedback(
      { requestId: 'cache-1', prompt: 'p1', response: 'r1', score: 9.1, scoreScale: '0-10' },
      'cache-1'
    );
    await harness.module.processJudgedResponseFeedback(
      { requestId: 'cache-2', prompt: 'p2', response: 'r2', score: 9.2, scoreScale: '0-10' },
      'cache-2'
    );
    await harness.module.processJudgedResponseFeedback(
      { requestId: 'cache-3', prompt: 'p3', response: 'r3', score: 9.3, scoreScale: '0-10' },
      'cache-3'
    );

    const telemetry = harness.module.getJudgedFeedbackRuntimeTelemetry();
    expect(telemetry.cacheMaxEntries).toBe(2);
    expect(telemetry.cacheSize).toBe(2);
    expect(telemetry.cacheEvictions).toBe(1);
    expect(telemetry.attempts).toBe(3);
  });

  it('hydrates context from persisted judged reflections only once per process', async () => {
    const harness = await loadJudgedFeedbackHarness({
      persistedReflections: [
        {
          id: 'reflection-1',
          priority: 'high',
          category: 'judged-response',
          content: 'Stored response one',
          improvements: ['Use stricter examples'],
          metadata: {
            accepted: true,
            normalizedScore: 0.93,
            requestId: 'req-1',
            feedback: 'Useful and direct'
          },
          createdAt: new Date().toISOString()
        },
        {
          id: 'reflection-2',
          priority: 'low',
          category: 'judged-response',
          content: 'Stored response two',
          improvements: [],
          metadata: {
            accepted: false,
            normalizedScore: 0.42,
            requestId: 'req-2',
            feedback: 'Too generic'
          },
          createdAt: new Date().toISOString()
        }
      ]
    });

    harness.module.resetJudgedFeedbackHydrationState();
    const hydratedFirst = await harness.module.hydrateJudgedResponseFeedbackContext(10);
    const hydratedSecond = await harness.module.hydrateJudgedResponseFeedbackContext(10);

    expect(hydratedFirst).toBe(2);
    expect(hydratedSecond).toBe(0);
    expect(harness.loadRecentSelfReflectionsByCategoryMock).toHaveBeenCalledTimes(1);
    expect(harness.registerContextEntryMock).toHaveBeenCalledTimes(2);
  });
});
