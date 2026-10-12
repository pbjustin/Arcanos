import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { unsetRuntimeEnv, writeRuntimeEnv } from '../src/platform/runtime/env.js';
import {
  activateTrinitySelfHealingMitigation,
  getTrinitySelfHealingMitigation,
  getTrinitySelfHealingSnapshot,
  noteTrinityMitigationOutcome,
  recordTrinityStageFailure,
  resetTrinitySelfHealingStateForTests,
  rollbackTrinitySelfHealingMitigation
} from '../src/services/selfImprove/selfHealingV2.js';

describe('selfHealingV2', () => {
  const serviceRoleKeys = ['ARCANOS_PROCESS_KIND', 'RUN_WORKERS'] as const;
  const originalServiceRole = new Map<string, string | undefined>();

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-24T09:00:00.000Z'));
    writeRuntimeEnv('SELF_IMPROVE_ENABLED', 'true');
    writeRuntimeEnv('SELF_IMPROVE_ACTUATOR_MODE', 'daemon');
    writeRuntimeEnv('SELF_IMPROVE_AUTONOMY_LEVEL', '3');
    unsetRuntimeEnv('SELF_IMPROVE_FREEZE');
    resetTrinitySelfHealingStateForTests();
    for (const key of serviceRoleKeys) {
      originalServiceRole.set(key, process.env[key]);
      unsetRuntimeEnv(key);
    }
  });

  afterEach(() => {
    resetTrinitySelfHealingStateForTests();
    unsetRuntimeEnv('SELF_IMPROVE_ENABLED');
    unsetRuntimeEnv('SELF_IMPROVE_ACTUATOR_MODE');
    unsetRuntimeEnv('SELF_IMPROVE_AUTONOMY_LEVEL');
    unsetRuntimeEnv('SELF_IMPROVE_FREEZE');
    for (const key of serviceRoleKeys) {
      const original = originalServiceRole.get(key);
      if (original === undefined) unsetRuntimeEnv(key);
      else writeRuntimeEnv(key, original);
    }
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

  it('enables degraded mode after repeated reasoning aborts on simple traffic', () => {
    expect(
      recordTrinityStageFailure({
        stage: 'reasoning',
        error: 'openai_call_aborted_due_to_budget',
        requestId: 'reasoning-1',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBeNull();
    expect(
      recordTrinityStageFailure({
        stage: 'reasoning',
        error: 'openai_call_aborted_due_to_budget',
        requestId: 'reasoning-2',
        sourceEndpoint: 'gpt.arcanos-core.query'
      })
    ).toBeNull();

    const action = recordTrinityStageFailure({
      stage: 'reasoning',
      error: 'openai_call_aborted_due_to_budget',
      requestId: 'reasoning-3',
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
      stage: 'reasoning',
      forceDirectAnswer: true,
      bypassFinalStage: false
    });
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

  it('does not let request failures activate an automatic mitigation on a suppressed web role', () => {
    writeRuntimeEnv('ARCANOS_PROCESS_KIND', 'web');
    writeRuntimeEnv('RUN_WORKERS', 'false');

    for (let index = 0; index < 5; index += 1) {
      expect(recordTrinityStageFailure({
        stage: 'reasoning',
        error: 'openai_call_aborted_due_to_budget',
        requestId: `web-role-${index}`
      })).toBeNull();
    }

    expect(getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      observations: [], attempts: 0, activeAction: null
    });
  });

  it('retains explicit mitigation, consumption and rollback on a web role', () => {
    writeRuntimeEnv('ARCANOS_PROCESS_KIND', 'web');
    writeRuntimeEnv('RUN_WORKERS', 'false');
    const command = {
      stage: 'reasoning' as const,
      action: 'enable_degraded_mode' as const,
      reason: 'authorized command fixture'
    };

    expect(activateTrinitySelfHealingMitigation(command)).toMatchObject({ applied: true });
    expect(activateTrinitySelfHealingMitigation(command)).toMatchObject({ applied: false, reason: 'already_active' });
    expect(getTrinitySelfHealingSnapshot().reasoning.attempts).toBe(1);
    expect(getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' })).toMatchObject({
      forceDirectAnswer: true, stage: 'reasoning'
    });
    expect(rollbackTrinitySelfHealingMitigation(command)).toMatchObject({ rolledBack: true });
    expect(getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' }).forceDirectAnswer).toBe(false);
  });

  it('expires an explicit mitigation exactly at its TTL and never changes complex traffic', () => {
    const result = activateTrinitySelfHealingMitigation({
      stage: 'final', action: 'bypass_final_stage', reason: 'bounded fixture'
    });
    expect(result.applied).toBe(true);
    expect(getTrinitySelfHealingMitigation({ tier: 'complex', answerMode: 'explained' })).toMatchObject({
      activeAction: null, bypassFinalStage: false
    });
    jest.setSystemTime(result.expiresAtMs! - 1);
    expect(getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' }).bypassFinalStage).toBe(true);
    jest.setSystemTime(result.expiresAtMs!);
    expect(getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' })).toMatchObject({
      activeAction: null, bypassFinalStage: false, verified: false
    });
  });

  it('does not attribute an older request outcome to a replacement of the same action', () => {
    const first = activateTrinitySelfHealingMitigation({
      stage: 'reasoning', action: 'enable_degraded_mode', reason: 'first command'
    });
    jest.setSystemTime(first.expiresAtMs!);
    const replacement = activateTrinitySelfHealingMitigation({
      stage: 'reasoning', action: 'enable_degraded_mode', reason: 'replacement command'
    });
    expect(replacement.applied).toBe(true);

    for (const outcome of ['success', 'failure'] as const) {
      noteTrinityMitigationOutcome({
        stage: 'reasoning', action: 'enable_degraded_mode', outcome,
        requestId: `old-${outcome}`, mitigationId: first.mitigationId
      });
    }
    expect(getTrinitySelfHealingSnapshot().reasoning).toMatchObject({
      activeAction: 'enable_degraded_mode', verificationSuccesses: 0, verificationFailures: 0
    });
    expect(rollbackTrinitySelfHealingMitigation({
      stage: 'reasoning', action: 'enable_degraded_mode', reason: 'old verification',
      mitigationId: first.mitigationId
    })).toMatchObject({ rolledBack: false, reason: 'mitigation_id_mismatch' });
    expect(getTrinitySelfHealingSnapshot().reasoning.activeAction).toBe('enable_degraded_mode');
  });

  it('bounds repeated failure observations after the action budget is exhausted', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    for (let index = 0; index < 1_000; index += 1) {
      recordTrinityStageFailure({
        stage: 'intake', error: 'Request was aborted.', requestId: `sustained-${index}`
      });
    }
    expect(getTrinitySelfHealingSnapshot().intake.observations.length).toBeLessThanOrEqual(3);
    expect(getTrinitySelfHealingSnapshot().intake.attempts).toBe(1);
  });
});
