import { afterEach, describe, expect, it } from '@jest/globals';

import {
  GPT_ROUTE_HARD_TIMEOUT_BOUNDS,
  resolveGptRouteHardTimeoutMs,
} from '../src/shared/http/gptRouteTimeout.js';

const ORIGINAL_GPT_ROUTE_HARD_TIMEOUT_MS = process.env.GPT_ROUTE_HARD_TIMEOUT_MS;
const ORIGINAL_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS =
  process.env.GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_GPT_ROUTE_HARD_TIMEOUT_MS === undefined) {
    delete process.env.GPT_ROUTE_HARD_TIMEOUT_MS;
  } else {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = ORIGINAL_GPT_ROUTE_HARD_TIMEOUT_MS;
  }

  if (ORIGINAL_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS === undefined) {
    delete process.env.GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS;
  } else {
    process.env.GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS =
      ORIGINAL_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS;
  }
});

describe('resolveGptRouteHardTimeoutMs', () => {
  it('honors the configured default-profile timeout up to sixty seconds', () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '60000';

    expect(resolveGptRouteHardTimeoutMs()).toBe(60_000);
    expect(resolveGptRouteHardTimeoutMs({ profile: 'default' })).toBe(60_000);
    expect(GPT_ROUTE_HARD_TIMEOUT_BOUNDS.maxMs).toBe(60_000);
  });

  it('keeps enforcing the minimum default-profile timeout', () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '1000';

    expect(resolveGptRouteHardTimeoutMs()).toBe(5_000);
  });

  it('allows explicit callers to raise the default-profile fallback when no env override is configured', () => {
    expect(resolveGptRouteHardTimeoutMs({ defaultMsOverride: 25_750 })).toBe(25_750);
  });

  it('keeps honoring an explicit env timeout over the query_and_wait fallback override', () => {
    process.env.GPT_ROUTE_HARD_TIMEOUT_MS = '5000';

    expect(resolveGptRouteHardTimeoutMs({ defaultMsOverride: 25_750 })).toBe(5_000);
  });

  it('keeps the dag-execution timeout clamp unchanged', () => {
    process.env.GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS = '60000';

    expect(resolveGptRouteHardTimeoutMs({ profile: 'dag_execution' })).toBe(10_000);
  });
});
