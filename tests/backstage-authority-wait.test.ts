import { describe, expect, it } from '@jest/globals';
import {
  BACKSTAGE_AUTHORITY_WAIT_MAX_MS,
  planBackstageAuthorityWait,
  readBackstageAuthorityWaitState,
} from '../src/shared/backstage/backstageAuthorityWait.js';

describe('durable protected booking authority wait', () => {
  it('covers a nine minute refresh with bounded polls and one immutable deadline after restart', () => {
    const start = Date.UTC(2026, 9, 20);
    let now = start;
    let durableState: unknown;
    let polls = 0;
    while (now < start + 9 * 60_000) {
      const plan = planBackstageAuthorityWait(durableState, now);
      expect(plan.status).toBe('defer');
      if (plan.status !== 'defer') throw new Error('Expected pending authority wait');
      expect(plan.state.deadlineAt).toBe(start + BACKSTAGE_AUTHORITY_WAIT_MAX_MS);
      expect(plan.delayMs).toBeGreaterThanOrEqual(15_000);
      expect(plan.delayMs).toBeLessThanOrEqual(30_000);
      durableState = JSON.parse(JSON.stringify({ backstageAuthorityWait: plan.state }));
      now += plan.delayMs;
      polls += 1;
    }
    expect(polls).toBeLessThanOrEqual(19);
    expect(readBackstageAuthorityWaitState(durableState)).toMatchObject({ startedAt: start });
    expect(planBackstageAuthorityWait(durableState, start + BACKSTAGE_AUTHORITY_WAIT_MAX_MS)).toEqual({ status: 'expired' });
  });

  it('keeps concurrent job deadlines independent and clamps the last poll to expiry', () => {
    const first = planBackstageAuthorityWait(null, 1_000);
    const second = planBackstageAuthorityWait(null, 61_000);
    if (first.status !== 'defer' || second.status !== 'defer') throw new Error('Expected wait');
    expect(second.state.deadlineAt - first.state.deadlineAt).toBe(60_000);
    expect(planBackstageAuthorityWait({ backstageAuthorityWait: first.state }, first.state.deadlineAt - 100)).toMatchObject({ delayMs: 100 });
  });

  it.each([
    { version: 2, startedAt: 1_000, deadlineAt: 721_000, pollCount: 1 },
    { version: 1, startedAt: 1_000, deadlineAt: 1_000_000, pollCount: 1 },
    { version: 1, startedAt: 1_000, deadlineAt: 721_000, pollCount: -1 },
    { version: 1, startedAt: 1_000, deadlineAt: 721_000, pollCount: 1, executionClaimGeneration: '9223372036854775808' },
    null,
    'invalid',
  ])('rejects corrupt persisted state without restarting its deadline: %j', state => {
    expect(planBackstageAuthorityWait({ backstageAuthorityWait: state }, 2_000)).toEqual({ status: 'invalid' });
  });
});
