import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  REQUIRED_CI_JOB_IDS,
  verifyRequiredCiResults,
} from '../scripts/verify-required-ci-results.mjs';

function buildResults(result = 'success') {
  return Object.fromEntries(
    REQUIRED_CI_JOB_IDS.map(jobId => [jobId, { result, outputs: {} }])
  );
}

function runVerifierCli(results) {
  return spawnSync(
    process.execPath,
    ['scripts/verify-required-ci-results.mjs'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ARCANOS_REQUIRED_CI_RESULTS_JSON: JSON.stringify(results),
      },
      timeout: 10_000,
    }
  );
}

describe('required CI aggregate result verifier', () => {
  it('accepts the exact required job set only when every result is success', () => {
    expect(verifyRequiredCiResults(JSON.stringify(buildResults())))
      .toHaveLength(REQUIRED_CI_JOB_IDS.length);
  });

  it('executes the CLI entrypoint and exits zero for the exact successful set', () => {
    const result = runVerifierCli(buildResults());

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Verified ${REQUIRED_CI_JOB_IDS.length} required CI job results as success.`
    );
    expect(result.stderr).toBe('');
  });

  it('executes the CLI entrypoint and exits nonzero for a skipped dependency', () => {
    const results = buildResults();
    results['local-agent-postgres-concurrency'] = {
      result: 'skipped',
      outputs: {},
    };

    const result = runVerifierCli(results);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'local-agent-postgres-concurrency=skipped'
    );
  });

  it.each(['failure', 'cancelled', 'skipped', 'missing-result'])(
    'rejects a %s dependency result',
    result => {
      const results = buildResults();
      results['local-agent-postgres-concurrency'] = result === 'missing-result'
        ? { outputs: {} }
        : { result, outputs: {} };

      expect(() => verifyRequiredCiResults(JSON.stringify(results))).toThrow(
        `local-agent-postgres-concurrency=${result}`
      );
    }
  );

  it('rejects missing and unexpected dependencies', () => {
    const results = buildResults();
    delete results['runtime-redis-admission'];
    results['unreviewed-new-job'] = { result: 'success', outputs: {} };

    expect(() => verifyRequiredCiResults(JSON.stringify(results))).toThrow(
      'missing=runtime-redis-admission unexpected=unreviewed-new-job'
    );
  });

  it.each([undefined, '', 'not-json', '[]'])(
    'rejects an absent or malformed result envelope: %s',
    value => {
      expect(() => verifyRequiredCiResults(value)).toThrow();
    }
  );
});
