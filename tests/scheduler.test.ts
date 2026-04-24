import { describe, expect, it } from '@jest/globals';
import {
  classifyQueueLane,
  resolveSchedulerClaimLane,
  shouldRetryJob,
  updateSchedulerClaimState
} from '../src/core/scheduler/scheduler.js';

describe('scheduler pure policy', () => {
  it('routes claims through priority until the configured weight is reached', () => {
    expect(resolveSchedulerClaimLane({
      policy: {
        priorityQueueEnabled: true,
        priorityQueueWeight: 5,
        priorityLaneMaxPriority: 10
      },
      state: {
        priorityClaimsSinceStandard: 4
      }
    })).toEqual(expect.objectContaining({
      lane: 'priority',
      reason: 'priority_weight_available'
    }));

    expect(resolveSchedulerClaimLane({
      policy: {
        priorityQueueEnabled: true,
        priorityQueueWeight: 5,
        priorityLaneMaxPriority: 10
      },
      state: {
        priorityClaimsSinceStandard: 5
      }
    })).toEqual(expect.objectContaining({
      lane: 'standard',
      reason: 'standard_weight_due'
    }));
  });

  it('classifies low numeric priorities into the priority lane', () => {
    expect(classifyQueueLane({ priority: 0, priorityLaneMaxPriority: 10 })).toBe('priority');
    expect(classifyQueueLane({ priority: 95, priorityLaneMaxPriority: 10 })).toBe('standard');
  });

  it('updates fairness state without storing database details', () => {
    expect(updateSchedulerClaimState({ priorityClaimsSinceStandard: 2 }, 'priority'))
      .toEqual({ priorityClaimsSinceStandard: 3 });
    expect(updateSchedulerClaimState({ priorityClaimsSinceStandard: 3 }, 'standard'))
      .toEqual({ priorityClaimsSinceStandard: 0 });
  });

  it('caps retries using attempts and max retries only', () => {
    expect(shouldRetryJob({ attempts: 0 }, 1)).toBe(true);
    expect(shouldRetryJob({ attempts: 1, lastError: 'timeout' }, 1)).toBe(false);
  });
});
