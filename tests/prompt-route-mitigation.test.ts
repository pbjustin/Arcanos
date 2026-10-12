import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  activatePromptRouteDegradedMode,
  activatePromptRouteReducedLatencyMode,
  getPromptRouteExecutionPolicy,
  getPromptRouteMitigationState,
  resetPromptRouteMitigationStateForTests,
  rollbackPromptRouteMitigation
} from '../src/services/openai/promptRouteMitigation.js';

describe('temporary prompt-route mitigation lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T09:00:00.000Z'));
    resetPromptRouteMitigationStateForTests();
  });
  afterEach(() => {
    resetPromptRouteMitigationStateForTests();
    jest.useRealTimers();
  });

  it.each(['reduced_latency', 'degraded_response'] as const)(
    'expires %s and restores the consumer execution policy without controller traffic', mode => {
      if (mode === 'reduced_latency') activatePromptRouteReducedLatencyMode('bounded incident', 256);
      else activatePromptRouteDegradedMode('bounded incident');
      expect(getPromptRouteExecutionPolicy(256).mode).toBe(mode);
      jest.advanceTimersByTime(10 * 60_000 - 1);
      expect(getPromptRouteExecutionPolicy(256).mode).toBe(mode);
      jest.advanceTimersByTime(1);
      expect(getPromptRouteExecutionPolicy(256)).toMatchObject({
        mode: 'normal', maxTokens: 256, useFallbackModel: false, bypassedSubsystems: []
      });
      expect(getPromptRouteMitigationState()).toMatchObject({ active: false, mode: null });
    }
  );

  it('does not let a same-clock older verification clear a replacement mitigation', () => {
    const first = activatePromptRouteReducedLatencyMode('first incident', 256);
    const replacement = activatePromptRouteDegradedMode('replacement incident');
    expect(replacement.applied).toBe(true);
    expect(rollbackPromptRouteMitigation('stale verification', first.state.mitigationId)).toMatchObject({
      rolledBack: false, reason: 'mitigation_id_mismatch'
    });
    expect(getPromptRouteExecutionPolicy(256).mode).toBe('degraded_response');
  });
});
