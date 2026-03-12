import { afterEach, describe, expect, it } from '@jest/globals';

import {
  DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
  QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME,
  getQueryFinetuneAttemptLatencyBudgetDiagnostics,
  resolveQueryFinetuneAttemptLatencyBudgetMs
} from '@config/queryFinetune.js';

describe('query finetune latency budget config', () => {
  const originalConfiguredLatencyBudgetMs =
    process.env[QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME];

  afterEach(() => {
    if (originalConfiguredLatencyBudgetMs === undefined) {
      delete process.env[QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME];
      return;
    }

    process.env[QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME] =
      originalConfiguredLatencyBudgetMs;
  });

  it('uses the shared default when no override is configured', () => {
    delete process.env[QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME];

    expect(resolveQueryFinetuneAttemptLatencyBudgetMs()).toBe(
      DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS
    );
    expect(getQueryFinetuneAttemptLatencyBudgetDiagnostics()).toEqual(
      expect.objectContaining({
        configuredValue: null,
        resolvedValueMs: DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
        source: 'default',
        usedFallbackDefault: true
      })
    );
  });

  it('accepts a bounded environment override for startup and route consumers', () => {
    process.env[QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME] = '15000';

    expect(resolveQueryFinetuneAttemptLatencyBudgetMs()).toBe(15_000);
    expect(getQueryFinetuneAttemptLatencyBudgetDiagnostics()).toEqual(
      expect.objectContaining({
        configuredValue: '15000',
        resolvedValueMs: 15_000,
        source: 'environment',
        usedFallbackDefault: false
      })
    );
  });

  it('falls back to the default when the configured override is out of bounds', () => {
    process.env[QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME] = '999999';

    expect(resolveQueryFinetuneAttemptLatencyBudgetMs()).toBe(
      DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS
    );
    expect(getQueryFinetuneAttemptLatencyBudgetDiagnostics()).toEqual(
      expect.objectContaining({
        configuredValue: '999999',
        resolvedValueMs: DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
        source: 'invalid-environment-fallback',
        usedFallbackDefault: true
      })
    );
  });
});
