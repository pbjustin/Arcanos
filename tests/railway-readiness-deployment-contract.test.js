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
const deploymentGuide = readFileSync('docs/RAILWAY_DEPLOYMENT.md', 'utf8');
const migrationGuide = readFileSync('docs/DATABASE_MIGRATIONS.md', 'utf8');

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
  it('requires distinct explicit web and worker targets and never green-skips missing configuration', () => {
    const deployJob = workflow.jobs?.['deploy-production'] ?? {};
    const validation = namedStep('Validate deploy configuration').run ?? '';

    expect(deployJob.env).toMatchObject({
      RAILWAY_PROJECT_ID: '${{ vars.RAILWAY_PROJECT_ID }}',
      RAILWAY_WEB_SERVICE_ID: '${{ vars.RAILWAY_WEB_SERVICE_ID }}',
      RAILWAY_WORKER_SERVICE_ID: '${{ vars.RAILWAY_WORKER_SERVICE_ID }}',
      RAILWAY_ENVIRONMENT_NAME: '${{ vars.RAILWAY_ENVIRONMENT_NAME }}',
    });
    expect(deployJob.env?.RAILWAY_SERVICE_ID).toBeUndefined();
    expect(validation).toContain('RAILWAY_WEB_SERVICE_ID');
    expect(validation).toContain('RAILWAY_WORKER_SERVICE_ID');
    expect(validation).toContain('RAILWAY_ENVIRONMENT_NAME');
    expect(validation).toContain('RAILWAY_PAIRED_SERVICE_IDS_NOT_DISTINCT');
    expect(validation).not.toContain('defaulting to production');
    expect(validation).not.toContain('should_deploy=false');
    expect(deploymentSteps().map(step => step.name)).not.toContain(
      'Skip auto deploy when Railway credentials are missing',
    );
  });

  it('promotes and observes the exact worker deployment before the exact web deployment', () => {
    const steps = deploymentSteps();
    const names = steps.map(step => step.name);

    expect(names.indexOf('Validate Railway compatibility')).toBeLessThan(
      names.indexOf('Verify paired Railway targets'),
    );
    expect(names.indexOf('Verify paired Railway targets')).toBeLessThan(
      names.indexOf('Deploy and verify Railway worker'),
    );
    expect(names.indexOf('Deploy and verify Railway worker')).toBeLessThan(
      names.indexOf('Deploy and verify Railway web pair'),
    );

    const worker = namedStep('Deploy and verify Railway worker').run;
    expect(worker).toContain(
      'node scripts/railway-auto-deploy-observer.mjs enqueue',
    );
    expect(worker).toContain('WORKER_DEPLOYMENT_ID');
    expect(worker).toContain('--service "${RAILWAY_WORKER_SERVICE_ID}"');
    expect(worker).toContain('--deploy-ref "${DEPLOY_REF}"');
    expect(worker).toContain(
      'node scripts/railway-auto-deploy-observer.mjs wait',
    );
    expect(worker).toContain('--deployment-id "${worker_deployment_id}"');

    const web = namedStep('Deploy and verify Railway web pair').run;
    expect(web).toContain(
      'node scripts/railway-auto-deploy-observer.mjs enqueue',
    );
    expect(web).toContain('WEB_DEPLOYMENT_ID');
    expect(web).toContain('--service "${RAILWAY_WEB_SERVICE_ID}"');
    expect(web).toContain('--deploy-ref "${DEPLOY_REF}"');
    expect(web).toContain(
      'node scripts/railway-auto-deploy-observer.mjs wait',
    );
    expect(web).toContain('--deployment-id "${web_deployment_id}"');

    for (const script of [worker, web]) {
      expect(script).not.toContain('railway deployment list');
      expect(script).not.toContain('seq ');
      expect(script).not.toContain("readFileSync(0, 'utf8')");
    }

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

  it('requires candidate-sidecar preparation before the paired worker-web promotion', () => {
    const deploymentSectionStart = deploymentGuide.indexOf(
      'The monolithic Notion candidate-search sidecar requires a staged Railway',
    );
    const deploymentSectionEnd = deploymentGuide.indexOf(
      '\nRollback is old-reader/old-writer first.',
      deploymentSectionStart,
    );
    const deploymentSection = deploymentGuide.slice(
      deploymentSectionStart,
      deploymentSectionEnd,
    );
    const migrationSectionStart = migrationGuide.indexOf(
      '`migrations/20260902_backstage_notion_rag_candidate_search_v1.sql` adds derived',
    );
    const migrationSectionEnd = migrationGuide.indexOf(
      '\nDo not apply this migration or run the backfill as routine validation',
      migrationSectionStart,
    );
    const migrationSection = migrationGuide.slice(
      migrationSectionStart,
      migrationSectionEnd,
    );
    const normalizedDeploymentSection = deploymentSection.replace(/\s+/gu, ' ');
    const normalizedMigrationSection = migrationSection.replace(/\s+/gu, ' ');

    expect(deploymentSectionStart).toBeGreaterThanOrEqual(0);
    expect(deploymentSectionEnd).toBeGreaterThan(deploymentSectionStart);
    expect(migrationSectionStart).toBeGreaterThanOrEqual(0);
    expect(migrationSectionEnd).toBeGreaterThan(migrationSectionStart);

    const deploymentFence = normalizedDeploymentSection.indexOf(
      'Do not select the backfill target until the migration has committed',
    );
    const deploymentBn003 = normalizedDeploymentSection.indexOf(
      '`BN003` activation fence then rejects every later canonical-only active-head change',
    );
    const deploymentTarget = normalizedDeploymentSection.indexOf(
      'Re-read the exact active target',
    );
    const deploymentBackfill = normalizedDeploymentSection.indexOf(
      'run the bounded idempotent backfill',
    );
    const deploymentDigest = normalizedDeploymentSection.indexOf(
      'independently recompute and match its `targetDigest`',
    );
    const deploymentSameHead = normalizedDeploymentSection.indexOf(
      'verify that the same snapshot remains active',
    );
    const deploymentPair = normalizedDeploymentSection.indexOf(
      'Only after those database preparations pass may the canonical paired Railway promotion run',
    );
    expect(deploymentFence).toBeGreaterThanOrEqual(0);
    expect(deploymentBn003).toBeGreaterThan(deploymentFence);
    expect(deploymentTarget).toBeGreaterThan(deploymentBn003);
    expect(deploymentBackfill).toBeGreaterThan(deploymentTarget);
    expect(deploymentDigest).toBeGreaterThan(deploymentBackfill);
    expect(deploymentSameHead).toBeGreaterThan(deploymentDigest);
    expect(deploymentPair).toBeGreaterThan(deploymentSameHead);
    expect(normalizedDeploymentSection).toContain(
      'Keep the old web and legacy worker deployment active and healthy',
    );
    expect(normalizedDeploymentSection).toContain(
      'coordinated-writer confirmation does not establish candidate-sidecar',
    );
    expect(normalizedDeploymentSection).toContain(
      'digest is historical evidence rather than proof of the new current head',
    );
    expect(normalizedDeploymentSection).toContain(
      'declared chunk count = canonical chunk count = sidecar count = recomputed valid-sidecar count',
    );
    expect(normalizedDeploymentSection).toContain(
      'do not associate the pre-promotion `targetDigest` with it',
    );

    const migrationFence = normalizedMigrationSection.indexOf(
      'Do not select the backfill target until the migration has committed',
    );
    const migrationBn003 = normalizedMigrationSection.indexOf(
      '`BN003` fence then rejects every later canonical-only head change',
    );
    const migrationTarget = normalizedMigrationSection.indexOf(
      're-read the exact active target after the fence is installed',
    );
    const migrationBackfill = normalizedMigrationSection.indexOf(
      'run `scripts/backstage-notion-candidate-search-backfill.mjs`',
    );
    const migrationDigest = normalizedMigrationSection.indexOf(
      'independently recomputing and matching `targetDigest`',
    );
    const migrationSameHead = normalizedMigrationSection.indexOf(
      'same snapshot is still active',
    );
    const migrationPair = normalizedMigrationSection.indexOf(
      'dispatch the canonical paired Railway promotion',
    );
    expect(migrationFence).toBeGreaterThanOrEqual(0);
    expect(migrationBn003).toBeGreaterThan(migrationFence);
    expect(migrationTarget).toBeGreaterThan(migrationBn003);
    expect(migrationBackfill).toBeGreaterThan(migrationTarget);
    expect(migrationDigest).toBeGreaterThan(migrationBackfill);
    expect(migrationSameHead).toBeGreaterThan(migrationDigest);
    expect(migrationPair).toBeGreaterThan(migrationSameHead);
    expect(normalizedMigrationSection).toContain(
      'Keep the old web reader and the legacy worker deployment active and healthy',
    );
    expect(normalizedMigrationSection).toContain(
      'general coordinated-writer confirmation is not a candidate-sidecar completeness gate',
    );
    expect(normalizedMigrationSection).toContain(
      'digest is historical evidence rather than proof of the new current head',
    );

    const stepNames = deploymentSteps().map(step => step.name);
    const workerStep = stepNames.indexOf('Deploy and verify Railway worker');
    const webStep = stepNames.indexOf('Deploy and verify Railway web pair');
    expect(workerStep).toBeGreaterThanOrEqual(0);
    expect(webStep).toBeGreaterThanOrEqual(0);
    expect(workerStep).toBeLessThan(webStep);
  });

  it('preflights and re-verifies both exact roles and active deployments', () => {
    const steps = deploymentSteps();
    const names = steps.map(step => step.name);
    const preflight = namedStep('Verify paired Railway targets').run;
    const worker = namedStep('Deploy and verify Railway worker').run;
    const web = namedStep('Deploy and verify Railway web pair').run;

    expect(names.indexOf('Deploy and verify Railway web pair')).toBeLessThan(
      names.indexOf('Post-deploy web watchdog/budget regression check'),
    );

    expect(preflight.match(
      /railway-auto-deploy-observer\.mjs active-id/gu,
    )).toHaveLength(2);
    expect(preflight.match(
      /railway-auto-deploy-observer\.mjs active-id \\\n\s+--project "\$\{RAILWAY_PROJECT_ID\}"/gu,
    )).toHaveLength(2);
    expect(preflight).toContain('BASELINE_WORKER_DEPLOYMENT_ID');
    expect(preflight).toContain('BASELINE_WEB_DEPLOYMENT_ID');
    expect(preflight).toContain('role=worker readiness=ready');
    expect(preflight).toContain('role=web readiness=ready evidence=direct');

    for (const evidence of [worker, web]) {
      expect(evidence).toContain(
        'node scripts/railway-auto-deploy-observer.mjs verify-active',
      );
      expect(evidence).toContain(
        'node scripts/railway-auto-deploy-observer.mjs variables',
      );
      expect(evidence).toContain('verify-railway-readiness-activation.mjs');
      expect(evidence).not.toContain('variables_json=');
    }
    expect(worker).toContain('role=worker readiness=ready');
    expect(web).toContain('role=web readiness=ready evidence=direct');
    expect(web).toContain('--deployment-id "${WORKER_DEPLOYMENT_ID}"');
    expect(web).toContain('--deployment-id "${web_deployment_id}"');
    expect(web).toContain('pair_status=SUCCESS');
    expect(web).toContain('tracked_healthcheck=/readyz');
    expect(web).toContain('tracked_drainingSeconds=60');
    expect(web).toContain('effective_settings_readback=required');

    expect(preflight).toMatch(
      /railway-auto-deploy-observer\.mjs variables.+env -u RAILWAY_TOKEN RAILWAY_SERVICE_ID="\$\{RAILWAY_WORKER_SERVICE_ID\}".+verify-railway-readiness-activation\.mjs/su,
    );
    expect(preflight).toMatch(
      /railway-auto-deploy-observer\.mjs variables.+env -u RAILWAY_TOKEN RAILWAY_SERVICE_ID="\$\{RAILWAY_WEB_SERVICE_ID\}".+verify-railway-readiness-activation\.mjs/su,
    );
  });

  it('serializes production observers and bounds every remote read', () => {
    const deployJob = workflow.jobs?.['deploy-production'] ?? {};
    const access = namedStep('Verify paired Railway targets').run ?? '';
    const worker = namedStep('Deploy and verify Railway worker').run ?? '';
    const web = namedStep('Deploy and verify Railway web pair').run ?? '';

    expect(deployJob.concurrency).toEqual({
      group: 'railway-auto-deploy-production',
      'cancel-in-progress': false,
    });
    expect(deployJob['timeout-minutes']).toBe(130);
    expect(access).toContain(
      'node scripts/railway-auto-deploy-observer.mjs variables',
    );
    expect(`${access}\n${worker}\n${web}`).not.toMatch(
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
