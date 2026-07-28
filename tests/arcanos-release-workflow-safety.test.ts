import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type WorkflowDefinition = {
  jobs?: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
};

const workflowText = readFileSync(
  '.github/workflows/arcanos-release.yml',
  'utf8',
).replaceAll('\r\n', '\n');
const workflow = yaml.load(workflowText) as WorkflowDefinition;

function job(name: string): WorkflowJob {
  const value = workflow.jobs?.[name];
  expect(value).toBeDefined();
  return value ?? {};
}

function steps(name: string): WorkflowStep[] {
  const value = job(name).steps;
  expect(Array.isArray(value)).toBe(true);
  return value ?? [];
}

function namedStep(jobName: string, stepName: string): WorkflowStep {
  const value = steps(jobName).find(step => step.name === stepName);
  expect(value).toBeDefined();
  return value ?? {};
}

function runText(step: WorkflowStep): string {
  expect(typeof step.run).toBe('string');
  return step.run ?? '';
}

describe('ARCANOS release workflow safety', () => {
  it('parses as YAML with separate validation and publication jobs', () => {
    expect(workflow).toBeDefined();
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      'validate-release',
      'publish-release',
    ]);
    expect(job('publish-release').needs).toBe('validate-release');
  });

  it('pins every action to an immutable reviewed commit', () => {
    const allowedActions = new Set([
      'actions/checkout',
      'actions/download-artifact',
      'actions/setup-node',
      'actions/setup-python',
      'actions/upload-artifact',
    ]);
    const actionSteps = Object.values(workflow.jobs ?? {})
      .flatMap(value => value.steps ?? [])
      .filter(step => step.uses);

    expect(actionSteps.length).toBeGreaterThan(0);
    for (const step of actionSteps) {
      const match = /^([^@]+)@([0-9a-f]{40})$/.exec(step.uses ?? '');
      expect(match).not.toBeNull();
      expect(allowedActions.has(match?.[1] ?? '')).toBe(true);
    }
  });

  it('requires authoritative CI success for the exact release commit', () => {
    const validationSteps = steps('validate-release');
    const resolveIndex = validationSteps.findIndex(
      step => step.name === 'Resolve and check out the exact release tag',
    );
    const ciIndex = validationSteps.findIndex(
      step => step.name === 'Require successful authoritative CI for the exact commit',
    );
    const auditIndex = validationSteps.findIndex(
      step =>
        step.name ===
        'Enforce the trusted Node dependency audit policy before installation',
    );
    const installIndex = validationSteps.findIndex(
      step => step.name === 'Install dependencies without lifecycle scripts',
    );
    const resolve = runText(validationSteps[resolveIndex] ?? {});
    const ciGate = runText(validationSteps[ciIndex] ?? {});

    expect(resolveIndex).toBeGreaterThan(-1);
    expect(ciIndex).toBeGreaterThan(resolveIndex);
    expect(ciIndex).toBeLessThan(auditIndex);
    expect(ciIndex).toBeLessThan(installIndex);
    expect(resolve).toContain('semverTag.test(tag)');
    expect(resolve).toContain('tag_ref="refs/tags/${TAG_NAME}"');
    expect(resolve).toContain('git merge-base --is-ancestor "$commit_sha" "$default_ref"');
    expect(ciGate).toContain(
      '"repos/${GH_REPO}/actions/workflows/ci-cd.yml/runs"',
    );
    expect(ciGate).toContain('-f head_sha="$COMMIT_SHA"');
    expect(ciGate).toContain("run?.name === 'CI/CD Pipeline'");
    expect(ciGate).toContain("run?.path === '.github/workflows/ci-cd.yml'");
    expect(ciGate).toContain('run?.head_sha === expectedSha');
    expect(ciGate).toContain("run?.conclusion === 'success'");
  });

  it('runs every mandatory gate in both full and patch modes', () => {
    const mandatorySteps = [
      'Require successful authoritative CI for the exact commit',
      'Enforce the trusted Node dependency audit policy before installation',
      'Set up Python',
      'Enforce the Python dependency audit policy before installation',
      'Install dependencies without lifecycle scripts',
      'Generate Prisma client type stubs',
      'Verify installation left the tracked tree clean',
      'Type-check',
      'Lint',
      'Build',
      'Validate Railway compatibility',
      'Test',
      'Verify validation left the tracked tree clean',
      'Generate deterministic release notes',
      'Upload deterministic release notes',
    ];

    for (const name of mandatorySteps) {
      expect(namedStep('validate-release', name).if).toBeUndefined();
    }
  });

  it('audits before candidate installation or repository scripts', () => {
    const validationSteps = steps('validate-release');
    const nodeAuditIndex = validationSteps.findIndex(step =>
      step.name?.startsWith('Enforce the trusted Node dependency audit policy'),
    );
    const pythonAuditIndex = validationSteps.findIndex(step =>
      step.name?.startsWith('Enforce the Python dependency audit policy'),
    );
    const installIndex = validationSteps.findIndex(
      step => step.name === 'Install dependencies without lifecycle scripts',
    );
    const prismaGenerationIndex = validationSteps.findIndex(
      step => step.name === 'Generate Prisma client type stubs',
    );
    const typeCheckIndex = validationSteps.findIndex(step => step.name === 'Type-check');
    const resolve = runText(
      namedStep('validate-release', 'Resolve and check out the exact release tag'),
    );
    const nodeAudit = runText(validationSteps[nodeAuditIndex] ?? {});
    const pythonAudit = runText(validationSteps[pythonAuditIndex] ?? {});
    const install = runText(validationSteps[installIndex] ?? {});
    const prismaGeneration = runText(
      validationSteps[prismaGenerationIndex] ?? {},
    );

    expect(nodeAuditIndex).toBeGreaterThan(-1);
    expect(pythonAuditIndex).toBeGreaterThan(nodeAuditIndex);
    expect(installIndex).toBeGreaterThan(pythonAuditIndex);
    expect(prismaGenerationIndex).toBe(installIndex + 1);
    expect(typeCheckIndex).toBeGreaterThan(prismaGenerationIndex);
    expect(resolve.indexOf('cp scripts/check-npm-audit.js')).toBeLessThan(
      resolve.indexOf('git checkout --detach "$commit_sha"'),
    );
    expect(nodeAudit).toContain('report.auditReportVersion !== 2');
    expect(nodeAudit).toContain('node "$AUDIT_POLICY_PATH" npm-audit.json');
    expect(nodeAudit).not.toMatch(/npm audit[^\n]*\|\|\s*echo/);
    expect(pythonAudit).toContain('"pip-audit==2.10.1"');
    expect(pythonAudit).toContain('--ignore-vuln CVE-2026-4539');
    expect(install.trim()).toBe('npm ci --ignore-scripts');
    expect(prismaGeneration.trim()).toBe(
      'node node_modules/@prisma/client/scripts/postinstall.js',
    );

    const preInstallRuns = validationSteps
      .slice(0, installIndex)
      .map(step => step.run ?? '')
      .join('\n');
    expect(preInstallRuns).not.toMatch(/\bnpm (?:run|start|test)\b/);

    const explicitLifecycleCommands = validationSteps
      .slice(0, typeCheckIndex)
      .flatMap(step => (step.run ?? '').split('\n'))
      .map(line => line.trim())
      .filter(line =>
        /^(?:npm (?:run|exec) (?:preinstall|install|postinstall)|node node_modules\/\S+\/scripts\/(?:preinstall|install|postinstall)\.(?:c?js|mjs))$/.test(
          line,
        ),
      );
    expect(explicitLifecycleCommands).toEqual([
      'node node_modules/@prisma/client/scripts/postinstall.js',
    ]);
  });

  it('fails if installation or validation changes tracked files', () => {
    for (const name of [
      'Verify installation left the tracked tree clean',
      'Verify validation left the tracked tree clean',
    ]) {
      const check = runText(namedStep('validate-release', name));
      expect(check).toContain('git status --porcelain=v1 --untracked-files=no');
      expect(check).toContain('exit 1');
    }
  });

  it('passes only deterministic notes between jobs and never manages release assets', () => {
    const upload = namedStep('validate-release', 'Upload deterministic release notes');
    const download = namedStep('publish-release', 'Download deterministic release notes');

    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.with?.path).toBe('release_notes.md');
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(workflowText).not.toMatch(/\.tar\.gz|release-artifacts|artifact_filename/i);
    expect(workflowText).not.toContain('gh release upload');
    expect(workflowText).not.toContain('--clobber');
  });

  it('rechecks the remote tag in the same step immediately before notes mutation', () => {
    const validationRuns = steps('validate-release')
      .map(step => step.run ?? '')
      .join('\n');
    const publicationSteps = steps('publish-release');
    const publication = namedStep(
      'publish-release',
      'Recheck the remote tag and publish deterministic notes',
    );
    const publishRun = runText(publication);

    expect(validationRuns).not.toMatch(/\bgh release (?:create|edit|upload|delete)\b/);
    for (const step of publicationSteps.filter(step => step !== publication)) {
      expect(step.run ?? '').not.toMatch(/\bgh release (?:create|edit|upload|delete)\b/);
    }

    expect(publishRun).toContain(
      'gh api "repos/${GH_REPO}/git/ref/tags/${TAG_NAME}" --jq .object.sha',
    );
    expect(publishRun).toMatch(
      /assert_remote_tag_unchanged\n\s+gh release edit "\$TAG_NAME"/,
    );
    expect(publishRun).toMatch(
      /assert_remote_tag_unchanged\n\s+gh release create "\$TAG_NAME"/,
    );
    expect(publishRun).toContain(
      'gh release view "$TAG_NAME" --repo "$GH_REPO" --json body',
    );
  });

  it('uses least privilege and contains no AI or provider-secret release path', () => {
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(job('validate-release').permissions).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(job('publish-release').permissions).toEqual({
      actions: 'read',
      contents: 'write',
    });
    expect(workflowText).not.toMatch(
      /OPENAI_API_KEY|include_ai_notes|AI-assisted|\/gpt\/|npm start/,
    );
    expect(workflowText).not.toMatch(/actions: write|issues: write|pull-requests: write/);
  });
});
