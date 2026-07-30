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
// Freeze the complete security-critical bodies so an appended download or
// command cannot inherit trust or the project token without explicit review.
const INSTALL_STEP_RUN_SHA256 =
  '6eab131a43da49cf62f45780558cb138190c5e3566cd430d36a0713abef6c509';
const TOKEN_STEP_RUN_SHA256 = {
  'Verify Railway deploy access':
    '3b23fc90193f745b9fb062c90635b62ab6362c5ae36f0f14b76d6f421617ed3b',
  'Deploy to Railway':
    'b87d0d732ea80d54eb2625ce21a795b2becf0aedf0cf54d5520b1b486aace0a5',
  'Wait for deployment success':
    '7b57b212736f4293b252ae3f579ec05b68753cbdcafc1b9ed366553cc36e4b76',
  'Post-deploy watchdog/budget regression check':
    '74c9d80317bdfa3de7c1cb5e4083013a0f116646388fe5d1c8455142f81ed674',
};
const TOKEN_STEP_REQUIRED_COMMAND = {
  'Verify Railway deploy access': 'railway variable list',
  'Deploy to Railway': 'railway up',
  'Wait for deployment success': 'railway service status',
  'Post-deploy watchdog/budget regression check':
    'node scripts/check-railway-timeout-regressions.js',
};

const workflowText = readFileSync(
  '.github/workflows/railway-auto-deploy.yml',
  'utf8',
).replaceAll('\r\n', '\n');
const workflow = yaml.load(workflowText);

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
  });
});
