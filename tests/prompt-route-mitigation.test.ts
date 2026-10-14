import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  activatePromptRouteDegradedMode,
  activatePromptRouteReducedLatencyMode,
  getPromptRouteExecutionPolicy,
  getPromptRouteMitigationState,
  recordPromptRouteTimeoutIncident,
  resetPromptRouteMitigationStateForTests,
  rollbackPromptRouteMitigation
} from '../src/services/openai/promptRouteMitigation.js';

describe('temporary prompt-route mitigation lifecycle', () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    process.env = { ...originalEnvironment, NODE_ENV: 'test', ARCANOS_PROCESS_KIND: 'web' };
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T09:00:00.000Z'));
    resetPromptRouteMitigationStateForTests();
  });
  afterEach(() => {
    resetPromptRouteMitigationStateForTests();
    jest.useRealTimers();
    process.env = originalEnvironment;
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

  it.each(['reduced_latency', 'degraded_response'] as const)(
    'blocks worker-owned %s commands without claiming a web effect', mode => {
      process.env.ARCANOS_PROCESS_KIND = 'worker';
      const result = mode === 'reduced_latency'
        ? activatePromptRouteReducedLatencyMode('worker incident', 256)
        : activatePromptRouteDegradedMode('worker incident');
      expect(result).toMatchObject({ applied: false, reason: 'cross_process_prompt_route_unavailable' });
      expect(getPromptRouteExecutionPolicy(256).mode).toBe('normal');
      expect(getPromptRouteMitigationState()).toMatchObject({ active: false, mitigationId: null });
    }
  );

  it.each([
    { SELF_IMPROVE_ENABLED: 'false' },
    { SELF_IMPROVE_ACTUATOR_MODE: 'host' },
    { SELF_IMPROVE_AUTONOMY_LEVEL: '2' },
    { SELF_IMPROVE_FREEZE: 'true' }
  ])('keeps timeout observations from activating unauthorized mitigation: %j', restriction => {
    Object.assign(process.env, {
      SELF_IMPROVE_ENABLED: 'true', SELF_IMPROVE_ACTUATOR_MODE: 'daemon',
      SELF_IMPROVE_AUTONOMY_LEVEL: '3', SELF_IMPROVE_FREEZE: 'false'
    }, restriction);
    recordPromptRouteTimeoutIncident('provider', 256);
    expect(recordPromptRouteTimeoutIncident('provider', 256)).toMatchObject({
      applied: false, reason: 'automatic_mitigation_not_authorized'
    });
    expect(getPromptRouteExecutionPolicy(256).mode).toBe('normal');
  });

  it('applies an authorized local timeout mitigation to the same web consumer', () => {
    Object.assign(process.env, {
      SELF_IMPROVE_ENABLED: 'true', SELF_IMPROVE_ACTUATOR_MODE: 'daemon',
      SELF_IMPROVE_AUTONOMY_LEVEL: '3', SELF_IMPROVE_FREEZE: 'false'
    });
    recordPromptRouteTimeoutIncident('provider', 256);
    expect(recordPromptRouteTimeoutIncident('provider', 256).applied).toBe(true);
    expect(getPromptRouteExecutionPolicy(256)).toMatchObject({ mode: 'reduced_latency', maxRetries: 0 });
  });
});
