import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const STATES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale', 'startup_failure']);
const JOB_IDS = Object.freeze({
  'Lint & Type Check': 'lint-and-typecheck', 'Build (Node 24.18.1)': 'build',
  'Test Suite (unit)': 'test-unit', 'Test Suite (integration)': 'test-integration',
  'Railway Compatibility': 'validate-railway-compatibility', 'Deployment Readiness': 'validate-deployment-readiness',
  'Security Audit': 'security-audit', 'Convergence Gate': 'sdk-compliance-audit',
  'Python CLI (Windows)': 'python-cli-windows', 'Local Agent Sandbox (Linux)': 'local-agent-sandbox-linux',
  'PostgreSQL Fencing & Local Agent Concurrency': 'local-agent-postgres-concurrency',
  'Standalone Runtime Redis Admission': 'runtime-redis-admission', 'All Checks Complete': 'all-checks-complete',
});
export const CI_RECEIPT_LIMITS = Object.freeze({ priorCommits: 3, runsPerCommit: 4, attemptsPerRun: 3, jobsPerAttempt: 100,
  requests: 64, responseBytes: 2_000_000, totalMs: 60_000, requestMs: 5_000 });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const VERSION = /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const DEPENDENCY_IDS = new Set([...Object.values(JOB_IDS).filter(id => !['test-unit', 'test-integration', 'all-checks-complete'].includes(id)), 'test']);
const state = value => STATES.has(value) ? value : 'UNKNOWN';
const conclusion = value => CONCLUSIONS.has(value) ? value : 'UNKNOWN';
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value) ? value : 'UNKNOWN';

function validContext(context) {
  return REPOSITORY.test(context.repository) && positiveInteger(context.prNumber)
    && [context.headSha, context.baseSha, context.aggregateCheckoutSha].every(value => SHA.test(value))
    && positiveInteger(context.runId) && positiveInteger(context.runAttempt) && positiveInteger(context.prCommitCount);
}

function samePullRun(run, context, sha) {
  return positiveInteger(run?.id) && run.head_sha === sha && run.event === 'pull_request'
    && run.repository?.full_name === context.repository && run.head_repository?.full_name === context.repository
    // Pull associations are mutable: an older run's associated head can already
    // point at today's PR head. The run's own head_sha binds its tested commit.
    && run.pull_requests?.some(pull => pull.number === context.prNumber);
}

function projectJobs(data, context, runId, attempt) {
  if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || !Array.isArray(data.jobs)
    || data.total_count > CI_RECEIPT_LIMITS.jobsPerAttempt || data.jobs.length !== data.total_count
    || data.jobs.some(job => job?.run_id !== runId)) return undefined;
  return data.jobs.map(job => ({
    jobId: Object.hasOwn(JOB_IDS, job.name) ? JOB_IDS[job.name] : 'UNRECOGNIZED', jobNumber: positiveInteger(job.id) ? job.id : null,
    status: state(job.status), conclusion: conclusion(job.conclusion),
    startedAt: timestamp(job.started_at), completedAt: timestamp(job.completed_at),
    // Selective retries can expose reused successful jobs. Metadata is not proof
    // that these commands executed again, and contains no test pass/skip counts.
    executionInThisAttempt: 'UNKNOWN', testCounts: 'UNKNOWN', checkoutSha: 'UNKNOWN',
    steps: Array.isArray(job.steps) ? job.steps.slice(0, 100).map(step => ({ number: positiveInteger(step.number) ? step.number : null,
      status: state(step.status), conclusion: conclusion(step.conclusion) })) : [],
    url: positiveInteger(job.id) ? `https://github.com/${context.repository}/actions/runs/${runId}/job/${job.id}` : null,
    attempt,
  }));
}

/** Read only this PR's bounded head ancestry and Actions attempt metadata. */
export async function collectCiVerificationReceipts(context, api) {
  if (!validContext(context)) throw new Error('CI_RECEIPT_CONTEXT_INVALID');
  const requiredDependencies = (context.requiredDependencies ?? []).slice(0, 11).filter(job => DEPENDENCY_IDS.has(job?.jobId)).map(job => ({
    jobId: job.jobId, result: ['success', 'failure', 'cancelled', 'skipped'].includes(job.result) ? job.result : 'UNKNOWN' }));
  const dependencyVerdict = context.dependencyVerdict === 'PASS' && requiredDependencies.length === DEPENDENCY_IDS.size
    && new Set(requiredDependencies.map(job => job.jobId)).size === DEPENDENCY_IDS.size
    && requiredDependencies.every(job => job.result === 'success') ? 'PASS' : 'FAIL';
  const shas = [context.headSha];
  let ancestryStatus = context.prCommitCount > CI_RECEIPT_LIMITS.priorCommits + 1 ? 'BOUNDED_INCOMPLETE' : 'COMPLETE';
  for (let index = 0; index < Math.min(CI_RECEIPT_LIMITS.priorCommits, context.prCommitCount - 1); index += 1) {
    try {
      const commit = await api(`/repos/${context.repository}/commits/${shas.at(-1)}`);
      if (commit?.sha !== shas.at(-1) || !Array.isArray(commit.parents) || commit.parents.length !== 1) {
        ancestryStatus = 'UNAVAILABLE'; break;
      }
      const parent = commit?.parents?.[0]?.sha;
      if (!SHA.test(parent) || parent === context.baseSha || shas.includes(parent)) { ancestryStatus = 'UNAVAILABLE'; break; }
      shas.push(parent);
    } catch { ancestryStatus = 'UNAVAILABLE'; break; }
  }
  const receipts = [];
  for (const sha of shas) {
    const receipt = { schemaVersion: 'arcanos-ci-verification/v1', commitSha: sha, repository: context.repository,
      pullRequest: context.prNumber, ancestryStatus, boundedPriorCommits: CI_RECEIPT_LIMITS.priorCommits,
      localVerification: 'EXTERNAL_PR_EVIDENCE', directPostgresVerification: 'EXTERNAL_PR_EVIDENCE',
      historyStatus: 'AVAILABLE', attempts: [] };
    if (sha === context.headSha) receipt.currentAggregate = { runId: context.runId, attempt: context.runAttempt,
      prHeadSha: context.headSha, prBaseSha: context.baseSha, aggregateCheckoutSha: context.aggregateCheckoutSha,
      dependencyCheckoutSha: 'UNKNOWN', requiredDependencyVerdict: dependencyVerdict, requiredDependencies,
      runtimeVersions: { node: VERSION.test(context.nodeVersion) ? context.nodeVersion : 'UNKNOWN',
        npm: VERSION.test(context.npmVersion) ? context.npmVersion : 'UNKNOWN' },
      commands: [{ command: 'node scripts/verify-required-ci-results.mjs',
        outcome: ['success', 'failure', 'cancelled', 'skipped'].includes(context.verifierStepOutcome) ? context.verifierStepOutcome : 'UNKNOWN',
        proofSource: 'GitHub steps.required-results.outcome' },
      { command: 'node scripts/verify-required-ci-results.mjs --write-receipts', outcome: 'IN_PROGRESS', proofSource: 'Current receipt CLI invocation' }],
      proofSources: { dependencies: 'GitHub needs.<job>.result; strict eleven-job verifier',
        aggregateCheckout: 'git rev-parse HEAD in aggregate job', runtimeVersions: 'process.version and npm --version in aggregate job' },
      workflowConclusion: 'IN_PROGRESS', aggregateConclusion: 'IN_PROGRESS',
      artifactUploadConclusion: 'NOT_YET_EXECUTED' };
    try {
      const listing = await api(`/repos/${context.repository}/actions/workflows/ci-cd.yml/runs?head_sha=${sha}&event=pull_request&per_page=${CI_RECEIPT_LIMITS.runsPerCommit}`);
      if (!Array.isArray(listing?.workflow_runs) || !Number.isSafeInteger(listing.total_count) || listing.total_count < 0) throw new Error('UNAVAILABLE');
      if (listing.total_count > CI_RECEIPT_LIMITS.runsPerCommit) receipt.historyStatus = 'BOUNDED_INCOMPLETE';
      const runs = listing.workflow_runs.slice(0, CI_RECEIPT_LIMITS.runsPerCommit).filter(run => samePullRun(run, context, sha));
      if (!runs.length) receipt.historyStatus = 'UNAVAILABLE';
      for (const run of runs) {
        if (!positiveInteger(run.run_attempt)) { receipt.historyStatus = 'UNAVAILABLE'; continue; }
        if (run.run_attempt > CI_RECEIPT_LIMITS.attemptsPerRun) receipt.historyStatus = 'BOUNDED_INCOMPLETE';
        for (let attempt = 1; attempt <= Math.min(run.run_attempt, CI_RECEIPT_LIMITS.attemptsPerRun); attempt += 1) {
          const record = { runId: run.id, attempt, status: 'UNKNOWN', conclusion: 'UNKNOWN', metadataStatus: 'UNAVAILABLE', jobsMetadataStatus: 'UNAVAILABLE',
            prHeadSha: sha, prBaseSha: 'UNKNOWN', aggregateCheckoutSha: 'UNKNOWN', dependencyCheckoutSha: 'UNKNOWN',
            runtimeVersions: 'UNKNOWN', commands: 'UNKNOWN', testCounts: 'UNKNOWN', proofSource: 'GitHub Actions run/attempt/jobs metadata',
            url: `https://github.com/${context.repository}/actions/runs/${run.id}/attempts/${attempt}`, jobs: [] };
          try {
            const metadata = await api(`/repos/${context.repository}/actions/runs/${run.id}/attempts/${attempt}`);
            if (!samePullRun(metadata, context, sha) || metadata.id !== run.id || metadata.run_attempt !== attempt) throw new Error('UNAVAILABLE');
            Object.assign(record, { status: state(metadata.status), conclusion: conclusion(metadata.conclusion), metadataStatus: 'AVAILABLE',
              associatedPrBaseSha: metadata.pull_requests.find(pull => pull.number === context.prNumber)?.base?.sha });
            if (!SHA.test(record.associatedPrBaseSha)) record.associatedPrBaseSha = 'UNKNOWN';
            const jobs = projectJobs(await api(`/repos/${context.repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`), context, run.id, attempt);
            if (!jobs) throw new Error('UNAVAILABLE');
            Object.assign(record, { jobsMetadataStatus: 'AVAILABLE', jobs });
            if (run.id === context.runId && attempt === context.runAttempt) {
              record.conclusion = 'IN_PROGRESS';
              const aggregate = record.jobs.find(job => job.jobId === 'all-checks-complete');
              if (aggregate) aggregate.conclusion = 'IN_PROGRESS';
            }
          } catch { receipt.historyStatus = 'UNAVAILABLE'; }
          if (run.id === context.runId && attempt === context.runAttempt) {
            record.status = 'in_progress'; record.conclusion = 'IN_PROGRESS';
          }
          receipt.attempts.push(record);
        }
      }
    } catch { receipt.historyStatus = 'UNAVAILABLE'; }
    receipts.push(receipt);
  }
  return receipts;
}

/** No response bodies, native errors, tokens, user strings, or remote URLs leave this seam. */
export function createBoundedActionsReader(token, fetchImpl = fetch) {
  const deadline = Date.now() + CI_RECEIPT_LIMITS.totalMs;
  let requests = 0;
  return async path => {
    if (++requests > CI_RECEIPT_LIMITS.requests || Date.now() >= deadline) throw new Error('CI_RECEIPT_API_UNAVAILABLE');
    const response = await fetchImpl(`https://api.github.com${path}`, { redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(CI_RECEIPT_LIMITS.requestMs, deadline - Date.now()))) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('CI_RECEIPT_API_UNAVAILABLE'); }
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > CI_RECEIPT_LIMITS.responseBytes) throw new Error('CI_RECEIPT_API_UNAVAILABLE');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}

export async function writeCiVerificationReceipts(environment, dependencySummary) {
  if (environment.ARCANOS_CI_RECEIPTS_ENABLED !== 'true') return 0;
  if (environment.GITHUB_ACTIONS !== 'true' || !isAbsolute(environment.RUNNER_TEMP ?? '')
    || !environment.GITHUB_EVENT_PATH || readFileSync(environment.GITHUB_EVENT_PATH).length > 512_000)
    throw new Error('CI_RECEIPT_CONTEXT_INVALID');
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
  const pull = event.pull_request;
  if (environment.GITHUB_EVENT_NAME !== 'pull_request' || pull?.head?.repo?.full_name !== environment.GITHUB_REPOSITORY
    || pull?.base?.repo?.full_name !== environment.GITHUB_REPOSITORY || !positiveInteger(pull.commits))
    throw new Error('CI_RECEIPT_CONTEXT_INVALID');
  const receipts = await collectCiVerificationReceipts({ repository: environment.GITHUB_REPOSITORY, prNumber: event.number,
    headSha: pull.head.sha, baseSha: pull.base.sha, prCommitCount: pull.commits,
    aggregateCheckoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    nodeVersion: process.version, npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim(),
    verifierStepOutcome: environment.ARCANOS_CI_VERIFIER_STEP_OUTCOME,
    runId: Number(environment.GITHUB_RUN_ID), runAttempt: Number(environment.GITHUB_RUN_ATTEMPT), ...dependencySummary },
  createBoundedActionsReader(environment.GITHUB_TOKEN));
  const directory = join(environment.RUNNER_TEMP, 'arcanos-ci-verification-receipts');
  mkdirSync(directory, { recursive: true });
  for (const receipt of receipts) writeFileSync(`${directory}/${receipt.commitSha}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipts.length;
}
