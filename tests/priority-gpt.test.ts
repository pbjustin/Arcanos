import { describe, expect, it } from '@jest/globals';
import {
  isPriorityQueueLaneJob,
  isPriorityGpt,
  mapGptJobStatusToClientStatus,
  resolveGptDirectExecutionThresholdMs,
  resolveGptJobMaxRetries,
  resolveGptWaitTimeoutMs,
  resolvePriorityQueueWeight
} from '../src/shared/gpt/priorityGpt.js';
import {
  resolvePriorityQueueClaimLane
} from '../src/core/db/repositories/jobRepository.js';

describe('priority GPT classification and scheduling config', () => {
  it('classifies built-in and configured GPT IDs as priority', () => {
    expect(isPriorityGpt('arcanos-build', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isPriorityGpt('GUIDE', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isPriorityGpt('custom-ops', {
      PRIORITY_GPT_IDS: 'custom-ops'
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(isPriorityGpt('ordinary-gpt', {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('normalizes priority queue env defaults', () => {
    const env = {
      PRIORITY_QUEUE_WEIGHT: '7',
      GPT_DIRECT_EXECUTION_THRESHOLD_MS: '9000',
      GPT_WAIT_TIMEOUT_MS: '24000',
      GPT_JOB_MAX_RETRIES: '1'
    } as NodeJS.ProcessEnv;

    expect(resolvePriorityQueueWeight(env)).toBe(7);
    expect(resolveGptDirectExecutionThresholdMs(env)).toBe(9000);
    expect(resolveGptWaitTimeoutMs(env)).toBe(24000);
    expect(resolveGptJobMaxRetries(env)).toBe(1);
  });

  it('uses weighted fair scheduling after priority jobs reach the configured weight', () => {
    expect(resolvePriorityQueueClaimLane({
      priorityQueueEnabled: true,
      priorityQueueWeight: 5,
      priorityClaimsSinceNormal: 4
    })).toBe('priority');
    expect(resolvePriorityQueueClaimLane({
      priorityQueueEnabled: true,
      priorityQueueWeight: 5,
      priorityClaimsSinceNormal: 5
    })).toBe('normal');
    expect(resolvePriorityQueueClaimLane({
      priorityQueueEnabled: false,
      priorityQueueWeight: 5,
      priorityClaimsSinceNormal: 99
    })).toBe('priority');
  });

  it('maps terminal GPT job statuses without reporting failures as completed', () => {
    expect(mapGptJobStatusToClientStatus('completed')).toBe('completed');
    expect(mapGptJobStatusToClientStatus('running')).toBe('running');
    expect(mapGptJobStatusToClientStatus('pending')).toBe('queued');
    expect(mapGptJobStatusToClientStatus('timeout')).toBe('timeout');
    expect(mapGptJobStatusToClientStatus('expired')).toBe('timeout');
    expect(mapGptJobStatusToClientStatus('failed')).toBe('failed');
    expect(mapGptJobStatusToClientStatus('cancelled')).toBe('cancelled');
  });

  it('classifies priority queue lane jobs with the configured priority threshold', () => {
    expect(isPriorityQueueLaneJob({
      job_type: 'gpt',
      priority: 3
    }, 3)).toBe(true);
    expect(isPriorityQueueLaneJob({
      job_type: 'gpt',
      priority: 4
    }, 3)).toBe(false);
  });
});
