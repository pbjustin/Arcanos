import { describe, expect, it } from '@jest/globals';

import { verifyControlPlaneRoute } from '../src/services/controlPlane/routeVerification.js';

const fixedNow = () => new Date('2026-04-26T00:00:00.000Z');

describe('control-plane route verification', () => {
  it('confirms Trinity only when trace metadata contains the required pipeline stages', () => {
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

    expect(route.status).toBe('TRINITY_CONFIRMED');
    expect(route.eligibleForTrinity).toBe(true);
    expect(route.evidence.routingStages).toHaveLength(3);
  });

  it('does not claim Trinity when requested metadata is missing Trinity stages', () => {
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

    expect(route.status).toBe('TRINITY_REQUESTED_BUT_NOT_CONFIRMED');
    expect(route.reason).toContain('did not prove Trinity pipeline involvement');
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

  it('reports Trinity as unavailable when planning cannot run the planner', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'plan',
        routePreference: 'prefer_trinity'
      },
      trinityUnavailable: true,
      trinityError: 'planner unavailable',
      now: fixedNow
    });

    expect(route.status).toBe('TRINITY_UNAVAILABLE');
    expect(route.reason).toBe('planner unavailable');
  });

  it('uses UNKNOWN_ROUTE when planning produced no route metadata and no explicit failure', () => {
    const route = verifyControlPlaneRoute({
      request: {
        phase: 'plan',
        routePreference: 'prefer_trinity'
      },
      now: fixedNow
    });

    expect(route.status).toBe('UNKNOWN_ROUTE');
  });
});
