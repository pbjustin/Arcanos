import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jestCliPath = require.resolve('jest/bin/jest');

const REQUIRED_POSTGRES_SENTINEL = 'ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE';
const POSTGRES_SUITES = [
  {
    path: 'tests/integration/local-agent-hardening.pg.integration.test.ts',
    databaseEnvironment: 'LOCAL_AGENT_HARDENING_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/job-claim-fencing.pg18.integration.test.ts',
    databaseEnvironment: 'JOB_CLAIM_FENCING_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/dag-snapshot-generation.pg18.integration.test.ts',
    databaseEnvironment: 'DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/job-worker-budget-identity.pg18.integration.test.ts',
    databaseEnvironment: 'JOB_WORKER_BUDGET_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/job-stale-recovery-batching.pg18.integration.test.ts',
    databaseEnvironment: 'JOB_STALE_RECOVERY_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/backstage-roster-atomicity.pg18.integration.test.ts',
    databaseEnvironment: 'BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/backstage-storyline-atomicity.pg18.integration.test.ts',
    databaseEnvironment: 'BACKSTAGE_STORYLINE_ATOMICITY_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/backstage-canon-storyline.pg18.integration.test.ts',
    databaseEnvironment: 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/backstage-notion-partition-storage.pg18.integration.test.ts',
    databaseEnvironment: 'BACKSTAGE_NOTION_PARTITION_PG18_TEST_DATABASE_URL',
  },
  {
    path: 'tests/integration/non-gpt-terminal-retention.pg18.integration.test.ts',
    databaseEnvironment: 'NON_GPT_TERMINAL_RETENTION_TEST_DATABASE_URL',
  },
];

function buildDatabaseFreeEnvironment() {
  const environment = { ...process.env };

  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      normalizedName.startsWith('PG')
      || normalizedName.startsWith('POSTGRES')
      || normalizedName.includes('DATABASE')
    ) {
      environment[name] = '';
    }
  }
  for (const { databaseEnvironment } of POSTGRES_SUITES) {
    environment[databaseEnvironment] = '';
  }

  environment.NODE_ENV = 'test';
  environment[REQUIRED_POSTGRES_SENTINEL] = '1';

  return environment;
}

describe('required PostgreSQL package-command behavior', () => {
  it.each(POSTGRES_SUITES)(
    '$path fails before database work when $databaseEnvironment is missing',
    ({ path, databaseEnvironment }) => {
      const result = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--experimental-vm-modules',
          jestCliPath,
          '--runTestsByPath',
          path,
          '--coverage=false',
          '--runInBand',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: buildDatabaseFreeEnvironment(),
          timeout: 30_000,
        }
      );
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(output).toContain(
        `${databaseEnvironment} is required when ${REQUIRED_POSTGRES_SENTINEL}=1.`
      );
    },
    40_000
  );
});
