import { describe, expect, it } from '@jest/globals';
import {
  buildQueuedGptBackstageMutationAdmission,
  buildQueuedGptJobInput,
  parseQueuedGptJobInput
} from '../src/shared/gpt/asyncGptJob.js';
import {
  GPT_HEALTH_ECHO_ACTION,
  isQueuedBridgeSmokeJobInput
} from '../src/shared/gpt/bridgeSmoke.js';

describe('async GPT job payload helpers', () => {
  it('bounds route metadata to the worker parser contract', () => {
    const longValue = 'x'.repeat(129);

    const payload = buildQueuedGptJobInput({
      gptId: 'arcanos-core',
      body: {},
      requestId: longValue,
      traceId: longValue,
      correlationId: longValue,
      routeHint: 'query',
      requestPath: '/gpt/arcanos-core'
    });

    expect(payload.requestId).toHaveLength(128);
    expect(payload.traceId).toHaveLength(128);
    expect(payload.correlationId).toHaveLength(128);
    expect(parseQueuedGptJobInput(payload).ok).toBe(true);
  });

  it('recognizes only queued jobs with a supported bridge smoke action', () => {
    expect(isQueuedBridgeSmokeJobInput({
      bridgeSmoke: true,
      bridgeAction: GPT_HEALTH_ECHO_ACTION
    })).toBe(true);
    expect(isQueuedBridgeSmokeJobInput({
      bridgeSmoke: true
    })).toBe(false);
    expect(isQueuedBridgeSmokeJobInput({
      bridgeAction: GPT_HEALTH_ECHO_ACTION
    })).toBe(false);
  });

  it('round-trips only schema-valid server-owned Backstage mutation admission', () => {
    const backstageMutationAdmission = buildQueuedGptBackstageMutationAdmission({
      action: 'updateRoster',
      principalId: 'operator:queued-backstage-test',
    });
    const payload = buildQueuedGptJobInput({
      gptId: 'backstage',
      body: { action: 'updateRoster', payload: [] },
      backstageMutationAdmission,
    });

    expect(parseQueuedGptJobInput(payload)).toEqual({
      ok: true,
      value: expect.objectContaining({ backstageMutationAdmission }),
    });
    expect(parseQueuedGptJobInput({
      ...payload,
      backstageMutationAdmission: {
        ...backstageMutationAdmission,
        source: 'caller-supplied',
      },
    })).toMatchObject({ ok: false });
  });

  it('preserves persisted mutation action drift for worker mismatch enforcement', () => {
    const backstageMutationAdmission = buildQueuedGptBackstageMutationAdmission({
      action: 'updateRoster',
      principalId: 'operator:queued-backstage-test',
    });

    expect(parseQueuedGptJobInput({
      gptId: 'backstage',
      body: { action: 'trackStoryline', payload: {} },
      backstageMutationAdmission,
    })).toMatchObject({
      ok: true,
      value: {
        body: { action: 'trackStoryline', payload: {} },
        backstageMutationAdmission,
      },
    });
  });
});
