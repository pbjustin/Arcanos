import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';

const workflow = yaml.load(
  readFileSync('.github/workflows/railway-auto-deploy.yml', 'utf8'),
);
const smokeHelperSource = readFileSync(
  'scripts/railway-production-smoke-check.js',
  'utf8',
);
const deploymentObserverSource = readFileSync(
  'scripts/railway-auto-deploy-observer.mjs',
  'utf8',
);
const timeoutRegressionSource = readFileSync(
  'scripts/check-railway-timeout-regressions.js',
  'utf8',
);

function deploymentSteps() {
  const steps = workflow.jobs?.['deploy-production']?.steps;
  expect(Array.isArray(steps)).toBe(true);
  return steps ?? [];
}

function namedStep(name) {
  const step = deploymentSteps().find(candidate => candidate.name === name);
  expect(step).toBeDefined();
  return step ?? {};
}

describe('Railway role-aware deployment evidence', () => {
  it('binds Railway SUCCESS to the exact deployment created by this upload', () => {
    const steps = deploymentSteps();
    const names = steps.map(step => step.name);

    expect(names.indexOf('Deploy to Railway')).toBeLessThan(
      names.indexOf('Wait for deployment success'),
    );
    expect(names).not.toContain('Capture current deployment identity');
    expect(names).not.toContain('Verify role-aware readiness activation');

    const deploy = namedStep('Deploy to Railway').run;
    expect(deploy).toContain(
      'node scripts/railway-auto-deploy-observer.mjs enqueue',
    );
    expect(deploy).toContain('DEPLOYMENT_ID');
    expect(deploy).toContain('--deploy-ref "${DEPLOY_REF}"');

    const wait = namedStep('Wait for deployment success').run;
    expect(wait).toContain(
      'node scripts/railway-auto-deploy-observer.mjs wait',
    );
    expect(wait).toContain('--deployment-id "${DEPLOYMENT_ID}"');
    expect(wait).not.toContain('railway deployment list');
    expect(wait).not.toContain('seq ');
    expect(wait).not.toContain("readFileSync(0, 'utf8')");
    expect(wait).not.toMatch(/echo "DEPLOYMENT_ID=.*GITHUB_ENV/u);

    expect(deploymentObserverSource).toContain("'--detach'");
    expect(deploymentObserverSource).toContain(
      'DEPLOYMENT_OBSERVATION_TIMEOUT_MS = 45 * 60_000',
    );
    expect(deploymentObserverSource).toContain("from 'node:perf_hooks'");
    expect(deploymentObserverSource).toContain(
      'now = () => performance.now()',
    );
    expect(deploymentObserverSource).not.toContain('now = Date.now');
    expect(deploymentObserverSource).toContain('maxBuffer');
    expect(deploymentObserverSource).not.toContain('shell: true');
  });

  it('binds post-deploy evidence to an exact-target readiness request and drain contract', () => {
    const steps = deploymentSteps();
    const names = steps.map(step => step.name);
    const evidenceName = 'Wait for deployment success';

    expect(names.indexOf(evidenceName)).toBeLessThan(
      names.indexOf('Post-deploy watchdog/budget regression check'),
    );

    const evidence = namedStep(evidenceName).run;
    expect(evidence).toContain(
      'env -u RAILWAY_TOKEN node scripts/validate-railway-compatibility.js',
    );
    expect(evidence).toContain(
      'node scripts/railway-auto-deploy-observer.mjs verify-active',
    );
    expect(evidence).toContain(
      'node scripts/railway-auto-deploy-observer.mjs variables',
    );
    expect(evidence).toContain('DEPLOYMENT_ID');
    expect(evidence).toContain('verify-railway-readiness-activation.mjs');
    expect(evidence).toMatch(
      /railway-auto-deploy-observer\.mjs variables.+env -u RAILWAY_TOKEN node scripts\/verify-railway-readiness-activation\.mjs/su,
    );
    expect(evidence).not.toContain('variables_json=');
    expect(evidence).toMatch(
      /railway-auto-deploy-observer\.mjs wait.+railway-auto-deploy-observer\.mjs verify-active.+railway-auto-deploy-observer\.mjs variables.+verify-railway-readiness-activation\.mjs.+railway-auto-deploy-observer\.mjs verify-active/su,
    );
    expect(evidence).toContain('tracked_healthcheck=/readyz');
    expect(evidence).toContain('tracked_drainingSeconds=60');
    expect(evidence).toContain('effective_settings_readback=required');
  });

  it('serializes production observers and bounds every remote read', () => {
    const deployJob = workflow.jobs?.['deploy-production'] ?? {};
    const access = namedStep('Verify Railway deploy access').run ?? '';
    const deploy = namedStep('Deploy to Railway').run ?? '';
    const wait = namedStep('Wait for deployment success').run ?? '';

    expect(deployJob.concurrency).toEqual({
      group: 'railway-auto-deploy-production',
      'cancel-in-progress': false,
    });
    expect(deployJob['timeout-minutes']).toBe(60);
    expect(access).toContain(
      'node scripts/railway-auto-deploy-observer.mjs variables',
    );
    expect(`${access}\n${deploy}\n${wait}`).not.toMatch(
      /^\s*railway\s+/mu,
    );
    expect(deploymentObserverSource).toContain('timeout: limits.timeoutMs');
    expect(deploymentObserverSource).toContain(
      'maxBuffer: limits.maxBufferBytes',
    );
  });

  it('bounds the post-deploy watchdog Railway log query', () => {
    expect(timeoutRegressionSource).toContain(
      'const RAILWAY_LOG_QUERY_TIMEOUT_MS = 30_000',
    );
    expect(timeoutRegressionSource).toContain(
      'const RAILWAY_LOG_QUERY_MAX_BUFFER_BYTES = 4 * 1024 * 1024',
    );
    expect(timeoutRegressionSource).toContain(
      'timeout: RAILWAY_LOG_QUERY_TIMEOUT_MS',
    );
    expect(timeoutRegressionSource).toContain(
      'maxBuffer: RAILWAY_LOG_QUERY_MAX_BUFFER_BYTES',
    );
  });

  it('keeps the manual smoke helper read-only and explicitly scopes environment-aware reads', () => {
    expect(smokeHelperSource).not.toMatch(
      /executeRailwayCommand\(\[\s*['"]environment['"]/u,
    );
    expect(smokeHelperSource).toMatch(
      /readJsonCommand\(\[\s*['"]variables['"],\s*['"]--service['"],\s*roleServices\.app\.name,\s*['"]--environment['"],\s*config\.environment,\s*['"]--json['"]\]\)/u,
    );
    expect(smokeHelperSource).toMatch(
      /readJsonCommand\(\[\s*['"]variables['"],\s*['"]--service['"],\s*roleServices\.worker\.name,\s*['"]--environment['"],\s*config\.environment,\s*['"]--json['"]\]\)/u,
    );
  });
});
