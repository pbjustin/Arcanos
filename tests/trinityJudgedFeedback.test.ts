import { describe, expect, it, jest } from '@jest/globals';

type TrinityJudgedFeedbackModule = typeof import('../src/core/logic/trinityJudgedFeedback.js');

interface TrinityJudgedFeedbackHarness {
  module: TrinityJudgedFeedbackModule;
  getEnvBooleanMock: jest.Mock;
  processJudgedResponseFeedbackMock: jest.Mock;
}

/**
 * Load Trinity judged-feedback module with isolated env/persistence mocks.
 *
 * Purpose: verify deterministic gating and mapping logic without DB/network side effects.
 * Inputs/outputs: optional enabled flag + process result override -> module and mocks.
 * Edge cases: resets module state between tests to avoid stale environment behavior.
 */
async function loadTrinityJudgedFeedbackHarness(options?: {
  enabled?: boolean;
  allowedSourceEndpoints?: string;
  processResult?: Record<string, unknown>;
  processThrows?: boolean;
}): Promise<TrinityJudgedFeedbackHarness> {
  jest.resetModules();

  const getEnvBooleanMock = jest.fn((_key: string, defaultValue: boolean) => {
    if (typeof options?.enabled === 'boolean') {
      return options.enabled;
    }
    return defaultValue;
  });

  const processJudgedResponseFeedbackMock = jest.fn(async () => {
    if (options?.processThrows) {
      throw new Error('persist failure');
    }
    return options?.processResult ?? {
      traceId: 'trace-default',
      accepted: true,
      score: 8.4,
      scoreScale: '0-10',
      normalizedScore: 0.84,
      persisted: true
    };
  });

  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnvBoolean: getEnvBooleanMock,
    getEnvNumber: (_key: string, fallback: number) => fallback,
    getEnv: (key: string, fallback?: string) => {
      if (key === 'TRINITY_JUDGED_ALLOWED_ENDPOINTS') {
        return options?.allowedSourceEndpoints ?? fallback;
      }
      return fallback;
    }
  }));
  jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({
    processJudgedResponseFeedback: processJudgedResponseFeedbackMock
  }));

  const module = await import('../src/core/logic/trinityJudgedFeedback.js');
  return {
    module,
    getEnvBooleanMock,
    processJudgedResponseFeedbackMock
  };
}

describe('trinityJudgedFeedback', () => {
  it('skips persistence when feature is disabled', async () => {
    const harness = await loadTrinityJudgedFeedbackHarness({ enabled: false });

    const summary = await harness.module.recordTrinityJudgedFeedback({
      requestId: 'req-1',
      prompt: 'prompt',
      response: 'response',
      clearAudit: {
        clarity: 4,
        leverage: 4,
        efficiency: 4,
        alignment: 4,
        resilience: 4,
        overall: 4
      },
      tier: 'simple'
    });

    expect(summary).toMatchObject({
      enabled: false,
      attempted: false,
      reason: 'disabled_by_env'
    });
    expect(harness.processJudgedResponseFeedbackMock).not.toHaveBeenCalled();
  });

  it('skips when CLEAR audit is unavailable', async () => {
    const harness = await loadTrinityJudgedFeedbackHarness({ enabled: true });

    const summary = await harness.module.recordTrinityJudgedFeedback({
      requestId: 'req-2',
      prompt: 'prompt',
      response: 'response',
      tier: 'complex'
    });

    expect(summary).toMatchObject({
      enabled: true,
      attempted: false,
      reason: 'clear_audit_unavailable'
    });
    expect(harness.processJudgedResponseFeedbackMock).not.toHaveBeenCalled();
  });

  it('maps CLEAR score into judged feedback payload', async () => {
    const harness = await loadTrinityJudgedFeedbackHarness({
      enabled: true,
      processResult: {
        traceId: 'trace-3',
        accepted: true,
        score: 8.2,
        scoreScale: '0-10',
        normalizedScore: 0.82,
        persisted: true
      }
    });

    const summary = await harness.module.recordTrinityJudgedFeedback({
      requestId: 'req-3',
      prompt: 'what should I do?',
      response: 'do this first',
      clearAudit: {
        clarity: 4,
        leverage: 4.5,
        efficiency: 4.1,
        alignment: 3.8,
        resilience: 4.2,
        overall: 4.1
      },
      tier: 'critical',
      sourceEndpoint: 'ask',
      sessionId: 'session-3',
      internalMode: false,
      remainingBudgetMs: 8000
    });

    expect(summary).toMatchObject({
      enabled: true,
      attempted: true,
      traceId: 'trace-3',
      accepted: true,
      scoreScale: '0-10'
    });
    expect(harness.processJudgedResponseFeedbackMock).toHaveBeenCalledTimes(1);
    const firstCallPayload = harness.processJudgedResponseFeedbackMock.mock.calls[0][0];
    expect(firstCallPayload).toMatchObject({
      requestId: 'req-3',
      prompt: 'what should I do?',
      response: 'do this first',
      scoreScale: '0-10',
      judge: 'trinity-clear-audit'
    });
    expect(firstCallPayload.score).toBeCloseTo(8.2, 3);
  });

  it('skips persistence when source endpoint is not allowlisted', async () => {
    const harness = await loadTrinityJudgedFeedbackHarness({
      enabled: true,
      allowedSourceEndpoints: 'ask,siri'
    });

    const summary = await harness.module.recordTrinityJudgedFeedback({
      requestId: 'req-allowlist-1',
      prompt: 'prompt',
      response: 'response',
      clearAudit: {
        clarity: 4,
        leverage: 4,
        efficiency: 4,
        alignment: 4,
        resilience: 4,
        overall: 4
      },
      tier: 'simple',
      sourceEndpoint: 'mcp.trinity.ask'
    });

    expect(summary).toMatchObject({
      enabled: true,
      attempted: false,
      reason: 'source_endpoint_not_allowed:mcp.trinity.ask'
    });
    expect(harness.processJudgedResponseFeedbackMock).not.toHaveBeenCalled();
  });

  it('returns non-throwing summary when persistence fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = await loadTrinityJudgedFeedbackHarness({
      enabled: true,
      processThrows: true
    });

    try {
      const summary = await harness.module.recordTrinityJudgedFeedback({
        requestId: 'req-4',
        prompt: 'prompt',
        response: 'response',
        clearAudit: {
          clarity: 2,
          leverage: 2,
          efficiency: 2,
          alignment: 2,
          resilience: 2,
          overall: 2
        },
        tier: 'simple'
      });

      expect(summary.enabled).toBe(true);
      expect(summary.attempted).toBe(true);
      expect(summary.reason).toContain('persist_failed:');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
