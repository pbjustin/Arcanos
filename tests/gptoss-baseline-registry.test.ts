import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = join(process.cwd(), 'scripts', 'gptoss', 'baseline-registry.mjs');
const profilePath = join(process.cwd(), 'scripts', 'gptoss', 'effective-router-profile.mjs');

function runScript(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function baselineReport(overrides: Record<string, unknown> = {}) {
  return {
    adapterDir: 'local_artifacts/gptoss-phase3-8-lowlr',
    reportPath: 'local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-effective-spec-v3.json',
    passed: 11,
    failed: 13,
    records: 24,
    effectivePassed: 24,
    effectiveFailed: 0,
    effectiveRouterScore: {
      passed: 24,
      failed: 0,
    },
    diagnosticModes: {
      routerClassifierMode: true,
      prefillJsonStart: true,
      applyHardPolicyOverrides: true,
      useLocalSpecFacts: true,
    },
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
    railwayCliUsed: false,
    liveDbUsed: false,
    ...overrides,
  };
}

describe('gptoss baseline registry', () => {
  let tempDir: string;
  let reportPath: string;
  let registryPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `arcanos-gptoss-baseline-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    reportPath = join(tempDir, 'eval-report.json');
    registryPath = join(tempDir, 'registry.json');
    writeFileSync(reportPath, `${JSON.stringify(baselineReport(), null, 2)}\n`, 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records Phase 3.13 into a deterministic registry entry', () => {
    const result = runScript(['record', '--registry', registryPath, '--report', reportPath]);
    const parsed = JSON.parse(result.stdout);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

    expect(result.status).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(registry).toMatchObject({
      kind: 'gptoss_baseline_registry',
      current: 'phase3.13',
      baselines: [
        {
          id: 'phase3.13',
          adapterPath: 'local_artifacts/gptoss-phase3-8-lowlr',
          evalReport: 'local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-effective-spec-v3.json',
          modelScore: { passed: 11, failed: 13, records: 24 },
          effectiveScore: { passed: 24, failed: 0, records: 24 },
          requiredRuntimeFlags: [
            '--router-classifier-mode',
            '--prefill-json-start',
            '--apply-hard-policy-overrides',
            '--use-local-spec-facts',
          ],
        },
      ],
    });
  });

  it('passes regression for the Phase 3.13 effective baseline and clean safety flags', () => {
    expect(runScript(['record', '--registry', registryPath, '--report', reportPath]).status).toBe(0);
    const result = runScript(['regress', '--registry', registryPath, '--report', reportPath]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      mode: 'regress',
      baselineId: 'phase3.13',
      effectiveScore: { passed: 24, failed: 0, records: 24 },
      safetyChecks: {
        allowedForTraining: true,
        openAiCalled: true,
        trainingExecuted: true,
        vllmUsed: true,
        noOpenAiOutputUsed: true,
        railwayCliUsed: true,
        liveDbUsed: true,
      },
    });
  });

  it('fails regression on score drops, missing runtime flags, or unsafe execution flags', () => {
    expect(runScript(['record', '--registry', registryPath, '--report', reportPath]).status).toBe(0);
    writeFileSync(reportPath, `${JSON.stringify(baselineReport({
      effectivePassed: 23,
      effectiveFailed: 1,
      effectiveRouterScore: { passed: 23, failed: 1 },
      diagnosticModes: {
        routerClassifierMode: true,
        prefillJsonStart: false,
        applyHardPolicyOverrides: true,
        useLocalSpecFacts: true,
      },
      openAiCalled: true,
      trainingExecuted: true,
      vllmUsed: true,
      railwayCliUsed: true,
      liveDbUsed: true,
    }), null, 2)}\n`, 'utf8');

    const result = runScript(['regress', '--registry', registryPath, '--report', reportPath]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toEqual(expect.arrayContaining([
      'effective_score_below_24_of_24',
      'missing_runtime_flag:--prefill-json-start',
      'openai_called',
      'training_executed',
      'vllm_used',
      'railway_cli_used',
      'live_db_used',
    ]));
  });

  it('fails regression when model score fields are missing', () => {
    expect(runScript(['record', '--registry', registryPath, '--report', reportPath]).status).toBe(0);
    const report = baselineReport();
    delete (report as Record<string, unknown>).passed;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const result = runScript(['regress', '--registry', registryPath, '--report', reportPath]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toContain('model_score_missing');
  });

  it('wires the effective-router profile to the local eval and baseline regression commands', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const profileSource = readFileSync(profilePath, 'utf8');

    expect(packageJson.scripts['gptoss:adapter:eval:effective-router']).toBe(
      'node scripts/gptoss/effective-router-profile.mjs eval',
    );
    expect(packageJson.scripts['gptoss:adapter:eval:effective-router:regress']).toBe(
      'node scripts/gptoss/effective-router-profile.mjs regress',
    );
    expect(profileSource).toContain('scripts/gptoss/eval-adapter-local.mjs');
    expect(profileSource).toContain('--router-classifier-mode');
    expect(profileSource).toContain('--prefill-json-start');
    expect(profileSource).toContain('--apply-hard-policy-overrides');
    expect(profileSource).toContain('--use-local-spec-facts');
    expect(profileSource).toContain('local_artifacts/gptoss-phase3-8-lowlr');
    expect(profileSource).toContain('eval-router-classifier-effective-spec-current.json');
    expect(profileSource).toContain('scripts/gptoss/baseline-registry.mjs');
  });
});
