import { describe, expect, it } from '@jest/globals';

import {
  resolveBackstageNotionSnapshotStatus,
  resolveBackstageNotionSnapshotStatusObservation,
  type BackstageNotionLatestSyncAttemptState,
} from '../src/shared/backstage/backstageNotionSnapshotStatus.js';

const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-29T16:00:00.000Z');
const VERIFIED_AT = new Date('2026-08-29T15:55:00.000Z');

function attempt(
  outcome: BackstageNotionLatestSyncAttemptState['outcome'],
  options: Partial<BackstageNotionLatestSyncAttemptState> = {}
): BackstageNotionLatestSyncAttemptState {
  return {
    attemptId: '33333333-3333-4333-8333-333333333333',
    startedAt: new Date('2026-08-29T15:56:00.000Z'),
    completedAt: outcome === 'running'
      ? null
      : new Date('2026-08-29T15:58:00.000Z'),
    outcome,
    activatedSnapshotId: outcome === 'activated' || outcome === 'unchanged'
      ? SNAPSHOT_ID
      : null,
    failurePhase: outcome === 'failed' ? 'chunking' : null,
    failureReason: outcome === 'failed' ? 'chunk_limit_reached' : null,
    ...options,
  };
}

function resolve(options: Parameters<
  typeof resolveBackstageNotionSnapshotStatus
>[0] extends infer Input ? Partial<Input> : never = {}) {
  return resolveBackstageNotionSnapshotStatus({
    activeSnapshotId: SNAPSHOT_ID,
    activeSnapshotReadable: true,
    activeSnapshotVerifiedAt: VERIFIED_AT,
    now: NOW,
    maximumStalenessMs: 60 * 60 * 1_000,
    latestSyncAttempt: attempt('unchanged'),
    ...options,
  });
}

describe('Backstage Notion snapshot status projection', () => {
  it.each([
    ['current successful snapshot', attempt('unchanged'), 60 * 60 * 1_000],
    ['newer failed refresh', attempt('failed'), 60 * 60 * 1_000],
    ['newer running refresh', attempt('running'), 60 * 60 * 1_000],
    ['stale successful snapshot', attempt('unchanged'), 60_000],
    ['no latest attempt', null, 60 * 60 * 1_000],
  ] as const)(
    'keeps the identifier-free observation resolver in parity for %s',
    (_label, latestSyncAttempt, maximumStalenessMs) => {
      const identifierResult = resolve({
        latestSyncAttempt,
        maximumStalenessMs,
      });
      const observationResult = resolveBackstageNotionSnapshotStatusObservation({
        activeSnapshotPresent: true,
        activeSnapshotReadable: true,
        activeSnapshotVerifiedAt: VERIFIED_AT,
        now: NOW,
        maximumStalenessMs,
        latestSyncAttempt: latestSyncAttempt === null
          ? null
          : {
              startedAt: latestSyncAttempt.startedAt,
              completedAt: latestSyncAttempt.completedAt,
              outcome: latestSyncAttempt.outcome,
              successfulSnapshotMatchesActive:
                latestSyncAttempt.activatedSnapshotId === null
                  ? null
                  : latestSyncAttempt.activatedSnapshotId === SNAPSHOT_ID,
              failurePhase: latestSyncAttempt.failurePhase,
              failureReason: latestSyncAttempt.failureReason,
            },
      });

      expect(observationResult).toEqual(identifierResult);
    }
  );

  it('fails the identifier-free resolver closed on malformed success state', () => {
    expect(resolveBackstageNotionSnapshotStatusObservation({
      activeSnapshotPresent: true,
      activeSnapshotReadable: true,
      activeSnapshotVerifiedAt: VERIFIED_AT,
      now: NOW,
      maximumStalenessMs: 60 * 60 * 1_000,
      latestSyncAttempt: {
        startedAt: new Date('2026-08-29T15:56:00.000Z'),
        completedAt: new Date('2026-08-29T15:58:00.000Z'),
        outcome: 'unchanged',
        successfulSnapshotMatchesActive: null,
        failurePhase: null,
        failureReason: null,
      },
    })).toEqual({
      status: 'unavailable',
      fresh: false,
      newerRefreshIncomplete: false,
    });
  });

  it('reports a fresh readable snapshot after a successful refresh as current_complete', () => {
    expect(resolve()).toEqual({
      status: 'current_complete',
      fresh: true,
      newerRefreshIncomplete: false,
    });
  });

  it('reports a readable prior snapshot after a newer failed refresh as last_known_good', () => {
    expect(resolve({ latestSyncAttempt: attempt('failed') })).toEqual({
      status: 'last_known_good',
      fresh: true,
      newerRefreshIncomplete: true,
    });
  });

  it('marks a fresh active snapshot last_known_good while a newer candidate is building', () => {
    expect(resolve({ latestSyncAttempt: attempt('running') })).toEqual({
      status: 'last_known_good',
      fresh: true,
      newerRefreshIncomplete: true,
    });
  });

  it('reports a stale but readable active snapshot as last_known_good', () => {
    expect(resolve({ maximumStalenessMs: 60_000 })).toEqual({
      status: 'last_known_good',
      fresh: false,
      newerRefreshIncomplete: false,
    });
  });

  it.each([
    { activeSnapshotId: null },
    { activeSnapshotReadable: false },
    { activeSnapshotVerifiedAt: null },
    { maximumStalenessMs: -1 },
  ])('reports missing, unreadable, or invalid active state as unavailable', override => {
    expect(resolve(override)).toEqual({
      status: 'unavailable',
      fresh: false,
      newerRefreshIncomplete: false,
    });
  });

  it('never labels a successful attempt for a different active snapshot as current', () => {
    for (const outcome of ['activated', 'unchanged'] as const) {
      expect(resolve({
        latestSyncAttempt: attempt(outcome, {
          activatedSnapshotId: '44444444-4444-4444-8444-444444444444',
        }),
      }).status).toBe('last_known_good');
    }
  });

  it('does not let an older failed attempt downgrade a newer verified snapshot', () => {
    expect(resolve({
      latestSyncAttempt: attempt('failed', {
        startedAt: new Date('2026-08-29T15:50:00.000Z'),
      }),
    }).status).toBe('current_complete');
  });

  it('fails unavailable on malformed latest-attempt timestamps', () => {
    expect(resolve({
      latestSyncAttempt: attempt('failed', {
        completedAt: new Date(Number.NaN),
      }),
    }).status).toBe('unavailable');
  });

  it('fails unavailable on internally inconsistent latest-attempt state', () => {
    expect(resolve({
      latestSyncAttempt: attempt('unchanged', {
        activatedSnapshotId: null,
      }),
    }).status).toBe('unavailable');
    expect(resolve({
      latestSyncAttempt: attempt('failed', {
        failurePhase: null,
      }),
    }).status).toBe('unavailable');
    expect(resolve({
      latestSyncAttempt: attempt('running', {
        completedAt: new Date('2026-08-29T15:58:00.000Z'),
      }),
    }).status).toBe('unavailable');
  });
});
