import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';

const CHECKOUT_ACTION =
  'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955';
const SETUP_NODE_ACTION =
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const RAILWAY_CLI_VERSION = '4.30.2';
const RAILWAY_CLI_ARCHIVE_SHA256 =
  'e8bd57fd6517b5cf387a9c072ce79fdc069fc0b877c171b58e325b22e96c9000';
const RAILWAY_PROJECT_TOKEN_SECRET =
  '${{ secrets.RAILWAY_PRODUCTION_PROJECT_TOKEN }}';
const RAILWAY_TOKEN_STEPS = [
  'Verify Railway deploy access',
  'Deploy to Railway',
  'Wait for deployment success',
  'Post-deploy watchdog/budget regression check',
];
// Freeze the complete security-critical step bodies and checked-in executors
// so appended behavior cannot inherit the project token without review.
const INSTALL_STEP_RUN_SHA256 =
  '6eab131a43da49cf62f45780558cb138190c5e3566cd430d36a0713abef6c509';
const DEPLOYMENT_OBSERVER_SOURCE_SHA256 =
  '6a75386ce311ff2ef340ccab1fa1528ed1ad676de5172fd9fa34cde8d40fe626';
const TIMEOUT_WATCHDOG_SOURCE_SHA256 =
  '717a6cda82721d2eb53d6099f462c8738212785e288fbebc3d6855d222bd11e4';
const READINESS_VERIFIER_SOURCE_SHA256 =
  'd17d5ae7e421728d2523f55da699226f9c3532e53f1745f01ad444768c211b66';
const TOKEN_STEP_RUN_SHA256 = {
  'Verify Railway deploy access':
    '5594ef732d5aa25c48c5eee8f15c83e1aa2fdad33058074a301cb0cba2668868',
  'Deploy to Railway':
    '1a65dde7985f4786070584891d58f29a2280dd139fe81e2b4b36828cf3403c2d',
  'Wait for deployment success':
    '24996df67931a7a165387514cd6bc1f6d527ab108815b028ec2bcbb982e79dce',
  'Post-deploy watchdog/budget regression check':
    '74c9d80317bdfa3de7c1cb5e4083013a0f116646388fe5d1c8455142f81ed674',
};
const TOKEN_STEP_REQUIRED_COMMAND = {
  'Verify Railway deploy access':
    'node scripts/railway-auto-deploy-observer.mjs variables',
  'Deploy to Railway':
    'node scripts/railway-auto-deploy-observer.mjs enqueue',
  'Wait for deployment success':
    'node scripts/railway-auto-deploy-observer.mjs wait',
  'Post-deploy watchdog/budget regression check':
    'node scripts/check-railway-timeout-regressions.js',
};

const workflowText = readFileSync(
  '.github/workflows/railway-auto-deploy.yml',
  'utf8',
).replaceAll('\r\n', '\n');
const workflow = yaml.load(workflowText);
const deploymentObserverSource = readFileSync(
  'scripts/railway-auto-deploy-observer.mjs',
  'utf8',
).replaceAll('\r\n', '\n');
const timeoutWatchdogSource = readFileSync(
  'scripts/check-railway-timeout-regressions.js',
  'utf8',
).replaceAll('\r\n', '\n');
const readinessVerifierSource = readFileSync(
  'scripts/verify-railway-readiness-activation.mjs',
  'utf8',
).replaceAll('\r\n', '\n');

function job(name) {
  const value = workflow.jobs?.[name];
  expect(value).toBeDefined();
  return value ?? {};
}

function namedStep(jobName, stepName) {
  const value = job(jobName).steps?.find(step => step.name === stepName);
  expect(value).toBeDefined();
  return value ?? {};
}

function collectSecretReferences(value, references = []) {
  if (typeof value === 'string') {
    if (/\bsecrets\b/u.test(value)) {
      references.push(value);
    }
    return references;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretReferences(item, references);
    }
    return references;
  }

  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      collectSecretReferences(child, references);
    }
  }

  return references;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

describe('Railway auto-deploy supply-chain containment', () => {
  it('uses only the reviewed immutable Action commits', () => {
    const actionReferences = Object.values(workflow.jobs ?? {}).flatMap(
      workflowJob =>
        (workflowJob.steps ?? [])
          .map(step => step.uses)
          .filter(reference => reference !== undefined),
    );

    expect(actionReferences).toEqual([
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
    ]);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
  });

  it('verifies the exact Railway CLI archive before executing it', () => {
    const installStep = namedStep(
      'deploy-production',
      'Install verified Railway CLI',
    );
    const script = installStep.run ?? '';

    expect(installStep.shell).toBe('bash');
    expect(installStep.env).toEqual({
      RAILWAY_CLI_VERSION,
      RAILWAY_CLI_ARCHIVE_SHA256,
    });
    expect(script.split('\n').find(line => line.trim() !== '')).toBe(
      'set -euo pipefail',
    );
    expect(script).not.toMatch(/(?:\|\||;)\s*true/u);
    expect(script).toContain(
      'https://github.com/railwayapp/cli/releases/download/v${RAILWAY_CLI_VERSION}/railway-v${RAILWAY_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz',
    );
    expect(script).toContain("curl --fail --silent --show-error --location");
    expect(script).toContain("--proto '=https'");
    expect(script).toContain('--tlsv1.2');
    expect(script).toMatch(
      /curl[\s\S]*"\$\{download_url\}" \\\n\s+--output "\$\{archive\}"/u,
    );
    expect(script).toContain(
      `printf '%s  %s\\n' "\${RAILWAY_CLI_ARCHIVE_SHA256}" "\${archive}" |`,
    );
    expect(script.split('\n')).toContain('  sha256sum --check --strict');
    expect(script).toContain('tar -xzf "${archive}" -C "${bin_dir}"');
    expect(script).toContain('"${bin_dir}/railway" --version');
    expect(script).toContain(
      'expected_version="railway ${RAILWAY_CLI_VERSION}"',
    );
    expect(script).toContain('test "${actual_version}" = "${expected_version}"');
    expect(script).toContain('echo "${bin_dir}" >> "${GITHUB_PATH}"');
    expect(script).not.toMatch(/npm|@railway\/cli/u);

    const downloadIndex = script.indexOf('curl ');
    const checksumIndex = script.indexOf('sha256sum --check --strict');
    const extractionIndex = script.indexOf('tar -xzf');
    const executionIndex = script.indexOf('"${bin_dir}/railway" --version');
    const versionCheckIndex = script.indexOf(
      'test "${actual_version}" = "${expected_version}"',
    );
    const pathPublicationIndex = script.indexOf(
      'echo "${bin_dir}" >> "${GITHUB_PATH}"',
    );
    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(checksumIndex).toBeGreaterThan(downloadIndex);
    expect(extractionIndex).toBeGreaterThan(checksumIndex);
    expect(executionIndex).toBeGreaterThan(extractionIndex);
    expect(versionCheckIndex).toBeGreaterThan(executionIndex);
    expect(pathPublicationIndex).toBeGreaterThan(versionCheckIndex);
    expect(sha256(script)).toBe(INSTALL_STEP_RUN_SHA256);
  });

  it('freezes the repository-owned executors that receive the project token', () => {
    expect(sha256(deploymentObserverSource)).toBe(
      DEPLOYMENT_OBSERVER_SOURCE_SHA256,
    );
    expect(sha256(timeoutWatchdogSource)).toBe(
      TIMEOUT_WATCHDOG_SOURCE_SHA256,
    );
    expect(sha256(readinessVerifierSource)).toBe(
      READINESS_VERIFIER_SOURCE_SHA256,
    );
  });

  it('exposes one project token only to the four Railway CLI steps', () => {
    const deployJob = job('deploy-production');
    const deploySteps = deployJob.steps ?? [];
    const validationStep = namedStep(
      'deploy-production',
      'Validate deploy configuration',
    );

    expect(deployJob.env?.RAILWAY_TOKEN).toBeUndefined();
    expect(deployJob.env?.RAILWAY_API_TOKEN).toBeUndefined();
    expect(workflowText).not.toContain('RAILWAY_API_TOKEN');
    expect(workflowText).not.toContain('secrets.RAILWAY_TOKEN');

    expect(validationStep.env).toEqual({
      RAILWAY_PROJECT_TOKEN_CONFIGURED:
        "${{ secrets.RAILWAY_PRODUCTION_PROJECT_TOKEN != '' }}",
    });
    expect(validationStep.run).toContain(
      '"${RAILWAY_PROJECT_TOKEN_CONFIGURED}" != "true"',
    );
    expect(validationStep.run).not.toContain('${RAILWAY_TOKEN');

    const tokenSteps = deploySteps.filter(step =>
      Object.hasOwn(step.env ?? {}, 'RAILWAY_TOKEN'),
    );
    expect(tokenSteps.map(step => step.name)).toEqual(RAILWAY_TOKEN_STEPS);
    for (const step of tokenSteps) {
      expect(step.env).toEqual({
        RAILWAY_TOKEN: RAILWAY_PROJECT_TOKEN_SECRET,
      });
      expect(step.run).toContain(TOKEN_STEP_REQUIRED_COMMAND[step.name]);
      expect(step.run).not.toMatch(/(^|\s)npm(?:\s|$)/u);
      expect(sha256(step.run ?? '')).toBe(TOKEN_STEP_RUN_SHA256[step.name]);
    }

    expect(
      collectSecretReferences(workflow).sort(),
    ).toEqual(
      [
        "${{ secrets.RAILWAY_PRODUCTION_PROJECT_TOKEN != '' }}",
        ...RAILWAY_TOKEN_STEPS.map(() => RAILWAY_PROJECT_TOKEN_SECRET),
      ].sort(),
    );

    expect(
      namedStep(
        'deploy-production',
        'Post-deploy watchdog/budget regression check',
      ).run,
    ).toContain('node scripts/check-railway-timeout-regressions.js');
    expect(
      namedStep(
        'deploy-production',
        'Post-deploy watchdog/budget regression check',
      ).run,
    ).not.toContain('npm run');

    const waitScript = namedStep(
      'deploy-production',
      'Wait for deployment success',
    ).run;
    expect(waitScript).toContain(
      'env -u RAILWAY_TOKEN node scripts/validate-railway-compatibility.js',
    );
    expect(waitScript).toContain(
      '| env -u RAILWAY_TOKEN node scripts/verify-railway-readiness-activation.mjs',
    );
  });
});
