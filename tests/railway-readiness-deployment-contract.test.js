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
    expect(deploy).toContain('railway up');
    expect(deploy).toContain('--detach');
    expect(deploy).toContain('--json');
    expect(deploy).toContain('deploy_result_json');
    expect(deploy).toContain('payload.deploymentId');
    expect(deploy).toContain('DEPLOYMENT_ID');
    expect(deploy).toContain('RAILWAY_DEPLOYMENT_ID_INVALID');
    expect(deploy).toContain('--message "GitHub auto deploy ${DEPLOY_REF}"');

    const wait = namedStep('Wait for deployment success').run;
    expect(wait).toContain('railway deployment list');
    expect(wait).toContain('process.env.DEPLOYMENT_ID');
    expect(wait).toContain('candidate?.id === expectedDeploymentId');
    expect(wait).toContain('final_status');
    expect(wait).toContain('SUCCESS');
    expect(wait).toContain('RAILWAY_DEPLOYMENT_ID_INVALID');
    expect(wait).toContain('RAILWAY_DEPLOYMENT_STATUS_INVALID');
    expect(wait).toContain("readFileSync(0, 'utf8')");
    expect(wait).not.toMatch(/echo "DEPLOYMENT_ID=.*GITHUB_ENV/u);
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
      'node scripts/validate-railway-compatibility.js',
    );
    expect(evidence).toContain('railway deployment list');
    expect(evidence).toContain('railway service status');
    expect(evidence).toContain('railway variable list');
    expect(evidence).toContain('DEPLOYMENT_ID');
    expect(evidence).toContain('RAILWAY_READINESS_ACTIVATION_EVIDENCE_MISMATCH');
    expect(evidence).toContain('verify-railway-readiness-activation.mjs');
    expect(evidence).toMatch(/variable.+list.+verify-railway-readiness-activation\.mjs/su);
    expect(evidence).not.toContain('variables_json=');
    expect(evidence).toMatch(
      /deployment list.+activation_status_before_json.+variable list.+verify-railway-readiness-activation\.mjs.+activation_status_after_json/su,
    );
    expect(evidence).toContain('tracked_healthcheck=/readyz');
    expect(evidence).toContain('tracked_drainingSeconds=60');
    expect(evidence).toContain('effective_settings_readback=required');
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
