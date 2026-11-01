import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

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
const fixture = JSON.parse(process.env.FIXTURE);
if (fixture.apiFailure) process.exit(1);
if (args[1].includes('/compare/')) console.log(fixture.compareStatus || 'ahead');
else if (args[1].includes('/files?')) console.log('src/example.ts');
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
    expect(JSON.stringify(workflow)).not.toMatch(/secrets\.|checks\.create|issues\.(?:create|update)|Ready for merge|continue-on-error/iu);
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
  it('cannot write to the repository and retains scheduled validation', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.schedule).toEqual([{ cron: '0 0 * * 0' }]);
    expect(job.steps.map(candidate => candidate.run || '').join('\n')).not.toMatch(/git\s|\bmv\b|>\s/u);
    expect(job.steps.find(candidate => candidate.uses?.startsWith('actions/checkout@')).with['persist-credentials']).toBe(false);
  });

  it.each([
    ['valid', { module: 'auto_audit_0432', cycle: '4WEEK', target: 'github.com/pbjustin/Arcanos' }, 0],
    ['wrong cycle', { module: 'auto_audit_0432', cycle: '1WEEK', target: 'github.com/pbjustin/Arcanos' }, 1],
    ['wrong module', { module: 'other', cycle: '4WEEK', target: 'github.com/pbjustin/Arcanos' }, 1],
    ['wrong target', { module: 'auto_audit_0432', cycle: '4WEEK', target: 'github.com/other/Repository' }, 1],
    ['null', null, 1], ['missing', undefined, 1],
  ])('validates %s policy without rewriting the file', (_label, config, fails) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-policy-'));
    const file = path.join(directory, 'arcanos_audit_config.json');
    if (config !== undefined) writeFileSync(file, JSON.stringify(config));
    try {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: directory, encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, REPOSITORY: 'pbjustin/Arcanos' },
      });
      expect(Number(result.status !== 0)).toBe(fails);
      if (config !== undefined) expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(config));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
