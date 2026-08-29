import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const ordinaryPrValidationWorkflows = [
  '.github/workflows/api-endpoint-tests.yml',
  '.github/workflows/ci-cd.yml',
  '.github/workflows/doc-audit.yml',
  '.github/workflows/pr-ci.yml',
];

const requiredCiJobIds = [
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
];

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

function parseWorkflow(path) {
  return yaml.load(readWorkflow(path));
}

function hasAllowedOrdinaryPrJobPermissions(permissions) {
  if (permissions === undefined) {
    return true;
  }
  if (
    permissions === null ||
    typeof permissions !== 'object' ||
    Array.isArray(permissions)
  ) {
    return false;
  }

  const entries = Object.entries(permissions);
  return (
    entries.length === 0 ||
    (entries.length === 1 &&
      entries[0][0] === 'contents' &&
      entries[0][1] === 'read')
  );
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

  it.each(ordinaryPrValidationWorkflows)(
    '%s caps repository access at contents read and never persists checkout credentials',
    path => {
      const workflow = parseWorkflow(path);
      const jobs = Object.values(workflow.jobs ?? {});
      const checkoutSteps = jobs
        .flatMap(job => job.steps ?? [])
        .filter(step => step.uses?.startsWith('actions/checkout@'));
      const excessiveJobPermissions = Object.entries(workflow.jobs ?? {})
        .filter(([, job]) => !hasAllowedOrdinaryPrJobPermissions(job.permissions))
        .map(([jobId, job]) => ({ jobId, permissions: job.permissions }));

      expect(workflow.permissions).toEqual({ contents: 'read' });
      expect(checkoutSteps.length).toBeGreaterThan(0);
      expect(excessiveJobPermissions).toEqual([]);
      for (const checkout of checkoutSteps) {
        expect(checkout.with?.['persist-credentials']).toBe(false);
      }
    }
  );

  it.each([
    { label: 'inherited workflow permissions', permissions: undefined, allowed: true },
    { label: 'all permissions disabled', permissions: {}, allowed: true },
    { label: 'explicit contents read', permissions: { contents: 'read' }, allowed: true },
    { label: 'scalar read-all', permissions: 'read-all', allowed: false },
    { label: 'scalar write-all', permissions: 'write-all', allowed: false },
    {
      label: 'additional mapped read scope',
      permissions: { contents: 'read', actions: 'read' },
      allowed: false,
    },
    { label: 'mapped write scope', permissions: { contents: 'write' }, allowed: false },
  ])('classifies $label as allowed=$allowed', ({ permissions, allowed }) => {
    expect(hasAllowedOrdinaryPrJobPermissions(permissions)).toBe(allowed);
  });

  it('keeps the fail-closed aggregate name, trigger, dependencies, and verifier', () => {
    const workflow = parseWorkflow('.github/workflows/ci-cd.yml');
    const aggregate = workflow.jobs?.['all-checks-complete'];
    const verifier = aggregate?.steps?.find(
      step => step.name === '🧾 Verify every required job result'
    );

    expect(aggregate?.name).toBe('All Checks Complete');
    expect(aggregate?.if).toBe('${{ always() }}');
    expect(aggregate?.needs).toEqual(requiredCiJobIds);
    expect(aggregate?.permissions).toEqual({ contents: 'read' });
    expect(verifier?.env?.ARCANOS_REQUIRED_CI_RESULTS_JSON).toBe('${{ toJSON(needs) }}');
    expect(verifier?.run).toBe('node scripts/verify-required-ci-results.mjs');
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
