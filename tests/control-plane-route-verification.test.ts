import { describe, expect, it } from '@jest/globals';

import { verifyControlPlaneRoute } from '../src/services/controlPlane/routeVerification.js';

const fixedNow = () => new Date('2026-04-26T00:00:00.000Z');

describe('control-plane route verification', () => {
  it('keeps control-plane planning on the direct fast path even when Trinity is requested', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'plan',
        routePreference: 'prefer_trinity'
      },
      trinityResponse: {
        routingStages: [
          'ARCANOS-INTAKE:start',
          'GPT5-REASONING:complete',
          'ARCANOS-FINAL:complete'
        ],
        activeModel: 'gpt-5.1'
      },
      now: fixedNow
    });

    expect(route.requested).toBe('trinity');
    expect(route.status).toBe('DIRECT_FAST_PATH');
    expect(route.eligibleForTrinity).toBe(false);
    expect(route.evidence).toEqual({});
  });

  it('does not claim Trinity when requested metadata is present for control-plane planning', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'plan',
        routePreference: 'prefer_trinity'
      },
      trinityResponse: {
        routingStages: ['ARCANOS-DIRECT-ANSWER'],
        activeModel: 'gpt-5.1'
      },
      now: fixedNow
    });

    expect(route.status).toBe('DIRECT_FAST_PATH');
    expect(route.eligibleForTrinity).toBe(false);
    expect(route.reason).toContain('system operations');
  });

  it('uses the direct fast path for execution and mutation because those are system operations', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'execute',
        routePreference: 'prefer_trinity'
      },
      now: fixedNow
    });

    expect(route.status).toBe('DIRECT_FAST_PATH');
    expect(route.eligibleForTrinity).toBe(false);
  });

  it('does not surface Trinity planner availability for control-plane planning', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'plan',
        routePreference: 'prefer_trinity'
      },
      trinityUnavailable: true,
      trinityError: 'planner unavailable',
      now: fixedNow
    });

    expect(route.status).toBe('DIRECT_FAST_PATH');
    expect(route.eligibleForTrinity).toBe(false);
  });

  it('uses the direct fast path when planning produced no route metadata', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'plan',
        routePreference: 'prefer_trinity'
      },
      now: fixedNow
    });

    expect(route.status).toBe('DIRECT_FAST_PATH');
    expect(route.eligibleForTrinity).toBe(false);
  });
});
