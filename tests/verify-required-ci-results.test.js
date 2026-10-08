import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  REQUIRED_CI_JOB_IDS,
  verifyRequiredCiResults,
  summarizeRequiredCiResults,
} from '../scripts/verify-required-ci-results.mjs';
import { collectCiVerificationReceipts, createBoundedActionsReader, CI_RECEIPT_LIMITS,
  writeCiVerificationReceipts } from '../scripts/ci-verification-receipt.mjs';

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

const receiptContext = { repository: 'pbjustin/Arcanos', prNumber: 1530, prCommitCount: 4,
  headSha: 'a'.repeat(40), baseSha: 'e'.repeat(40), aggregateCheckoutSha: 'f'.repeat(40), runId: 100, runAttempt: 1,
  nodeVersion: 'v24.18.1', npmVersion: '11.16.0',
  verifierStepOutcome: 'success',
  ...summarizeRequiredCiResults(JSON.stringify(buildResults())) };
const receiptShas = ['a', 'b', 'c', 'd'].map(value => value.repeat(40));

function metadataFixture() {
  return jest.fn(async path => {
    const parentIndex = receiptShas.findIndex(sha => path.endsWith(`/commits/${sha}`));
    if (parentIndex >= 0) return { sha: receiptShas[parentIndex], parents: [{ sha: receiptShas[parentIndex + 1] }] };
    const sha = receiptShas.find(value => path.includes(`head_sha=${value}`));
    const index = sha ? receiptShas.indexOf(sha) : Number(/\/runs\/(\d+)\/attempts/u.exec(path)?.[1]) - 100;
    const attempt = Number(/\/attempts\/(\d+)/u.exec(path)?.[1]);
    const run = { id: 100 + index, head_sha: receiptShas[index], event: 'pull_request',
      repository: { full_name: receiptContext.repository }, head_repository: { full_name: receiptContext.repository },
      pull_requests: [{ number: 1530, head: { sha: receiptShas[index] }, base: { sha: receiptContext.baseSha } }],
      run_attempt: attempt || (index === 1 ? 2 : 1), status: 'completed',
      conclusion: index === 1 && attempt === 1 ? 'cancelled' : index === 2 ? 'failure' : 'success',
      privateValue: 'synthetic-test-receipt-sentinel', html_url: 'https://private.invalid/error' };
    if (sha) return { total_count: 1, workflow_runs: [run] };
    if (path.includes('/jobs?')) return { total_count: 1, jobs: [{ id: 400 + index, run_id: 100 + index, name: 'Local Agent Sandbox (Linux)',
      status: 'completed', conclusion: run.conclusion, started_at: '2026-10-08T16:00:00Z',
      steps: [{ number: 1, name: 'synthetic-test-receipt-sentinel', status: 'completed', conclusion: 'skipped' }],
      privateValue: 'synthetic-test-receipt-sentinel' }] };
    return run;
  });
}

describe('bounded sanitized per-SHA CI verification receipts', () => {
  it('keeps strict dependency verdicts separate from unfinished aggregate and upload status', async () => {
    const results = buildResults(); results.test.outputs.privateValue = 'synthetic-test-receipt-sentinel';
    const summary = summarizeRequiredCiResults(JSON.stringify(results));
    const receipts = await collectCiVerificationReceipts({ ...receiptContext, ...summary }, metadataFixture());
    expect(receipts.map(receipt => receipt.commitSha)).toEqual(receiptShas);
    expect(receipts[0].currentAggregate).toMatchObject({ requiredDependencyVerdict: 'PASS', workflowConclusion: 'IN_PROGRESS',
      aggregateConclusion: 'IN_PROGRESS', artifactUploadConclusion: 'NOT_YET_EXECUTED',
      prHeadSha: receiptContext.headSha, prBaseSha: receiptContext.baseSha,
      aggregateCheckoutSha: receiptContext.aggregateCheckoutSha, dependencyCheckoutSha: 'UNKNOWN' });
    expect(receipts[0].currentAggregate.runtimeVersions).toEqual({ node: 'v24.18.1', npm: '11.16.0' });
    expect(receipts[0].currentAggregate.commands).toContainEqual({ command: 'node scripts/verify-required-ci-results.mjs',
      outcome: 'success', proofSource: 'GitHub steps.required-results.outcome' });
    expect(receipts[0].attempts[0].conclusion).toBe('IN_PROGRESS');
    expect(JSON.stringify(receipts)).not.toMatch(/synthetic-test-receipt-sentinel|private\.invalid|outputs/u);
  });

  it('retains failed and cancelled attempts alongside passing successors without claiming rerun counts or checkout', async () => {
    const receipts = await collectCiVerificationReceipts(receiptContext, metadataFixture());
    expect(receipts[1].attempts.map(attempt => attempt.conclusion)).toEqual(['cancelled', 'success']);
    expect(receipts[2].attempts[0].conclusion).toBe('failure');
    for (const receipt of receipts) for (const attempt of receipt.attempts) {
      expect(attempt.aggregateCheckoutSha).toBe('UNKNOWN');
      expect(attempt.jobs[0]).toMatchObject({ executionInThisAttempt: 'UNKNOWN', testCounts: 'UNKNOWN', checkoutSha: 'UNKNOWN' });
      expect(attempt.jobs[0].steps[0].conclusion).toBe('skipped');
    }
  });

  it('binds historical commits to immutable run head_sha when the PR association advances', async () => {
    const base = metadataFixture();
    const receipts = await collectCiVerificationReceipts(receiptContext, async path => {
      const value = await base(path);
      for (const run of value.workflow_runs ?? [value]) if (run.pull_requests)
        run.pull_requests[0].head.sha = receiptContext.headSha;
      return value;
    });
    expect(receipts[2].attempts[0]).toMatchObject({ conclusion: 'failure', prHeadSha: receiptShas[2], prBaseSha: 'UNKNOWN' });
    expect(receipts[1].attempts.map(attempt => attempt.conclusion)).toEqual(['cancelled', 'success']);
  });

  it('projects dependency and runtime context fields without retaining arbitrary supplied objects', async () => {
    const receipts = await collectCiVerificationReceipts({ ...receiptContext,
      nodeVersion: 'synthetic-test-receipt-sentinel', npmVersion: { secret: 'synthetic-test-receipt-sentinel' },
      requiredDependencies: [{ jobId: 'test', result: 'synthetic-test-receipt-sentinel', outputs: { secret: 'synthetic-test-receipt-sentinel' } },
        { jobId: 'synthetic-test-receipt-sentinel', result: 'success' }] }, metadataFixture());
    expect(receipts[0].currentAggregate.requiredDependencies).toEqual([{ jobId: 'test', result: 'UNKNOWN' }]);
    expect(JSON.stringify(receipts)).not.toContain('synthetic-test-receipt-sentinel');
  });

  it('retains a known attempt failure even when job metadata is unavailable or oversized', async () => {
    const base = metadataFixture();
    const receipts = await collectCiVerificationReceipts(receiptContext, async path => path.includes('/jobs?')
      ? { total_count: 101, jobs: [] } : base(path));
    expect(receipts[2]).toMatchObject({ historyStatus: 'UNAVAILABLE', attempts: [expect.objectContaining({ conclusion: 'failure',
      metadataStatus: 'AVAILABLE', jobsMetadataStatus: 'UNAVAILABLE', jobs: [] })] });
  });

  it.each(['run', 'job'])('rejects unrelated %s metadata instead of relabeling it as the requested attempt', async kind => {
    const base = metadataFixture();
    const receipts = await collectCiVerificationReceipts(receiptContext, async path => {
      const value = await base(path);
      if (path.includes('/jobs?') && kind === 'job') value.jobs[0].run_id = 999;
      else if (path.includes('/attempts/') && !path.includes('/jobs?') && kind === 'run') value.id = 999;
      return value;
    });
    expect(receipts[2].historyStatus).toBe('UNAVAILABLE');
    expect(receipts[2].attempts[0].jobsMetadataStatus).toBe('UNAVAILABLE');
    expect(receipts[2].attempts[0].jobs).toEqual([]);
    expect(receipts[2].attempts[0].conclusion).toBe(kind === 'run' ? 'UNKNOWN' : 'failure');
  });

  it('accepts reused jobs from the same run and projects unknown/prototype job names as finite classifications', async () => {
    const base = metadataFixture();
    const receipts = await collectCiVerificationReceipts(receiptContext, async path => {
      const value = await base(path);
      if (value.jobs) Object.assign(value.jobs[0], { name: 'constructor', run_attempt: 1 });
      return value;
    });
    expect(receipts[1].attempts[1]).toMatchObject({ metadataStatus: 'AVAILABLE', jobsMetadataStatus: 'AVAILABLE',
      jobs: [expect.objectContaining({ jobId: 'UNRECOGNIZED', executionInThisAttempt: 'UNKNOWN' })] });
  });

  it.each(['skipped', 'failure', 'private-outcome-sentinel'])('records verifier command outcome independently: %s', async outcome => {
    const receipts = await collectCiVerificationReceipts({ ...receiptContext, verifierStepOutcome: outcome }, metadataFixture());
    expect(receipts[0].currentAggregate.commands[0].outcome).toBe(outcome === 'private-outcome-sentinel' ? 'UNKNOWN' : outcome);
    expect(receipts[0].currentAggregate.commands[1].outcome).toBe('IN_PROGRESS');
    expect(JSON.stringify(receipts)).not.toContain('private-outcome-sentinel');
  });

  it.each(['failure', 'cancelled', 'skipped', 'invalid-private-sentinel'])('preserves a non-success dependency verdict: %s', result => {
    const results = buildResults(); results.test.result = result;
    const summary = summarizeRequiredCiResults(JSON.stringify(results));
    expect(summary.dependencyVerdict).toBe('FAIL');
    expect(summary.requiredDependencies.find(job => job.jobId === 'test').result).toBe(result === 'invalid-private-sentinel' ? 'UNKNOWN' : result);
  });

  it('marks unavailable history explicitly and never retains native API error material', async () => {
    const api = async () => { throw new Error('synthetic-test-receipt-sentinel https://private.invalid/error'); };
    const receipts = await collectCiVerificationReceipts(receiptContext, api);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ancestryStatus: 'UNAVAILABLE', historyStatus: 'UNAVAILABLE', attempts: [] });
    expect(JSON.stringify(receipts)).not.toContain('synthetic-test-receipt-sentinel');
  });

  it.each(['wrong-subject', 'ambiguous-parents'])('does not admit historical SHAs from %s commit metadata', async kind => {
    const base = metadataFixture();
    const receipts = await collectCiVerificationReceipts(receiptContext, async path => {
      const value = await base(path);
      if (path.includes('/commits/')) {
        if (kind === 'wrong-subject') value.sha = receiptContext.baseSha;
        else value.parents.push({ sha: receiptContext.baseSha });
      }
      return value;
    });
    expect(receipts.map(receipt => receipt.commitSha)).toEqual([receiptContext.headSha]);
    expect(receipts[0].ancestryStatus).toBe('UNAVAILABLE');
  });

  it('excludes unrelated PR runs and marks bounded run, attempt and job history incomplete', async () => {
    const base = metadataFixture();
    const receipts = await collectCiVerificationReceipts({ ...receiptContext, prCommitCount: 1 }, async path => {
      const value = await base(path);
      if (value.workflow_runs) return { total_count: 20, workflow_runs: [
        { ...value.workflow_runs[0], id: 999, pull_requests: [{ number: 42 }] },
        { ...value.workflow_runs[0], run_attempt: 4 },
      ] };
      return value;
    });
    expect(receipts[0].historyStatus).toBe('BOUNDED_INCOMPLETE');
    expect(receipts[0].attempts.map(attempt => attempt.attempt)).toEqual([1, 2, 3]);
    expect(receipts[0].attempts.every(attempt => attempt.runId === 100)).toBe(true);
    expect(receipts[0].attempts.every(attempt => attempt.jobs.every(job => job.jobId === 'local-agent-sandbox-linux'))).toBe(true);
  });

  it('does not invoke acquisition or write files without explicit receipt opt-in', async () => {
    expect(await writeCiVerificationReceipts({}, {})).toBe(0);
  });

  it('rejects an unavailable receipt CLI context without printing native errors or credentials', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-required-ci-results.mjs', '--write-receipts'], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env,
        ARCANOS_CI_RECEIPTS_ENABLED: 'true', GITHUB_ACTIONS: 'false', GITHUB_TOKEN: 'private-token-sentinel',
        GITHUB_EVENT_PATH: '/private-error-sentinel/missing.json' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('CI receipt generation unavailable.\n');
    expect(result.stdout + result.stderr).not.toMatch(/private-token-sentinel|private-error-sentinel/u);
  });

  it('bounds response bytes and sanitizes HTTP failure outcomes', async () => {
    const read = createBoundedActionsReader('private-token-sentinel', async () => new Response('x'.repeat(CI_RECEIPT_LIMITS.responseBytes + 1)));
    await expect(read('/repos/pbjustin/Arcanos/actions/runs/100')).rejects.toThrow('CI_RECEIPT_API_UNAVAILABLE');
    const denied = createBoundedActionsReader('private-token-sentinel', async () => new Response('private-error-body', { status: 403 }));
    await expect(denied('/repos/pbjustin/Arcanos/actions/runs/100')).rejects.toThrow('CI_RECEIPT_API_UNAVAILABLE');
  });

  it('bounds the number of metadata requests', async () => {
    const fetcher = jest.fn(async () => new Response('{}'));
    const read = createBoundedActionsReader('private-token-sentinel', fetcher);
    for (let index = 0; index < CI_RECEIPT_LIMITS.requests; index += 1) await read('/repos/pbjustin/Arcanos/actions/runs/100');
    await expect(read('/repos/pbjustin/Arcanos/actions/runs/100')).rejects.toThrow('CI_RECEIPT_API_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledTimes(CI_RECEIPT_LIMITS.requests);
  });
});
