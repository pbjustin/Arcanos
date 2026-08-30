import { describe, expect, it } from '@jest/globals';

import {
  resolveBackstageNotionSnapshotStatus,
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
