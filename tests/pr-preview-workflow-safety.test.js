import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';

const providerBearingPrJobs = [
  {
    path: '.github/workflows/arcanos-pr-assistant.yml',
    job: 'arcanos-pr-analysis',
    expectedGate: "if: github.event_name == 'workflow_dispatch'",
  },
  {
    path: '.github/workflows/arcanos-code-analysis.yml',
    job: 'arcanos-analysis',
    expectedGate: "if: github.event_name == 'workflow_dispatch'",
  },
  {
    path: '.github/workflows/auto-update-documentation.yml',
    job: 'analyze',
    expectedGate: "if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
  },
];

const postgresSuites = [
  {
    databaseEnvironment: 'LOCAL_AGENT_HARDENING_TEST_DATABASE_URL',
    command: 'test:local-agent-postgres',
    commandPath: 'local-agent-hardening.pg.integration',
  },
  {
    databaseEnvironment: 'JOB_CLAIM_FENCING_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/job-claim-fencing.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/dag-snapshot-generation.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'JOB_WORKER_BUDGET_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/job-worker-budget-identity.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'JOB_STALE_RECOVERY_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/job-stale-recovery-batching.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/backstage-roster-atomicity.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'BACKSTAGE_STORYLINE_ATOMICITY_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/backstage-storyline-atomicity.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/backstage-canon-storyline.pg18.integration.test.ts',
  },
  {
    databaseEnvironment: 'NON_GPT_TERMINAL_RETENTION_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/non-gpt-terminal-retention.pg18.integration.test.ts',
  },
];

function readWorkflow(path) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

describe('native PR workflow safety', () => {
  it.each(providerBearingPrJobs)('$path keeps $job manual or main-push only', ({ path, job, expectedGate }) => {
    const workflow = readWorkflow(path);
    const jobStart = workflow.indexOf(`  ${job}:\n`);

    expect(jobStart).toBeGreaterThan(-1);
    expect(workflow.slice(jobStart, jobStart + 240)).toContain(`    ${expectedGate}`);
  });

  it('does not remove the ordinary offline PR CI trigger', () => {
    const workflow = readWorkflow('.github/workflows/ci-cd.yml');

    expect(workflow).toContain('  pull_request:');
    expect(workflow).toContain("OPENAI_API_KEY: 'mock-api-key'");
    expect(workflow).toContain("FORCE_MOCK: 'true'");
    expect(workflow).toContain("OPENAI_BASE_URL: 'http://127.0.0.1:9/v1'");
    expect(workflow).toContain(
      'export ARCANOS_JOB_READ_CAPABILITY_SECRET=ci-job-read-capability-key-for-local-workflow-only'
    );
  });

  it('generates a masked per-run job-read signing fixture for documentation analysis', () => {
    const workflow = readWorkflow('.github/workflows/auto-update-documentation.yml');
    const stepStart = workflow.indexOf('      - name: Run documentation analysis\n');
    const stepEnd = workflow.indexOf(
      '\n      - name: Apply bounded tracked-document updates',
      stepStart
    );

    expect(stepStart).toBeGreaterThan(-1);
    expect(stepEnd).toBeGreaterThan(stepStart);
    const analysisStep = workflow.slice(stepStart, stepEnd);
    const generationIndex = analysisStep.indexOf('randomBytes(32).toString("hex")');
    const maskIndex = analysisStep.indexOf(
      'echo "::add-mask::${ARCANOS_JOB_READ_CAPABILITY_SECRET}"'
    );
    const exportIndex = analysisStep.indexOf('export ARCANOS_JOB_READ_CAPABILITY_SECRET');
    const startupIndex = analysisStep.indexOf('npm start &');
    const serverPidIndex = analysisStep.indexOf('SERVER_PID=$!');
    const unsetIndex = analysisStep.indexOf('unset ARCANOS_JOB_READ_CAPABILITY_SECRET');
    const analysisIndex = analysisStep.indexOf('node scripts/generate-docs-update.js');

    expect(generationIndex).toBeGreaterThan(-1);
    expect(maskIndex).toBeGreaterThan(generationIndex);
    expect(exportIndex).toBeGreaterThan(maskIndex);
    expect(startupIndex).toBeGreaterThan(exportIndex);
    expect(serverPidIndex).toBeGreaterThan(startupIndex);
    expect(unsetIndex).toBeGreaterThan(serverPidIndex);
    expect(analysisIndex).toBeGreaterThan(unsetIndex);
    expect(workflow).not.toContain('secrets.ARCANOS_JOB_READ_CAPABILITY_SECRET');
    expect(analysisStep).not.toContain(
      'ARCANOS_JOB_READ_CAPABILITY_SECRET="$ARCANOS_GPT_ACCESS_TOKEN"'
    );
    expect(analysisStep).not.toMatch(
      /ARCANOS_JOB_READ_CAPABILITY_SECRET=["'][^$]/u
    );
  });

  it('runs deployment readiness through the canonical integrity-gated web launcher', () => {
    const workflow = readWorkflow('.github/workflows/ci-cd.yml');
    const jobStart = workflow.indexOf('  validate-deployment-readiness:\n');
    const jobEnd = workflow.indexOf('\n  security-audit:', jobStart);

    expect(jobStart).toBeGreaterThan(-1);
    expect(jobEnd).toBeGreaterThan(jobStart);
    const deploymentReadinessJob = workflow.slice(jobStart, jobEnd);
    expect(deploymentReadinessJob).toContain('export ARCANOS_PROCESS_KIND=web');
    expect(deploymentReadinessJob).toContain('export RUN_WORKERS=false');
    expect(deploymentReadinessJob).toContain(
      'timeout 30s node scripts/start-railway-service-with-integrity.mjs &'
    );
    expect(deploymentReadinessJob).toContain(
      'curl -f http://localhost:8080/health || exit 1'
    );
    expect(deploymentReadinessJob).toContain('kill $SERVER_PID || true');
    expect(deploymentReadinessJob).not.toContain('timeout 30s npm start &');
  });

  it('keeps pull-request API endpoint startup isolated from providers', () => {
    const workflow = readWorkflow('.github/workflows/api-endpoint-tests.yml');

    expect(workflow).toContain('export OPENAI_API_KEY=mock-api-key');
    expect(workflow).toContain('export FORCE_MOCK=true');
    expect(workflow).toContain('export OPENAI_BASE_URL=http://127.0.0.1:9/v1');
    expect(workflow).not.toContain('OPENAI_API_KEY:-');
  });

  it('runs PostgreSQL fencing suites against the exact disposable PostgreSQL 18 database', () => {
    const workflow = readWorkflow('.github/workflows/ci-cd.yml');
    const packageJson = JSON.parse(readWorkflow('package.json'));

    expect(workflow).toContain('image: postgres:18-alpine');
    expect(workflow).toContain('POSTGRES_DB: arcanos_audit_pg18_20260727');
    expect(workflow).toContain("ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE: '1'");
    for (const { databaseEnvironment, command, commandPath } of postgresSuites) {
      expect(workflow).toContain(`${databaseEnvironment}:`);
      expect(packageJson.scripts?.[command]).toContain(commandPath);
    }
    expect(workflow).toContain('run: npm run test:local-agent-postgres');
    expect(workflow).toContain('run: npm run test:postgres-fencing');
    expect(workflow).toContain(
      'needs: [lint-and-typecheck, build, test, validate-railway-compatibility, validate-deployment-readiness, security-audit, sdk-compliance-audit, python-cli-windows, local-agent-sandbox-linux, local-agent-postgres-concurrency, runtime-redis-admission]'
    );
  });
});
