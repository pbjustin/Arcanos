import { describe, expect, it } from '@jest/globals';

import { computeGptJobLifecycleDeadlines } from '@shared/gpt/gptJobLifecycle.js';
import {
  DEFAULT_ASK_TERMINAL_RETENTION_MS,
  DEFAULT_DAG_NODE_TERMINAL_RETENTION_MS,
  MAX_NON_GPT_TERMINAL_RETENTION_MS,
  MIN_NON_GPT_TERMINAL_RETENTION_MS,
  computeQueueJobLifecycleDeadlines,
  resolveNonGptTerminalRetentionWindowMs
} from '@shared/jobs/queueJobLifecycle.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');

describe('queue job lifecycle policy', () => {
  it.each([
    ['ask', 'completed', DEFAULT_ASK_TERMINAL_RETENTION_MS],
    ['ask', 'cancelled', DEFAULT_ASK_TERMINAL_RETENTION_MS],
    ['dag-node', 'completed', DEFAULT_DAG_NODE_TERMINAL_RETENTION_MS],
    ['dag-node', 'cancelled', DEFAULT_DAG_NODE_TERMINAL_RETENTION_MS]
  ] as const)(
    'assigns the explicit %s %s retention window',
    (jobType, status, retentionWindowMs) => {
      expect(resolveNonGptTerminalRetentionWindowMs(jobType, status, {})).toBe(
        retentionWindowMs
      );
      expect(computeQueueJobLifecycleDeadlines(jobType, status, NOW, {})).toEqual({
        idempotencyUntil: null,
        retentionUntil: new Date(NOW.getTime() + retentionWindowMs).toISOString()
      });
    }
  );

  it.each([
    ['ask', 'pending'],
    ['ask', 'running'],
    ['ask', 'failed'],
    ['dag-node', 'failed'],
    ['local-agent', 'completed'],
    ['other', 'completed']
  ])('does not assign non-GPT retention to %s/%s', (jobType, status) => {
    expect(computeQueueJobLifecycleDeadlines(jobType, status, NOW, {})).toEqual({
      idempotencyUntil: null,
      retentionUntil: null
    });
  });

  it('preserves GPT lifecycle behavior exactly', () => {
    const env = {
      GPT_JOB_COMPLETED_RETENTION_MS: '7200000',
      GPT_JOB_FAILED_RETENTION_MS: '3600000',
      GPT_JOB_CANCELLED_RETENTION_MS: '1800000',
      GPT_IDEMPOTENCY_RETENTION_MS: '900000'
    } as NodeJS.ProcessEnv;

    for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled', 'expired']) {
      expect(computeQueueJobLifecycleDeadlines('gpt', status, NOW, env)).toEqual(
        computeGptJobLifecycleDeadlines(status, NOW, env)
      );
    }
  });

  it('uses per-type environment values with finite safety bounds', () => {
    const env = {
      QUEUE_ASK_TERMINAL_RETENTION_MS: '1',
      QUEUE_DAG_NODE_TERMINAL_RETENTION_MS: String(90 * 24 * 60 * 60 * 1_000)
    } as NodeJS.ProcessEnv;

    expect(resolveNonGptTerminalRetentionWindowMs('ask', 'completed', env)).toBe(
      MIN_NON_GPT_TERMINAL_RETENTION_MS
    );
    expect(resolveNonGptTerminalRetentionWindowMs('dag-node', 'cancelled', env)).toBe(
      MAX_NON_GPT_TERMINAL_RETENTION_MS
    );
  });

  it('falls back per type for invalid duration values', () => {
    const env = {
      QUEUE_ASK_TERMINAL_RETENTION_MS: 'not-a-number',
      QUEUE_DAG_NODE_TERMINAL_RETENTION_MS: '0'
    } as NodeJS.ProcessEnv;

    expect(resolveNonGptTerminalRetentionWindowMs('ask', 'completed', env)).toBe(
      DEFAULT_ASK_TERMINAL_RETENTION_MS
    );
    expect(resolveNonGptTerminalRetentionWindowMs('dag-node', 'completed', env)).toBe(
      DEFAULT_DAG_NODE_TERMINAL_RETENTION_MS
    );
  });
});
