import { afterEach, describe, expect, it } from '@jest/globals';

import {
  DEFAULT_DAG_MAX_TOKEN_BUDGET,
  DEFAULT_DAG_NODE_TIMEOUT_MS,
  DEFAULT_DAG_QUEUE_CLAIM_GRACE_MS,
  DEFAULT_PLANNER_MAX_RETRIES,
  DEFAULT_PLANNER_RETRY_BACKOFF_MS,
  DEFAULT_WORKER_TRINITY_RUNTIME_BUDGET_MS,
  DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS,
  getWorkerExecutionLimits,
} from '../src/workers/workerExecutionLimits.js';

const ORIGINAL_ENV = { ...process.env };
const LIMIT_ENV_KEYS = [
  'WORKER_TRINITY_RUNTIME_BUDGET_MS',
  'WORKER_TRINITY_STAGE_TIMEOUT_MS',
  'DAG_MAX_TOKEN_BUDGET',
  'DAG_NODE_TIMEOUT_MS',
  'DAG_QUEUE_CLAIM_GRACE_MS',
  'PLANNER_TIMEOUT_MS',
  'PLANNER_MAX_RETRIES',
  'PLANNER_RETRY_BACKOFF_MS',
] as const;

function resetLimitEnvironment(): void {
  process.env = { ...ORIGINAL_ENV };
  for (const key of LIMIT_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  resetLimitEnvironment();
});

describe('getWorkerExecutionLimits', () => {
  it('returns documented defaults when no overrides are configured', () => {
    resetLimitEnvironment();

    expect(getWorkerExecutionLimits()).toEqual({
      workerTrinityRuntimeBudgetMs: DEFAULT_WORKER_TRINITY_RUNTIME_BUDGET_MS,
      workerTrinityStageTimeoutMs: DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS,
      dagMaxTokenBudget: DEFAULT_DAG_MAX_TOKEN_BUDGET,
      dagNodeTimeoutMs: DEFAULT_DAG_NODE_TIMEOUT_MS,
      dagQueueClaimGraceMs: DEFAULT_DAG_QUEUE_CLAIM_GRACE_MS,
      plannerTimeoutMs: DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS,
      plannerMaxRetries: DEFAULT_PLANNER_MAX_RETRIES,
      plannerRetryBackoffMs: DEFAULT_PLANNER_RETRY_BACKOFF_MS,
    });
  });

  it('reads valid environment overrides and preserves zero retry budgets', () => {
    resetLimitEnvironment();
    process.env.WORKER_TRINITY_RUNTIME_BUDGET_MS = '510000';
    process.env.WORKER_TRINITY_STAGE_TIMEOUT_MS = '210000';
    process.env.DAG_MAX_TOKEN_BUDGET = '320000';
    process.env.DAG_NODE_TIMEOUT_MS = '480000';
    process.env.DAG_QUEUE_CLAIM_GRACE_MS = '150000';
    process.env.PLANNER_TIMEOUT_MS = '90000';
    process.env.PLANNER_MAX_RETRIES = '0';
    process.env.PLANNER_RETRY_BACKOFF_MS = '2500';

    expect(getWorkerExecutionLimits()).toEqual({
      workerTrinityRuntimeBudgetMs: 510000,
      workerTrinityStageTimeoutMs: 210000,
      dagMaxTokenBudget: 320000,
      dagNodeTimeoutMs: 480000,
      dagQueueClaimGraceMs: 150000,
      plannerTimeoutMs: 90000,
      plannerMaxRetries: 0,
      plannerRetryBackoffMs: 2500,
    });
  });

  it('falls back to safe defaults when environment overrides are invalid', () => {
    resetLimitEnvironment();
    process.env.WORKER_TRINITY_RUNTIME_BUDGET_MS = '0';
    process.env.WORKER_TRINITY_STAGE_TIMEOUT_MS = '-1';
    process.env.DAG_MAX_TOKEN_BUDGET = 'invalid';
    process.env.DAG_NODE_TIMEOUT_MS = '';
    process.env.DAG_QUEUE_CLAIM_GRACE_MS = 'NaN';
    process.env.PLANNER_TIMEOUT_MS = '0';
    process.env.PLANNER_MAX_RETRIES = '-1';
    process.env.PLANNER_RETRY_BACKOFF_MS = '0';

    expect(getWorkerExecutionLimits()).toEqual({
      workerTrinityRuntimeBudgetMs: DEFAULT_WORKER_TRINITY_RUNTIME_BUDGET_MS,
      workerTrinityStageTimeoutMs: DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS,
      dagMaxTokenBudget: DEFAULT_DAG_MAX_TOKEN_BUDGET,
      dagNodeTimeoutMs: DEFAULT_DAG_NODE_TIMEOUT_MS,
      dagQueueClaimGraceMs: DEFAULT_DAG_QUEUE_CLAIM_GRACE_MS,
      plannerTimeoutMs: DEFAULT_WORKER_TRINITY_STAGE_TIMEOUT_MS,
      plannerMaxRetries: DEFAULT_PLANNER_MAX_RETRIES,
      plannerRetryBackoffMs: DEFAULT_PLANNER_RETRY_BACKOFF_MS,
    });
  });

  it('prefers explicit call-site overrides over environment values', () => {
    resetLimitEnvironment();
    process.env.WORKER_TRINITY_RUNTIME_BUDGET_MS = '510000';
    process.env.WORKER_TRINITY_STAGE_TIMEOUT_MS = '210000';
    process.env.DAG_MAX_TOKEN_BUDGET = '320000';
    process.env.DAG_NODE_TIMEOUT_MS = '480000';
    process.env.DAG_QUEUE_CLAIM_GRACE_MS = '150000';
    process.env.PLANNER_TIMEOUT_MS = '90000';
    process.env.PLANNER_MAX_RETRIES = '5';
    process.env.PLANNER_RETRY_BACKOFF_MS = '2500';

    expect(getWorkerExecutionLimits({
      workerTrinityRuntimeBudgetMs: 600000,
      workerTrinityStageTimeoutMs: 240000,
      dagMaxTokenBudget: 400000,
      dagNodeTimeoutMs: 540000,
      dagQueueClaimGraceMs: 180000,
      plannerTimeoutMs: 120000,
      plannerMaxRetries: 3,
      plannerRetryBackoffMs: 5000,
    })).toEqual({
      workerTrinityRuntimeBudgetMs: 600000,
      workerTrinityStageTimeoutMs: 240000,
      dagMaxTokenBudget: 400000,
      dagNodeTimeoutMs: 540000,
      dagQueueClaimGraceMs: 180000,
      plannerTimeoutMs: 120000,
      plannerMaxRetries: 3,
      plannerRetryBackoffMs: 5000,
    });
  });
});
