import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMPARISON_LIMITS, parseComparisonArguments, runModelLaneComparison
} from '../scripts/compare-trinity-model-lanes.mjs';

const executeOptions = { execute: true, confirmNonProduction: true, evaluationTarget: 'https://api.openai.com/v1' };
const runnerPath = fileURLToPath(new URL('../scripts/compare-trinity-model-lanes.mjs', import.meta.url));

describe('historical model-lane comparison remains offline', () => {
  it('retains a zero-call historical dry plan with unmeasured metrics and only hashes/counts for inputs', async () => {
    const create = jest.fn(() => { throw new Error('Provider creation is forbidden in dry mode'); });
    const report = await runModelLaneComparison({ runtime: { createOpenAIAdapter: create } });
    expect(create).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      execution: 'dry_run', syntheticOnly: true, historicalOnly: true,
      summary: { attempted: 0, schemaValidRate: null, timeoutRate: null }
    });
    expect(report.limits).toEqual(COMPARISON_LIMITS);
    expect(report.results).toHaveLength(6);
    expect(report.results.map(result => result.model)).toEqual([
      'gpt-5.6-terra', 'gpt-6.1-sol', 'gpt-4.1-mini', 'gpt-6-luna', 'gpt-4.1', 'gpt-6-luna'
    ]);
    expect(report.results.every(result =>
      !result.attempted && result.status === 'not_run' && result.latencyMs === null && result.clearOutcome === null
    )).toBe(true);
    expect(report.results.every(result => /^[a-f0-9]{64}$/.test(result.fixtureHash))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('fictional crate');
  });

  it('rejects arbitrary inputs and conflicting execution arguments', () => {
    expect(parseComparisonArguments([])).toEqual({});
    expect(() => parseComparisonArguments(['--input', 'private-data.json'])).toThrow('UNSUPPORTED_ARGUMENT');
    expect(() => parseComparisonArguments(['--execute', '--dry-run'])).toThrow('CONFLICTING_EXECUTION_MODE');
    expect(parseComparisonArguments(['--execute', '--confirm-non-production', '--evaluation-target', executeOptions.evaluationTarget]))
      .toEqual(executeOptions);
  });

  it.each([
    { execute: true },
    executeOptions,
    { ...executeOptions, evaluationTarget: 'https://private.example.com/v1' }
  ])('rejects historical execution before dynamic runtime loading for %p', async options => {
    await expect(runModelLaneComparison(options)).rejects.toThrow('HISTORICAL_MODEL_COMPARISON_DISABLED');
  });

  it('rejects even an injected runtime before reading credentials, context or any transport', async () => {
    const fetch = jest.fn(() => { throw new Error('Native provider transport must remain unused'); });
    const create = jest.fn(() => { throw new Error('Provider adapter must remain uncreated'); });
    const getEnv = jest.fn(() => { throw new Error('Credentials and runtime context must remain unread'); });
    const runtime = { fetch, createOpenAIAdapter: create, getEnv };
    await expect(runModelLaneComparison({ ...executeOptions, runtime }))
      .rejects.toThrow('HISTORICAL_MODEL_COMPARISON_DISABLED');
    expect(getEnv).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails the native execute CLI without runtime imports or provider evaluation output', () => {
    const result = spawnSync(process.execPath, [
      runnerPath, '--execute', '--confirm-non-production', '--evaluation-target', executeOptions.evaluationTarget
    ], { encoding: 'utf8', timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('MODEL_LANE_COMPARISON_BLOCKED: no provider or credential details are logged.\n');
  });

  it('keeps the native dry CLI descriptive and provider-free', () => {
    const result = spawnSync(process.execPath, [runnerPath, '--dry-run'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ execution: 'dry_run', historicalOnly: true, summary: { attempted: 0 } });
    expect(report.results.every((item: { attempted: boolean }) => item.attempted === false)).toBe(true);
  });
});
