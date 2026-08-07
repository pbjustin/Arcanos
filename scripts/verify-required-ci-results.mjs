import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_CI_JOB_IDS = Object.freeze([
  'lint-and-typecheck',
  'build',
  'test',
  'validate-railway-compatibility',
  'validate-deployment-readiness',
  'security-audit',
  'sdk-compliance-audit',
  'python-cli-windows',
  'local-agent-sandbox-linux',
  'local-agent-postgres-concurrency',
  'runtime-redis-admission',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Require an exact, successful result for every direct aggregate dependency. */
export function verifyRequiredCiResults(rawResults) {
  if (typeof rawResults !== 'string' || !rawResults.trim()) {
    throw new Error('ARCANOS_REQUIRED_CI_RESULTS_JSON is required.');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawResults);
  } catch {
    throw new Error('ARCANOS_REQUIRED_CI_RESULTS_JSON must be valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Required CI results must be a JSON object.');
  }

  const actualJobIds = Object.keys(parsed).sort();
  const expectedJobIds = [...REQUIRED_CI_JOB_IDS].sort();
  const missingJobIds = expectedJobIds.filter(
    jobId => !Object.prototype.hasOwnProperty.call(parsed, jobId)
  );
  const unexpectedJobIds = actualJobIds.filter(
    jobId => !REQUIRED_CI_JOB_IDS.includes(jobId)
  );
  if (missingJobIds.length || unexpectedJobIds.length) {
    const details = [
      missingJobIds.length ? `missing=${missingJobIds.join(',')}` : '',
      unexpectedJobIds.length ? `unexpected=${unexpectedJobIds.join(',')}` : '',
    ].filter(Boolean).join(' ');
    throw new Error(`Required CI job set mismatch: ${details}.`);
  }

  const failedResults = [];
  for (const jobId of REQUIRED_CI_JOB_IDS) {
    const job = parsed[jobId];
    const result = isRecord(job) && typeof job.result === 'string'
      ? job.result
      : 'missing-result';
    if (result !== 'success') {
      failedResults.push(`${jobId}=${result}`);
    }
  }
  if (failedResults.length) {
    throw new Error(
      `Required CI jobs did not all succeed: ${failedResults.join(', ')}.`
    );
  }

  return Object.freeze(
    REQUIRED_CI_JOB_IDS.map(jobId => Object.freeze({ jobId, result: 'success' }))
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = verifyRequiredCiResults(
      process.env.ARCANOS_REQUIRED_CI_RESULTS_JSON
    );
    process.stdout.write(
      `Verified ${results.length} required CI job results as success.\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Required CI result verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
