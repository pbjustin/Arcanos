import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const ordinaryPrValidationWorkflows = [
  '.github/workflows/api-endpoint-tests.yml',
  '.github/workflows/ci-cd.yml',
  '.github/workflows/doc-audit.yml',
  '.github/workflows/pr-ci.yml',
  '.github/workflows/railway-inspection-fixture-e2e.yml',
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
    expectedGate: "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  },
  {
    path: '.github/workflows/arcanos-code-analysis.yml',
    job: 'arcanos-analysis',
    expectedGate: "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  },
  {
    path: '.github/workflows/auto-update-documentation.yml',
    job: 'analyze',
    expectedGate: "github.event_name == 'workflow_dispatch'"
      + " && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
      + " && inputs.provider_confirmation == 'AUTHORIZE DOCUMENTATION PROVIDER REQUESTS'",
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
      if (options.redirect !== 'error' || options.headers.authorization !== 'Bearer mock-read-token'
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
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GITHUB_TOKEN: 'mock-read-token',
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

const maintainedDocumentationPath = 'docs/GPT_ASYNC_DOCUMENTATION_WORKFLOW.md';
const baselineDocumentation = '# Existing documentation\n';

function runDocumentationUpdate(payload, { untracked = false, dirtyOtherFile = false, rawJson } = {}) {
  const job = parseWorkflow('.github/workflows/auto-update-documentation.yml').jobs.analyze;
  const step = job.steps.find(candidate => candidate.id === 'process_updates');
  const source = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(step.run)?.[1];
  if (!source) throw new Error('Expected reviewed inline documentation update validator');
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'arcanos-doc-update-'));
  const directory = path.join(fixtureRoot, 'repository');
  const outputPath = path.join(directory, 'outputs');
  const environment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, env: environment, encoding: 'utf8', timeout: 5_000,
    });
    if (result.status !== 0) throw new Error(`Documentation fixture Git failed: ${result.stderr}`);
    return result.stdout;
  };
  try {
    mkdirSync(path.join(directory, 'docs'), { recursive: true });
    writeFileSync(path.join(directory, maintainedDocumentationPath), baselineDocumentation);
    writeFileSync(path.join(directory, 'README.md'), '# Unrelated document\n');
    writeFileSync(outputPath, '');
    git(['init', '--quiet']);
    git(['add', '--', 'README.md', ...(untracked ? [] : [maintainedDocumentationPath])]);
    git(['-c', 'user.name=Documentation fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Disposable documentation fixture']);
    const baselineHead = git(['rev-parse', 'HEAD']).trim();
    if (dirtyOtherFile) writeFileSync(path.join(directory, 'README.md'), '# Unexpected side effect\n');
    const proposal = typeof payload === 'function' ? payload(directory) : payload;
    writeFileSync(path.join(directory, 'doc_analysis.json'), rawJson ?? JSON.stringify(proposal));
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: source, cwd: directory, encoding: 'utf8', timeout: 5_000,
      env: { ...environment, ...step.env, GITHUB_OUTPUT: outputPath },
    });
    return { ...result, outputs: readFileSync(outputPath, 'utf8'),
      content: readFileSync(path.join(directory, maintainedDocumentationPath), 'utf8'),
      changedFiles: git(['diff', '--name-only', 'HEAD', '--']).trim().split('\n').filter(Boolean),
      committed: git(['rev-parse', 'HEAD']).trim() !== baselineHead };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function runDocumentationSummary(status, hasUpdates) {
  const job = parseWorkflow('.github/workflows/auto-update-documentation.yml').jobs.analyze;
  const script = job.steps.find(step => step.name === 'Report analysis result').run
    .replaceAll('${{ job.status }}', status)
    .replaceAll('${{ steps.process_updates.outputs.has_updates }}', String(hasUpdates))
    .replaceAll('${{ github.run_id }}', '12345')
    .replaceAll('${{ github.run_attempt }}', '1');
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-doc-summary-'));
  try {
    return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', timeout: 5_000,
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
        GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('authorized documentation patch boundary', () => {
  it('retains read-only workflow permissions and human publication of the single approved document', () => {
    const workflow = parseWorkflow('.github/workflows/auto-update-documentation.yml');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: 'read' });
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'])
        .toBe(false);
    }
    const analysis = workflow.jobs.analyze;
    const update = analysis.steps.find(step => step.id === 'process_updates');
    expect(update.env).toEqual({ MAX_UPDATE_FILES: '1', MAX_FILE_BYTES: '262144', MAX_TOTAL_BYTES: '1048576' });
    const allowlist = /const allowedDocuments = new Set\(\[([\s\S]*?)\]\)/u.exec(update.run)?.[1];
    expect([...allowlist.matchAll(/'([^']+)'/gu)].map(match => match[1])).toEqual([maintainedDocumentationPath]);
    const commands = Object.values(workflow.jobs).flatMap(job => job.steps.map(step => step.run ?? '')).join('\n');
    expect(commands).not.toMatch(/\bgit\s+(?:commit|push)\b|\bgh\s+pr\s+create\b/u);
    expect(JSON.stringify(workflow)).not.toMatch(/create-pull-request|contents:[ ]*write|pull-requests:[ ]*write/u);
    const validate = analysis.steps.find(step => step.name === 'Validate proposed documentation');
    expect(validate.if).toBe("steps.process_updates.outputs.has_updates == 'true'");
    expect(validate.run).toContain('git diff --check HEAD -- "$ALLOWED_DOCUMENT"');
    expect(validate.run).toContain('"$PATCH_BYTES" -gt 1048576');
    expect(validate.run).toContain('> documentation-update.patch');
  });

  it.each([false, true])('applies a valid bounded proposal without committing it (response envelope: %s)', wrapped => {
    const proposal = { ok: true, updates: [{ file: maintainedDocumentationPath, content: '# Reviewed proposal' }] };
    const result = runDocumentationUpdate(wrapped ? { response: proposal } : proposal);
    expect(result.status).toBe(0);
    expect(result.content).toBe('# Reviewed proposal\n');
    expect(result.outputs).toBe('has_updates=true\nupdate_count=1\n');
    expect(result.changedFiles).toEqual([maintainedDocumentationPath]);
    expect(result.committed).toBe(false);
  });

  it.each([
    ['wrong maintained file', 'README.md'],
    ['unapproved documentation', 'docs/OTHER.md'],
    ['parent traversal', '../outside.md'],
    ['normalized traversal', 'docs/../docs/GPT_ASYNC_DOCUMENTATION_WORKFLOW.md'],
    ['absolute path', directory => path.join(directory, 'absolute.md')],
    ['Windows separators', 'docs\\GPT_ASYNC_DOCUMENTATION_WORKFLOW.md'],
    ['NUL path', `${maintainedDocumentationPath}\0`],
    ['non-Markdown target', 'scripts/check-documentation.mjs'],
    ['missing path', undefined],
  ])('rejects %s without modifying tracked documentation', (_name, file) => {
    const result = runDocumentationUpdate(directory => ({ ok: true,
      updates: [{ file: typeof file === 'function' ? file(directory) : file, content: '# Rejected' }] }));
    expect(result.status).toBe(1);
    expect(result.content).toBe(baselineDocumentation);
    expect(result.changedFiles).toEqual([]);
    expect(result.outputs).toBe('');
  });

  it.each([
    ['duplicate updates', [
      { file: maintainedDocumentationPath, content: '# First' },
      { file: maintainedDocumentationPath, content: '# Second' },
    ]],
    ['non-array updates', { file: maintainedDocumentationPath, content: '# Rejected' }],
    ['non-string content', [{ file: maintainedDocumentationPath, content: 42 }]],
    ['NUL content', [{ file: maintainedDocumentationPath, content: '# Rejected\0' }]],
    ['oversize UTF-8 content', [{ file: maintainedDocumentationPath, content: 'é'.repeat(131073) }]],
    ['newline exceeding the byte limit', [{ file: maintainedDocumentationPath, content: 'x'.repeat(262144) }]],
  ])('rejects %s before applying any update', (_name, updates) => {
    const result = runDocumentationUpdate({ ok: true, updates });
    expect(result.status).toBe(1);
    expect(result.content).toBe(baselineDocumentation);
    expect(result.changedFiles).toEqual([]);
    expect(result.outputs).toBe('');
  });

  it.each(['x'.repeat(262143), `${'x'.repeat(262143)}\n`])('accepts exactly 262144 written bytes (%#)', content => {
    const result = runDocumentationUpdate({ ok: true, updates: [{ file: maintainedDocumentationPath, content }] });
    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(262144);
    expect(result.outputs).toBe('has_updates=true\nupdate_count=1\n');
  });

  it.each([false, undefined, 'true'])('does not apply degraded or nonboolean-success output (%s)', ok => {
    const result = runDocumentationUpdate({ ok, updates: [{ file: maintainedDocumentationPath, content: '# Rejected' }] });
    expect(result.status).toBe(0);
    expect(result.content).toBe(baselineDocumentation);
    expect(result.changedFiles).toEqual([]);
    expect(result.outputs).toBe('has_updates=false\nupdate_count=0\n');
  });

  it('rejects malformed JSON without applying documentation', () => {
    const result = runDocumentationUpdate(null, { rawJson: '{ invalid' });
    expect(result.status).toBe(1);
    expect(result.content).toBe(baselineDocumentation);
    expect(result.changedFiles).toEqual([]);
    expect(result.outputs).toBe('');
  });

  it('rejects the allowed document when it is not tracked', () => {
    const result = runDocumentationUpdate({ ok: true, updates: [{ file: maintainedDocumentationPath, content: '# Rejected' }] }, { untracked: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('targets an untracked document');
    expect(result.content).toBe(baselineDocumentation);
    expect(result.outputs).toBe('');
  });

  it('rejects publication when another tracked file was modified', () => {
    const result = runDocumentationUpdate({ ok: true, updates: [{ file: maintainedDocumentationPath, content: '# Proposal' }] }, { dirtyOtherFile: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing tracked side effects outside the documentation allowlist: README.md');
    expect(result.outputs).toBe('');
    expect(result.committed).toBe(false);
  });

  it.each(['failure', 'cancelled'])('does not advertise a successful patch after %s', status => {
    const result = runDocumentationSummary(status, true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Documentation analysis or validation failed.');
    expect(result.stdout).not.toContain('A validated documentation patch is available');
  });

  it('requires a human-authored branch and review for a successful patch', () => {
    const result = runDocumentationSummary('success', true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Download and review it, then apply it on a human-authored branch and open a pull request.');
  });
});

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
    expect(result.stdout + result.stderr).not.toContain('mock-read-token');
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
    expect(result.stdout + result.stderr).not.toContain('mock-read-token');
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
  it('keeps native Windows verification required and preserves failures while collecting independent evidence', () => {
    const workflow = parseWorkflow('.github/workflows/ci-cd.yml');
    const job = workflow.jobs['python-cli-windows'];
    expect(job['runs-on']).toBe('windows-latest');
    expect(workflow.jobs['all-checks-complete'].needs).toContain('python-cli-windows');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    expect(job.steps.every(step => step['continue-on-error'] === undefined)).toBe(true);
    expect(JSON.stringify(job)).not.toContain('secrets.');
    const checkout = job.steps.filter(step => step.uses === 'actions/checkout@v4');
    expect(checkout).toHaveLength(1);
    expect(checkout[0].with).toEqual({
      ref: '${{ github.event.pull_request.head.sha || github.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false
    });
    const command = run => {
      const matches = job.steps.filter(step => step.run === run);
      expect(matches).toHaveLength(1);
      return matches[0];
    };
    const gate = id => `\${{ !cancelled() && steps.${id}.outcome == 'success' }}`;
    expect(job.steps.find(step => step.id === 'windows_node').uses).toBe('actions/setup-node@v4');
    expect(command('node scripts/ci-windows-verification.mjs metadata').id).toBe('windows_metadata');
    expect(command('node scripts/ci-windows-verification.mjs metadata').env.EVIDENCE_HEAD_SHA)
      .toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(command('node scripts/ci-windows-verification.mjs run install').id).toBe('windows_install');
    expect(command('node scripts/ci-windows-verification.mjs run build').id).toBe('windows_build');
    expect(command('node scripts/ci-windows-verification.mjs metadata').if).toBe(gate('windows_node'));
    expect(command('node scripts/ci-windows-verification.mjs capabilities').if).toBe(gate('windows_metadata'));
    expect(command('node scripts/ci-windows-verification.mjs run install').if).toBe(gate('windows_metadata'));
    expect(command('node scripts/ci-windows-verification.mjs run type-check').if).toBe(gate('windows_install'));
    expect(command('node scripts/ci-windows-verification.mjs run build').if).toBe(gate('windows_install'));
    for (const name of ['yaml', 'windows', 'workflows', 'gaming']) {
      expect(command(`node scripts/ci-windows-verification.mjs run ${name}`).if).toBe(gate('windows_build'));
    }
    expect(command('node scripts/ci-windows-verification.mjs report').if).toBe('always()');
    const upload = job.steps.filter(step => step.uses === 'actions/upload-artifact@v4');
    expect(upload).toHaveLength(2);
    for (const [name, artifact, directory] of [
      ['Upload native Windows verification evidence', 'native-windows', 'arcanos-windows-verification'],
      ['Upload native Windows projector fixture evidence', 'windows-projector-fixtures', 'arcanos-projector-fixtures']
    ]) {
      expect(upload.find(step => step.name === name)).toMatchObject({
        if: 'always()',
        with: {
          name: `${artifact}-\${{ github.event.pull_request.head.sha || github.sha }}-\${{ github.run_attempt }}`,
          path: `\${{ runner.temp }}/${directory}/`,
          'retention-days': 30,
          'if-no-files-found': 'error'
        }
      });
    }
  });

  it.each(providerBearingPrJobs)('$path keeps $job behind its manual authorization gate', ({ path, job, expectedGate }) => {
    const workflow = parseWorkflow(path);

    expect(workflow.jobs[job].if).toBe(expectedGate);
  });

  it('requires explicit default-branch authorization before exposing documentation provider credentials', () => {
    const workflow = parseWorkflow('.github/workflows/auto-update-documentation.yml');
    expect(workflow.on.workflow_dispatch.inputs.provider_confirmation).toMatchObject({
      required: false, default: '', type: 'string',
    });
    expect(workflow.jobs.analyze.needs).toBe('validate-offline');
    const analysisStep = workflow.jobs.analyze.steps.find(step => step.name === 'Run documentation analysis');
    expect(analysisStep.env.OPENAI_API_KEY).toBe('${{ secrets.OPENAI_API_KEY }}');
    expect(analysisStep.env.ARCANOS_GPT_ACCESS_TOKEN).toBe('ci-gpt-access-token-for-local-workflow-only');
    expect(analysisStep.run).toContain('if [ -z "$OPENAI_API_KEY" ]; then');
    expect(analysisStep.run).toContain('--strict');
    expect(analysisStep.run).not.toContain('--allow-partial');
    expect(JSON.stringify(workflow.env)).not.toContain('secrets.');
    expect(JSON.stringify(workflow.jobs.analyze.env ?? {})).not.toContain('secrets.');
  });

  it('runs automatic documentation validation without credentials, install hooks, or application startup', () => {
    const workflow = parseWorkflow('.github/workflows/auto-update-documentation.yml');
    const offline = workflow.jobs['validate-offline'];
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(offline.if).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(offline.permissions).toEqual({ contents: 'read' });
    expect(offline.env).toBeUndefined();
    expect(JSON.stringify(offline)).not.toMatch(/secrets\.|github\.token/iu);
    const commands = offline.steps.map(step => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/npm\s+(?:ci|install|start|run\s+build)|generate-docs-update|start-server/iu);
    expect(commands).toContain('sudo apt-get install --yes bubblewrap');
    expect(offline.steps.find(step => step.name === 'Verify offline documentation security contracts').run)
      .toBe('env -i PATH="$PATH" node --test scripts/documentation-offline.test.mjs');
    expect(offline.steps.find(step => step.name === 'Validate documentation offline').run)
      .toBe('env -i PATH="$PATH" node scripts/check-documentation-offline.mjs');
    expect(offline.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'])
      .toBe(false);
    const evidence = offline.steps.find(step => step.name === 'Upload offline validation evidence');
    expect(evidence.if).toBe('always()');
    expect(evidence.with.path).toBe('documentation-offline-validation.json');
    expect(evidence.with['if-no-files-found']).toBe('error');
    expect(offline.steps.find(step => step.name === 'Report offline validation result').run)
      .toContain('Provider generation in this job: skipped.');
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
          : path === '.github/workflows/ci-cd.yml' && jobId === 'all-checks-complete'
            ? JSON.stringify(job.permissions) !== JSON.stringify({ contents: 'read', actions: 'read' })
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
    expect(aggregate?.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(verifier?.env?.ARCANOS_REQUIRED_CI_RESULTS_JSON).toBe('${{ toJSON(needs) }}');
    expect(verifier?.run).toBe('node scripts/verify-required-ci-results.mjs');
    expect(verifier?.id).toBe('required-results');
    const receipt = aggregate.steps.find(step => step.name === 'Write sanitized per-SHA CI receipts');
    const upload = aggregate.steps.find(step => step.name === 'Retain per-SHA CI verification receipts');
    const receiptGate = "${{ always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository }}";
    expect(receipt.if).toBe(receiptGate);
    expect(upload.if).toBe(receiptGate);
    expect(receipt.env.ARCANOS_CI_RECEIPTS_ENABLED).toBe('true');
    expect(receipt.env.ARCANOS_CI_VERIFIER_STEP_OUTCOME).toBe('${{ steps.required-results.outcome }}');
    expect(receipt.env.GITHUB_TOKEN).toBe('${{ github.token }}');
    expect(upload.uses).toBe('actions/upload-artifact@v4');
    expect(upload.with['retention-days']).toBe(30);
    expect(upload.with['if-no-files-found']).toBe('error');
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
