import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const REQUIRED_POSTGRES_SENTINEL = 'ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE';
const LEGACY_POSTGRES_SENTINELS = [
  'LOCAL_AGENT_HARDENING_REQUIRE_DATABASE',
  'JOB_WORKER_BUDGET_REQUIRE_DATABASE',
  'JOB_STALE_RECOVERY_REQUIRE_DATABASE',
  'BACKSTAGE_STORYLINE_ATOMICITY_REQUIRE_DATABASE',
];
const POSTGRES_TEST_DATABASE_ENVIRONMENTS = [
  'LOCAL_AGENT_HARDENING_TEST_DATABASE_URL',
  'JOB_CLAIM_FENCING_TEST_DATABASE_URL',
  'DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL',
  'JOB_WORKER_BUDGET_TEST_DATABASE_URL',
  'JOB_STALE_RECOVERY_TEST_DATABASE_URL',
  'BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL',
  'BACKSTAGE_STORYLINE_ATOMICITY_TEST_DATABASE_URL',
  'NON_GPT_TERMINAL_RETENTION_TEST_DATABASE_URL',
];
const POSTGRES_TEST_FILES = [
  'tests/integration/local-agent-hardening.pg.integration.test.ts',
  'tests/integration/job-claim-fencing.pg18.integration.test.ts',
  'tests/integration/dag-snapshot-generation.pg18.integration.test.ts',
  'tests/integration/job-worker-budget-identity.pg18.integration.test.ts',
  'tests/integration/job-stale-recovery-batching.pg18.integration.test.ts',
  'tests/integration/backstage-roster-atomicity.pg18.integration.test.ts',
  'tests/integration/backstage-storyline-atomicity.pg18.integration.test.ts',
  'tests/integration/non-gpt-terminal-retention.pg18.integration.test.ts',
];

function readNormalized(path) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function readWorkflowJob(workflow, jobId, nextJobId) {
  const start = workflow.indexOf(`  ${jobId}:\n`);
  const end = workflow.indexOf(`\n  ${nextJobId}:\n`, start + 1);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe('required PostgreSQL CI truth contract', () => {
  it('uses one required-database sentinel for all eight PostgreSQL suites', () => {
    const workflow = readNormalized('.github/workflows/ci-cd.yml');
    const postgresJob = readWorkflowJob(
      workflow,
      'local-agent-postgres-concurrency',
      'runtime-redis-admission'
    );

    expect(postgresJob).toContain(`${REQUIRED_POSTGRES_SENTINEL}: '1'`);
    for (const environmentName of POSTGRES_TEST_DATABASE_ENVIRONMENTS) {
      expect(postgresJob).toContain(`${environmentName}:`);
    }
    for (const legacySentinel of LEGACY_POSTGRES_SENTINELS) {
      expect(postgresJob).not.toContain(legacySentinel);
    }

    for (const path of POSTGRES_TEST_FILES) {
      const source = readNormalized(path);
      expect(source).toContain('resolvePostgresTestDatabaseUrl(');
      expect(source).not.toMatch(/\b[A-Z][A-Z0-9_]+_REQUIRE_DATABASE\b/u);
    }
  });

  it('keeps both required package commands bound to the complete suite set', () => {
    const packageJson = JSON.parse(readNormalized('package.json'));
    const localAgentCommand = packageJson.scripts?.['test:local-agent-postgres'];
    const fencingCommand = packageJson.scripts?.['test:postgres-fencing'];
    const expectedFencingPaths = POSTGRES_TEST_FILES.slice(1).join(' ');

    expect(localAgentCommand).toBe(
      'node scripts/run-jest.mjs --testPathPatterns=local-agent-hardening.pg.integration --coverage=false --runInBand'
    );
    expect(fencingCommand).toBe(
      `node scripts/run-jest.mjs --runTestsByPath ${expectedFencingPaths} --coverage=false --runInBand`
    );

    const workflow = readNormalized('.github/workflows/ci-cd.yml');
    const postgresJobLines = readWorkflowJob(
      workflow,
      'local-agent-postgres-concurrency',
      'runtime-redis-admission'
    ).split('\n');
    expect(postgresJobLines).toContain(
      '        run: npm run test:local-agent-postgres'
    );
    expect(postgresJobLines).toContain(
      '        run: npm run test:postgres-fencing'
    );
  });

  it('runs the aggregate gate after every dependency and fails on non-success', () => {
    const workflow = readNormalized('.github/workflows/ci-cd.yml');
    const aggregateStart = workflow.indexOf('  all-checks-complete:\n');

    expect(aggregateStart).toBeGreaterThan(-1);
    const aggregateJob = workflow.slice(aggregateStart);
    expect(aggregateJob).toContain('    if: ${{ always() }}');
    expect(aggregateJob).toContain(
      'ARCANOS_REQUIRED_CI_RESULTS_JSON: ${{ toJSON(needs) }}'
    );
    expect(aggregateJob).toContain(
      'run: node scripts/verify-required-ci-results.mjs'
    );
    expect(aggregateJob).not.toContain(
      'Repository is ready for production deployment!'
    );
  });
});
