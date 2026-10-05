import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    databaseEnvironment: 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL',
    command: 'test:postgres-fencing',
    commandPath: 'tests/integration/backstage-notion-rag-candidate-search.pg18.integration.test.ts',
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

function hasAllowedSupplementalPreviewPermissions(permissions) {
  return permissions && typeof permissions === 'object' && !Array.isArray(permissions)
    && Object.keys(permissions).length === 2
    && permissions.contents === 'read' && permissions['pull-requests'] === 'read';
}

const previewHeadSha = 'a'.repeat(40);
const previewPull = { number: 1526, state: 'open', draft: false,
  head: { sha: previewHeadSha, repo: { full_name: 'pbjustin/Arcanos' } },
  base: { ref: 'main', repo: { full_name: 'pbjustin/Arcanos' } }, labels: [{ name: 'railway-preview' }] };
const previewSuccess = { sha: previewHeadSha, statuses: [{ context: 'Railway PR Preview E2E', state: 'success',
  target_url: 'https://github.com/pbjustin/Arcanos/actions/runs/12345' }] };

function runPreviewBootstrap(fixture = {}) {
  const workflow = parseWorkflow('.github/workflows/pr-ci.yml');
  const bootstrap = workflow.jobs['native-pr-preview-head-e2e'].steps.find(step => step.id === 'trusted-preview');
  const source = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(bootstrap.run)?.[1];
  if (!source) throw new Error('Expected reviewed inline preview bootstrap');
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-preview-bootstrap-'));
  const outputPath = path.join(directory, 'outputs');
  writeFileSync(outputPath, '');
  const prelude = `
    const fixture = ${JSON.stringify(fixture)};
    const defaultPull = ${JSON.stringify(previewPull)};
    const defaultStatus = ${JSON.stringify(previewSuccess)};
    const metrics = { pulls: 0, statuses: 0, waits: 0 };
    globalThis.setTimeout = resolve => { metrics.waits += 1; resolve(); return 0; };
    globalThis.fetch = async (url, options) => {
      if (options.redirect !== 'error' || options.headers.authorization !== 'Bearer synthetic-read-token'
        || !options.signal || !url.startsWith('https://api.github.com/repos/pbjustin/Arcanos/'))
        throw new Error('unexpected credential or transport boundary');
      if (fixture.networkError) throw new Error('synthetic-private-network-sentinel');
      if (fixture.apiRejected) return new Response('{}', { status: 403 });
      let body;
      if (url.endsWith('/pulls/1526')) {
        body = fixture.pulls?.[metrics.pulls] ?? defaultPull;
        metrics.pulls += 1;
      } else if (url.endsWith('/commits/${previewHeadSha}/status?per_page=100')) {
        body = fixture.statuses?.[metrics.statuses] ?? (fixture.pendingForever
          ? { ...defaultStatus, statuses: fixture.otherCiSuccess
            ? [{ context: 'All Checks Complete', state: 'success' }] : [] } : defaultStatus);
        metrics.statuses += 1;
      }
      else throw new Error('unexpected GitHub endpoint');
      if (fixture.oversizedResponse) body = { ...body, padding: 'x'.repeat(524289) };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    process.on('exit', () => console.log('BOOTSTRAP_FIXTURE_METRICS:' + JSON.stringify(metrics)));
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: prelude + source, encoding: 'utf8', timeout: 5_000,
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GITHUB_TOKEN: 'synthetic-read-token',
        GITHUB_REPOSITORY: 'pbjustin/Arcanos', PR_NUMBER: '1526', HEAD_SHA: previewHeadSha,
        RUNNER_TEMP: directory, GITHUB_OUTPUT: outputPath, ...fixture.eventEnvironment },
    });
    const evidencePath = path.join(directory, 'native-pr-preview-trusted-context.json');
    const metricLine = result.stdout.split('\n').find(line => line.startsWith('BOOTSTRAP_FIXTURE_METRICS:'));
    return { ...result, metrics: metricLine ? JSON.parse(metricLine.slice('BOOTSTRAP_FIXTURE_METRICS:'.length)) : null,
      outputs: readFileSync(outputPath, 'utf8'), evidence: existsSync(evidencePath)
        ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runPreviewResultSummary(result) {
  const job = parseWorkflow('.github/workflows/pr-ci.yml').jobs['native-pr-preview-head-e2e'];
  const command = job.steps.find(step => step.name === 'Execute credential-free PR-head preview verifier').run;
  const source = /<<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(command)?.[1];
  if (!source) throw new Error('Expected credential-free preview result summary');
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-preview-result-'));
  const resultPath = path.join(directory, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result));
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-', resultPath, previewHeadSha], {
      input: source, encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('supplemental exact-head preview workflow', () => {
  it('admits opted-in same-repository main PRs without repeating ordinary CI on opt-in or undraft', () => {
    const workflow = parseWorkflow('.github/workflows/pr-ci.yml');
    expect(workflow.on.pull_request.types).toEqual(['opened', 'reopened', 'synchronize', 'labeled', 'ready_for_review']);
    expect(workflow.jobs['build-test'].if).toBe("github.event.action == 'opened' || github.event.action == 'reopened' || github.event.action == 'synchronize'");
    const job = workflow.jobs['native-pr-preview-head-e2e'];
    for (const condition of ["github.repository == 'pbjustin/Arcanos'", "github.event.pull_request.state == 'open'",
      'github.event.pull_request.draft == false', "github.event.pull_request.base.ref == 'main'",
      'github.event.pull_request.base.repo.full_name == github.repository',
      'github.event.pull_request.head.repo.full_name == github.repository',
      "contains(github.event.pull_request.labels.*.name, 'railway-preview')",
      "(github.event.action != 'labeled' || github.event.label.name == 'railway-preview')"]) expect(job.if).toContain(condition);
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(job['timeout-minutes']).toBe(15);
  });

  it('isolates token-bearing bootstrap before checkout and executes only the credential-free exact-head verifier', () => {
    const job = parseWorkflow('.github/workflows/pr-ci.yml').jobs['native-pr-preview-head-e2e'];
    const bootstrapIndex = job.steps.findIndex(step => step.id === 'trusted-preview');
    const checkoutIndex = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
    const execute = job.steps.find(step => step.name === 'Execute credential-free PR-head preview verifier');
    expect(bootstrapIndex).toBeLessThan(checkoutIndex);
    expect(job.steps[checkoutIndex].with).toEqual({ repository: 'pbjustin/Arcanos',
      ref: '${{ steps.trusted-preview.outputs.head_sha }}', 'persist-credentials': false });
    expect(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe('24.18.1');
    for (const step of job.steps.filter(step => step.uses)) expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
    expect(execute.run).toContain('env -i PATH="$PATH" LANG=C LC_ALL=C node "$GITHUB_WORKSPACE/scripts/native-pr-preview-e2e.mjs"');
    expect(execute.run).toContain('--git-evidence-root "$GITHUB_WORKSPACE" --pr-number "$PR_NUMBER" --commit-sha "$HEAD_SHA"');
    expect(execute.run).toContain('--web-base-url "$WEB_BASE_URL" --worker-base-url "$WORKER_BASE_URL" --execute --allow-network');
    expect(execute.run).toContain('> "$RUNNER_TEMP/native-pr-preview-head-result.json"');
    expect(execute.run).toContain('2> "$RUNNER_TEMP/native-pr-preview-head-result.err"');
    expect(job.steps.filter(step => step.env?.GITHUB_TOKEN)).toHaveLength(1);
    expect(JSON.stringify(job)).not.toMatch(/RAILWAY.*TOKEN|OPENAI_API_KEY|DATABASE_URL|npm ci/u);
    const artifact = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(artifact.if).toBe('${{ always() }}');
    expect(artifact.with['retention-days']).toBe(14);
    expect(artifact.with.path.split('\n').filter(Boolean)).toEqual([
      '${{ runner.temp }}/native-pr-preview-trusted-context.json',
      '${{ runner.temp }}/native-pr-preview-head-result.json', '${{ runner.temp }}/native-pr-preview-head-result.err',
    ]);
    const controller = readWorkflow('scripts/railway-pr-preview-lifecycle.mjs');
    expect(job.steps[bootstrapIndex].run).toContain(`const environmentPrefix = '${/environmentPrefix: '([^']+)'/u.exec(controller)[1]}';`);
    expect(job.steps[bootstrapIndex].run).not.toMatch(/import .*railway-pr-preview|readFileSync/u);
  });

  it('waits for the exact trusted context and refreshes admission before reporting bounded public evidence', () => {
    const result = runPreviewBootstrap({ statuses: [{ ...previewSuccess,
      statuses: [{ context: 'Railway PR Preview E2E', state: 'pending' }] }, previewSuccess] });
    expect(result.status).toBe(0);
    expect(result.metrics).toEqual({ pulls: 3, statuses: 2, waits: 1 });
    expect(result.evidence).toEqual({ repository: 'pbjustin/Arcanos', prNumber: 1526, commitSha: previewHeadSha,
      context: 'Railway PR Preview E2E', trustedRunUrl: previewSuccess.statuses[0].target_url,
      webBaseUrl: 'https://arcanos-v2-pr-676861-1526.up.railway.app',
      workerBaseUrl: 'https://arcanos-worker-pr-676861-1526.up.railway.app',
      scope: 'trusted-commit-status-and-served-public-identity', controlPlaneProvenanceAsserted: false });
    expect(result.outputs).toContain(`head_sha=${previewHeadSha}\n`);
    expect(result.stdout + result.stderr).not.toContain('synthetic-read-token');
  });

  it.each([
    ['new head', { ...previewPull, head: { ...previewPull.head, sha: 'b'.repeat(40) } }],
    ['closed PR', { ...previewPull, state: 'closed' }], ['draft', { ...previewPull, draft: true }],
    ['removed opt-in', { ...previewPull, labels: [] }],
    ['fork', { ...previewPull, head: { ...previewPull.head, repo: { full_name: 'fork/Arcanos' } } }],
    ['changed target', { ...previewPull, base: { ...previewPull.base, ref: 'release' } }],
    ['foreign base', { ...previewPull, base: { ...previewPull.base, repo: { full_name: 'other/Arcanos' } } }],
  ])('fails before publishing evidence after %s', (_name, pull) => {
    const result = runPreviewBootstrap({ pulls: [pull] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NATIVE_PR_PREVIEW_TRUSTED_PR_DRIFT');
    expect(result.evidence).toBeNull();
    expect(result.outputs).toBe('');
    expect(result.metrics.statuses).toBe(0);
  });

  it('rejects admission drift occurring after the successful trusted status read', () => {
    const result = runPreviewBootstrap({ pulls: [previewPull, { ...previewPull, labels: [] }] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NATIVE_PR_PREVIEW_TRUSTED_PR_DRIFT');
    expect(result.evidence).toBeNull();
  });

  it.each([
    ['failed', { ...previewSuccess, statuses: [{ ...previewSuccess.statuses[0], state: 'failure' }] }, 'STATUS_FAILED'],
    ['error', { ...previewSuccess, statuses: [{ ...previewSuccess.statuses[0], state: 'error' }] }, 'STATUS_FAILED'],
    ['different SHA', { ...previewSuccess, sha: 'b'.repeat(40) }, 'STATUS_IDENTITY_INVALID'],
    ['ambiguous', { ...previewSuccess, statuses: [...previewSuccess.statuses, ...previewSuccess.statuses] }, 'STATUS_AMBIGUOUS'],
    ['foreign run link', { ...previewSuccess, statuses: [{ ...previewSuccess.statuses[0], target_url: 'https://github.com/other/repo/actions/runs/12345' }] }, 'RUN_LINK_INVALID'],
  ])('rejects %s trusted status', (_name, status, code) => {
    const result = runPreviewBootstrap({ statuses: [status] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`NATIVE_PR_PREVIEW_TRUSTED_${code}`);
    expect(result.evidence).toBeNull();
  });

  it.each([false, true])('stops after 48 bounded attempts without treating absent context or other CI success as preview proof (%#)', otherCiSuccess => {
    const result = runPreviewBootstrap({ pendingForever: true, otherCiSuccess });
    expect(result.status).toBe(1);
    expect(result.metrics).toEqual({ pulls: 48, statuses: 48, waits: 47 });
    expect(result.stderr).toContain('NATIVE_PR_PREVIEW_TRUSTED_STATUS_TIMEOUT');
    expect(result.evidence).toBeNull();
  });

  it.each([
    [{ apiRejected: true }, 'API_REJECTED'], [{ networkError: true }, 'API_UNAVAILABLE'],
    [{ oversizedResponse: true }, 'API_RESPONSE_LIMIT'],
    [{ eventEnvironment: { GITHUB_REPOSITORY: 'fork/Arcanos' } }, 'EVENT_INVALID'],
  ])('fails closed for bounded API or event failures (%#)', (fixture, code) => {
    const result = runPreviewBootstrap(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`NATIVE_PR_PREVIEW_TRUSTED_${code}`);
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-network-sentinel');
    expect(result.stdout + result.stderr).not.toContain('synthetic-read-token');
    expect(result.evidence).toBeNull();
  });

  it('logs only concise executed exact-head proof and accepts other PRs without the additive marker', () => {
    const result = { executed: true, target: { commitSha: previewHeadSha }, summary: { status: 'PASS' },
      limits: { maxRequests: 171 }, checks: [{ caseId: 'gaming-query-guide',
        gamingEditionContextRegressionsVerified: true, gamingEditionContextRegressionsProofVersion: 'gaming-edition-context-regressions/v1',
        gamingEditionContextRegressionsProofScope: 'pure-request-source-identity-applicability',
        gamingEditionContextRegressionsCases: ['ordinary-no-edition-samurai'], privateFixture: 'synthetic-private-proof-sentinel' }] };
    const logged = runPreviewResultSummary(result);
    expect(logged.status).toBe(0);
    expect(JSON.parse(logged.stdout).gamingEditionContextRegressions).toEqual({ verified: true,
      proofVersion: 'gaming-edition-context-regressions/v1', proofScope: 'pure-request-source-identity-applicability',
      cases: ['ordinary-no-edition-samurai'] });
    expect(logged.stdout).not.toContain('synthetic-private-proof-sentinel');
    expect(runPreviewResultSummary({ ...result, checks: [] }).status).toBe(0);
    for (const changed of [{ ...result, executed: false }, { ...result, summary: { status: 'FAIL' } },
      { ...result, target: { commitSha: 'b'.repeat(40) } }]) {
      const failed = runPreviewResultSummary(changed);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe('');
      expect(failed.stderr).toContain('NATIVE_PR_PREVIEW_EXECUTED_RESULT_INVALID');
    }
  });
});

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
    '%s caps repository access and never persists checkout credentials',
    path => {
      const workflow = parseWorkflow(path);
      const jobs = Object.values(workflow.jobs ?? {});
      const checkoutSteps = jobs
        .flatMap(job => job.steps ?? [])
        .filter(step => step.uses?.startsWith('actions/checkout@'));
      const excessiveJobPermissions = Object.entries(workflow.jobs ?? {})
        .filter(([jobId, job]) => path === '.github/workflows/pr-ci.yml' && jobId === 'native-pr-preview-head-e2e'
          ? !hasAllowedSupplementalPreviewPermissions(job.permissions)
          : !hasAllowedOrdinaryPrJobPermissions(job.permissions))
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
