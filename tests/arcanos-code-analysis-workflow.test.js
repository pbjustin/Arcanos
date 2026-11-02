import { describe, expect, it } from '@jest/globals';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createArcanosCoreAdvisoryClient, resolveArcanosCoreAdvisoryConfig } from '../src/platform/operator/arcanosCoreAdvisoryClient.js';

const readWorkflow = name => yaml.load(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
const codeWorkflow = readWorkflow('arcanos-code-analysis');
const prWorkflow = readWorkflow('arcanos-pr-assistant');
const code = codeWorkflow.jobs['arcanos-analysis'];
const pr = prWorkflow.jobs['arcanos-pr-analysis'];
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);

// Execute the actual validation shell, with only the GitHub transport replaced.
function runValidation(step, overrides = {}, fixture = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-advisory-workflow-'));
  const output = path.join(directory, 'outputs');
  writeFileSync(output, '');
  writeFileSync(path.join(directory, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const route = args.find(arg => arg.startsWith('repos/')) || '';
const fixture = JSON.parse(process.env.FIXTURE);
if (fixture.apiFailure) process.exit(1);
if (route.includes('/compare/')) console.log(fixture.compareStatus || 'ahead');
else if (route.includes('/files?')) console.log('src/example.ts');
else if (args.includes('Accept: application/vnd.github.diff')) console.log('synthetic diff');
else console.log(JSON.stringify({ state: 'open', head: { sha: fixture.movingHead && require('fs').existsSync('pr-current.json')
  ? '${'c'.repeat(40)}' : '${sha}' }, base: { sha: '${base}' } }));
`, { mode: 0o755 });
  try {
    return { ...spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { PATH: `${directory}:${process.env.PATH}`, LANG: 'C', LC_ALL: 'C',
        GITHUB_OUTPUT: output, REQUESTED_SHA: sha, TRIGGER_SOURCE: 'manual',
        PR_NUMBER: '123', GH_REPO: 'pbjustin/Arcanos', FIXTURE: JSON.stringify(fixture), ...overrides },
    }), outputs: readFileSync(output, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('manual advisory workflow safety', () => {
  it.each([[codeWorkflow, code], [prWorkflow, pr]])('uses read-only, provider-free artifacts without readiness checks', (workflow, job) => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    expect(Object.values(job.permissions).every(value => value === 'read')).toBe(true);
    expect(job.permissions.contents).toBe('read');
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|checks\.create|issues\.(?:create|update)|Ready for merge|continue-on-error/iu);
    expect(workflow.env).toBeUndefined();
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with['persist-credentials']).toBe(false);
    for (const step of job.steps.filter(step => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
    const commands = job.steps.map(step => step.run || '').join('\n');
    expect(commands).toContain('merge approval or deployment readiness');
    expect(commands).not.toMatch(/npm start|curl|OPENAI|analysis_result/u);
    expect(commands).not.toMatch(/\bgit (?:commit|push)\b|\bgh (?:pr|issue) (?:create|comment|merge)\b/u);
    expect(commands).not.toMatch(/\$\{\{\s*inputs\./u);
  });

  it('validates code input before checkout and verifies the executing commit', () => {
    const validate = code.steps.find(step => step.id === 'target');
    const checkout = code.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(code.steps.indexOf(validate)).toBeLessThan(code.steps.indexOf(checkout));
    expect(checkout.with.ref).toBe('${{ steps.target.outputs.commit_sha }}');
    expect(code.steps.find(step => step.name === 'Verify checkout SHA').run)
      .toContain('test "$(git rev-parse HEAD)" = "$COMMIT_SHA"');
    expect(runValidation(validate).outputs).toBe(`commit_sha=${sha}\n`);
    expect(runValidation(validate, {}, { compareStatus: 'identical' }).status).toBe(0);
  });

  it.each(['main', '--help', 'a'.repeat(39), 'a'.repeat(41), '$(touch injected)', `${sha}\nsha=bad`])('rejects untrusted commit input %s', value => {
    const result = runValidation(code.steps.find(step => step.id === 'target'), { REQUESTED_SHA: value });
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });

  it.each(['$(touch injected)', 'manual\ncommand', 'x'.repeat(65)])('rejects untrusted trigger source %s', value => {
    const result = runValidation(code.steps.find(step => step.id === 'target'), { TRIGGER_SOURCE: value });
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });

  it.each([{ compareStatus: 'diverged' }, { compareStatus: 'behind' }, { apiFailure: true }])('rejects an unverified main ancestor: %j', fixture => {
    const result = runValidation(code.steps.find(step => step.id === 'target'), {}, fixture);
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });

  it('captures a stable PR head and base after trusted checkout without executing PR code', () => {
    const validate = pr.steps.find(step => step.id === 'pr-details');
    const checkout = pr.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with.ref).toBe('${{ github.sha }}');
    expect(pr.steps.indexOf(validate)).toBeGreaterThan(pr.steps.indexOf(checkout));
    expect(JSON.stringify(pr)).not.toMatch(/npm |setup-node|pip /u);
    const result = runValidation(validate);
    expect(result.status).toBe(0);
    expect(result.outputs).toBe(`pr_number=123\nhead_sha=${sha}\nbase_sha=${base}\n`);
    const analysis = pr.steps.find(step => step.name === 'Advisory snapshot summary');
    expect(analysis.env.PR_HEAD_SHA).toBe('${{ steps.pr-details.outputs.head_sha }}');
    expect(analysis.env.PR_BASE_SHA).toBe('${{ steps.pr-details.outputs.base_sha }}');
    expect(analysis.run).toContain('"$PR_HEAD_SHA" "$PR_BASE_SHA"');
  });

  it.each(['0', '-1', '--help', '1; touch injected', '$(touch injected)', '1\nsha=bad'])('rejects untrusted PR number %s', value => {
    const result = runValidation(pr.steps.find(step => step.id === 'pr-details'), { PR_NUMBER: value });
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });

  it.each([{ movingHead: true }, { apiFailure: true }])('does not attribute failed or moving PR data to a commit: %j', fixture => {
    const result = runValidation(pr.steps.find(step => step.id === 'pr-details'), {}, fixture);
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });
});

describe('audit cycle read-only validation', () => {
  const workflow = readWorkflow('arcanos-audit-cycle');
  const job = workflow.jobs['enforce-cycle'];
  const step = job.steps.find(candidate => candidate.name === 'Validate audit config');
  const validConfig = { module: 'auto_audit_0432', cycle: '4WEEK', target: 'github.com/pbjustin/Arcanos' };
  it('cannot write to the repository and retains scheduled validation', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.schedule).toEqual([{ cron: '0 0 * * 0' }]);
    expect(job.steps.map(candidate => candidate.run || '').join('\n')).not.toMatch(/git\s|\bmv\b|>\s/u);
    expect(job.steps.find(candidate => candidate.uses?.startsWith('actions/checkout@')).with['persist-credentials']).toBe(false);
  });

  it.each([
    ['valid', validConfig, 0],
    ['wrong cycle', { module: 'auto_audit_0432', cycle: '1WEEK', target: 'github.com/pbjustin/Arcanos' }, 1],
    ['wrong module', { module: 'other', cycle: '4WEEK', target: 'github.com/pbjustin/Arcanos' }, 1],
    ['wrong target', { module: 'auto_audit_0432', cycle: '4WEEK', target: 'github.com/other/Repository' }, 1],
    ['null', null, 1], ['missing', undefined, 1],
    ['invalid then valid documents', '{}\n' + JSON.stringify(validConfig), 1],
    ['two valid documents', [validConfig, validConfig].map(value => JSON.stringify(value)).join('\n'), 1],
    ['empty file', '', 1], ['malformed JSON', '{', 1],
  ])('validates %s policy without rewriting the file', (_label, config, fails) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-policy-'));
    const file = path.join(directory, 'arcanos_audit_config.json');
    const source = typeof config === 'string' ? config : JSON.stringify(config);
    if (config !== undefined) writeFileSync(file, source);
    try {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: directory, encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, REPOSITORY: 'pbjustin/Arcanos' },
      });
      expect(Number(result.status !== 0)).toBe(fails);
      if (config !== undefined) expect(readFileSync(file, 'utf8')).toBe(source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


// Execute the workflow's narrow adapter with the real bounded bridge and an offline transport.
async function runAiAdvisory(fixture = {}) {
  const job = prWorkflow.jobs['ai-advisory'];
  const step = job.steps.find(candidate => candidate.name === 'Run explicitly authorized bounded advisory job');
  const source = /<<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(step.run)?.[1];
  if (!source) throw new Error('Missing reviewed inline advisory adapter');
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-authorized-advisory-'));
  const credential = 'synthetic-advisory-credential-for-tests';
  const environment = { AUTHORIZE_AI: 'true', PROVIDER_CONFIRMATION: 'AUTHORIZE ONE PR ADVISORY JOB',
    PR_HEAD_SHA: sha, PR_BASE_SHA: base, PR_NUMBER: '123', AUTHORIZED_HEAD_SHA: sha, SNAPSHOT_DIRECTORY: directory,
    ARCANOS_CORE_ADVISORY_BASE_URL: 'https://advisory.example.test',
    ARCANOS_CORE_ADVISORY_ACCESS_TOKEN: credential, ...fixture.environment };
  const requests = [];
  const runtime = { env: environment, exitCode: undefined };
  let report;
  const jobId = '11111111-1111-4111-8111-111111111111';
  const fetchFn = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(requests.length === 1 ? {
      ok: true, jobId, status: 'queued', deduped: false, resultEndpoint: '/gpt-access/jobs/result',
    } : { ok: true, jobId, status: 'completed', result: { findings: 'Review the changed check.',
      echo: credential, apiKey: credential } }),
    { status: requests.length === 1 ? 202 : 200, headers: { 'content-type': 'application/json' } });
  };
  writeFileSync(path.join(directory, 'pr-metadata.json'), JSON.stringify({ number: 123,
    head: { sha }, base: { sha: base }, ...fixture.metadata }));
  writeFileSync(path.join(directory, 'pr.diff'), fixture.diff ?? 'diff --git a/src/example.ts b/src/example.ts\n+return false;');
  const loadClient = async () => ({
    resolveArcanosCoreAdvisoryConfig: () => resolveArcanosCoreAdvisoryConfig(environment),
    createArcanosCoreAdvisoryClient: options => createArcanosCoreAdvisoryClient({ ...options, fetchFn }),
  });
  try {
    const body = source.replace(/^import .*;\n/gmu, '')
      .replace("await import('./dist/platform/operator/arcanosCoreAdvisoryClient.js')", 'await loadClient()');
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('process', 'readFileSync', 'lstatSync', 'writeFileSync', 'path',
      'loadClient', 'Buffer', 'console', body)(runtime, readFileSync, lstatSync,
      (_file, text) => { report = text; }, path, loadClient, Buffer, { error() {} });
    return { requests, report, exitCode: runtime.exitCode };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('explicitly authorized optional AI advice', () => {
  const job = prWorkflow.jobs['ai-advisory'];
  const consultation = job.steps.find(candidate => candidate.name === 'Run explicitly authorized bounded advisory job');
  it('defaults to no inference and requires both manual authorization controls on trusted main', () => {
    expect(prWorkflow.on.workflow_dispatch.inputs.ai_review).toMatchObject({ type: 'boolean', default: false });
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"
      + " && inputs.ai_review == true && inputs.provider_confirmation == 'AUTHORIZE ONE PR ADVISORY JOB'");
    expect(job.permissions).toEqual({ contents: 'read' });
    const admission = job.steps.find(step => step.name === 'Validate exact-head authorization');
    expect(admission.env.AUTHORIZED_HEAD_SHA).toBe('${{ inputs.authorized_head_sha }}');
    expect(admission.run).toContain('\"$AUTHORIZED_HEAD_SHA\" == \"$EXPECTED_HEAD_SHA\"');
    expect(job.steps.indexOf(admission)).toBeLessThan(job.steps.findIndex(step => step.run?.includes('npm ci')));
    expect(job.needs).toBe('arcanos-pr-analysis');
    expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with)
      .toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false });
    for (const step of job.steps.filter(step => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
    for (const step of job.steps.filter(step => step !== consultation))
      expect(JSON.stringify(step)).not.toMatch(/secrets\.|ARCANOS_CORE_ADVISORY_ACCESS_TOKEN/u);
    expect(consultation.env.ARCANOS_CORE_ADVISORY_ACCESS_TOKEN).toBe('${{ secrets.ARCANOS_CORE_ADVISORY_ACCESS_TOKEN }}');
    expect(consultation.run).toContain('timeout 180s');
    expect(consultation.run).toContain('pollDeadlineMs: 120000');
    expect(consultation.run).toContain('maxPolls: 30');
    expect(consultation.run).toContain('maxOutputTokens: 2048');
    expect(JSON.stringify(job)).not.toMatch(/OPENAI_API_KEY|npm start|github\.rest\.(?:checks|issues)|gh pr/u);
  });

  it('consults once for the exact captured head/base, retaining only sanitized advisory output', async () => {
    const result = await runAiAdvisory();
    expect(result.exitCode).toBeUndefined();
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].url).toBe('https://advisory.example.test/gpt-access/jobs/create');
    expect(result.requests[0].body).toMatchObject({ gptId: 'arcanos-core', maxOutputTokens: 2048 });
    expect(result.requests[0].body.context).toContain(`head ${sha}; base ${base}`);
    expect(result.requests[0].body.context).toContain('UNTRUSTED DIFF:');
    const report = JSON.parse(result.report);
    expect(report).toMatchObject({ advisoryOnly: true, prNumber: 123, headSha: sha, baseSha: base });
    expect(report.review.result).toEqual({ findings: 'Review the changed check.', echo: '[REDACTED]' });
    expect(result.report).not.toContain('synthetic-advisory-credential-for-tests');
  });

  it.each([
    ['default-disabled', { environment: { AUTHORIZE_AI: 'false' } }],
    ['missing phrase', { environment: { PROVIDER_CONFIRMATION: '' } }],
    ['wrong phrase', { environment: { PROVIDER_CONFIRMATION: 'approve' } }],
    ['moving head', { metadata: { head: { sha: 'c'.repeat(40) } } }],
    ['mismatched base', { metadata: { base: { sha: 'c'.repeat(40) } } }],
    ['different PR', { metadata: { number: 124 } }],
    ['invalid identity', { environment: { PR_HEAD_SHA: 'main' } }],
    ['unauthorized head', { environment: { AUTHORIZED_HEAD_SHA: 'c'.repeat(40) } }],
    ['missing authorized head', { environment: { AUTHORIZED_HEAD_SHA: '' } }],
    ['oversized context', { diff: 'x'.repeat(12000) }],
    ['oversized file', { diff: 'x'.repeat(48001) }],
    ['empty diff', { diff: ' ' }],
    ['credential-shaped diff', { diff: '+api_key=synthetic-provider-secret-value' }],
    ['configured credential in diff', { diff: '+synthetic-advisory-credential-for-tests' }],
    ['missing configuration', { environment: { ARCANOS_CORE_ADVISORY_ACCESS_TOKEN: '' } }],
    ['redirectable origin', { environment: { ARCANOS_CORE_ADVISORY_BASE_URL: 'https://advisory.example.test/path' } }],
  ])('rejects %s before any remote request or report', async (_label, fixture) => {
    const result = await runAiAdvisory(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.requests).toEqual([]);
    expect(result.report).toBeUndefined();
  });
});
