import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { unsetRuntimeEnv, writeRuntimeEnv } from '../src/platform/runtime/env.js';
import {
  getTrinitySelfHealingMitigation,
  getTrinitySelfHealingSnapshot,
  noteTrinityMitigationOutcome,
  recordTrinityStageFailure,
  resetTrinitySelfHealingStateForTests
} from '../src/services/selfImprove/selfHealingV2.js';

describe('selfHealingV2', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-24T09:00:00.000Z'));
    writeRuntimeEnv('SELF_IMPROVE_ENABLED', 'true');
    writeRuntimeEnv('SELF_IMPROVE_ACTUATOR_MODE', 'daemon');
    writeRuntimeEnv('SELF_IMPROVE_AUTONOMY_LEVEL', '3');
    unsetRuntimeEnv('SELF_IMPROVE_FREEZE');
    resetTrinitySelfHealingStateForTests();
  });

  afterEach(() => {
    resetTrinitySelfHealingStateForTests();
    unsetRuntimeEnv('SELF_IMPROVE_ENABLED');
    unsetRuntimeEnv('SELF_IMPROVE_ACTUATOR_MODE');
    unsetRuntimeEnv('SELF_IMPROVE_AUTONOMY_LEVEL');
    unsetRuntimeEnv('SELF_IMPROVE_FREEZE');
    jest.useRealTimers();
  });

  it('enables degraded mode after repeated intake aborts on simple traffic', () => {
    expect(
      recordTrinityStageFailure({
        stage: 'intake',
        error: 'Request was aborted.',
        requestId: 'req-1',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBeNull();
    expect(
      recordTrinityStageFailure({
        stage: 'intake',
        error: 'Request was aborted.',
        requestId: 'req-2',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBeNull();

    const action = recordTrinityStageFailure({
      stage: 'intake',
      error: 'Request was aborted.',
      requestId: 'req-3',
      sourceEndpoint: 'gpt.arcanos-core.query'
    });

    expect(action).toBe('enable_degraded_mode');
    expect(
      getTrinitySelfHealingMitigation({
        tier: 'simple',
        answerMode: 'explained'
      })
    ).toMatchObject({
      activeAction: 'enable_degraded_mode',
      stage: 'intake',
      forceDirectAnswer: true,
      bypassFinalStage: false
    });
  });

  it('marks a mitigation as retained after repeated success verification', () => {
    recordTrinityStageFailure({
      stage: 'final',
      error: 'Request was aborted.',
      requestId: 'req-a',
      sourceEndpoint: 'gpt.arcanos-core.query'
    });
    recordTrinityStageFailure({
      stage: 'final',
      error: 'Request was aborted.',
      requestId: 'req-b',
      sourceEndpoint: 'gpt.arcanos-core.query'
    });
    expect(
      recordTrinityStageFailure({
        stage: 'final',
        error: 'Request was aborted.',
        requestId: 'req-c',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBe('bypass_final_stage');

    noteTrinityMitigationOutcome({
      stage: 'final',
      outcome: 'success',
      requestId: 'verify-1',
      sourceEndpoint: 'gpt.arcanos-core.query',
      action: 'bypass_final_stage'
    });
    noteTrinityMitigationOutcome({
      stage: 'final',
      outcome: 'success',
      requestId: 'verify-2',
      sourceEndpoint: 'gpt.arcanos-core.query',
      action: 'bypass_final_stage'
    });
    noteTrinityMitigationOutcome({
      stage: 'final',
      outcome: 'success',
      requestId: 'verify-3',
      sourceEndpoint: 'gpt.arcanos-core.query',
      action: 'bypass_final_stage'
    });

    expect(getTrinitySelfHealingSnapshot().final.verifiedAtMs).not.toBeNull();
  });

  it('does not mark direct answer mode as a verified mitigation without a retained action', () => {
    expect(
      getTrinitySelfHealingMitigation({
        tier: 'simple',
        answerMode: 'direct'
      })
    ).toMatchObject({
      activeAction: null,
      stage: null,
      forceDirectAnswer: false,
      bypassFinalStage: false,
      verified: false
    });
  });

  it('rolls back a failed intake mitigation and honors cooldown without repeating the same action', () => {
    recordTrinityStageFailure({
      stage: 'intake',
      error: 'Request was aborted.',
      requestId: 'req-1',
      sourceEndpoint: 'gpt.arcanos-core.query'
    });
    recordTrinityStageFailure({
      stage: 'intake',
      error: 'Request was aborted.',
      requestId: 'req-2',
      sourceEndpoint: 'gpt.arcanos-core.query'
    });
    expect(
      recordTrinityStageFailure({
        stage: 'intake',
        error: 'Request was aborted.',
        requestId: 'req-3',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBe('enable_degraded_mode');

    expect(
      recordTrinityStageFailure({
        stage: 'intake',
        error: 'Request was aborted.',
        requestId: 'req-4',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBe('enable_degraded_mode');
    expect(
      recordTrinityStageFailure({
        stage: 'intake',
        error: 'Request was aborted.',
        requestId: 'req-5',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBeNull();

    const snapshot = getTrinitySelfHealingSnapshot().intake;
    expect(snapshot.activeAction).toBeNull();
    expect(snapshot.failedActions).toContain('enable_degraded_mode');
    expect(snapshot.cooldownUntilMs).not.toBeNull();

    jest.advanceTimersByTime(2 * 60_000 + 1);
    expect(
      recordTrinityStageFailure({
        stage: 'intake',
        error: 'Request was aborted.',
        requestId: 'req-6',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBeNull();
  });
});
