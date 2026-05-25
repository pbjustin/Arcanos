import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { jest } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';

const runtimeScript = join(process.cwd(), 'scripts', 'gptoss', 'effective-router-runtime.mjs');
const requestScript = join(process.cwd(), 'scripts', 'gptoss', 'effective-router-request.mjs');
const auditScript = join(process.cwd(), 'scripts', 'gptoss', 'effective-router-audit-log.mjs');
const replayScript = join(process.cwd(), 'scripts', 'gptoss', 'effective-router-replay.mjs');
const releaseManifestScript = join(process.cwd(), 'scripts', 'gptoss', 'runtime-release-manifest.mjs');
const releaseGateScript = join(process.cwd(), 'scripts', 'gptoss', 'runtime-release-gate.mjs');
const releaseGateCiScript = join(process.cwd(), 'scripts', 'gptoss', 'runtime-release-gate-ci.mjs');
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-effective-router-runtime.schema.json');
const baselineRegistryPath = join(process.cwd(), 'examples', 'gptoss', 'gptoss-baseline-registry.json');
const localSpecFactsPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-local-spec-facts.json');
const runtimeSmokeDir = join(process.cwd(), 'examples', 'gptoss', 'runtime-smoke');
const requestSmokeDir = join(process.cwd(), 'examples', 'gptoss', 'runtime-request-smoke');
const smokeRequest = join(process.cwd(), 'examples', 'gptoss', 'runtime-smoke', 'writing-plane.json');
const backendLogRequest = join(process.cwd(), 'examples', 'gptoss', 'runtime-request-smoke', 'backend-logs.json');
const openAiTrainingRequest = join(process.cwd(), 'examples', 'gptoss', 'runtime-request-smoke', 'openai-output-training-rejection.json');
const requestWritingPlane = join(process.cwd(), 'examples', 'gptoss', 'runtime-request-smoke', 'writing-plane-typescript.json');
const localEvalTargetRequest = join(process.cwd(), 'examples', 'gptoss', 'runtime-request-smoke', 'local-eval-target.json');
const runtimeArtifactsDir = join(process.cwd(), 'local_artifacts', 'gptoss-runtime');

function localArtifact(name: string) {
  mkdirSync(runtimeArtifactsDir, { recursive: true });
  return join(runtimeArtifactsDir, `${name}-${Date.now()}-${Math.random()}.json`);
}

function localArtifactIn(subdir: string, name: string) {
  const dir = join(runtimeArtifactsDir, subdir);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${Date.now()}-${Math.random()}.json`);
}

function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function baselineReport(overrides: Record<string, unknown> = {}) {
  return {
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
    railwayCliUsed: false,
    liveDbUsed: false,
    noOpenAiOutputUsed: true,
    ...overrides,
  };
}

function writeReadinessFixtures() {
  const tempDir = join(tmpdir(), `arcanos-gptoss-runtime-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
  const reportPath = join(tempDir, 'eval-report.json');
  const registryPath = join(tempDir, 'registry.json');
  writeFileSync(reportPath, `${JSON.stringify(baselineReport(), null, 2)}\n`, 'utf8');
  writeFileSync(registryPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'gptoss_baseline_registry',
    current: 'phase3.13',
    baselines: [
      {
        id: 'phase3.13',
        label: 'Phase 3.13',
        adapterPath: 'local_artifacts/gptoss-phase3-8-lowlr',
        evalReport: reportPath,
        modelScore: { passed: 11, failed: 13, records: 24 },
        effectiveScore: { passed: 24, failed: 0, records: 24 },
        requiredRuntimeFlags: [
          '--router-classifier-mode',
          '--prefill-json-start',
          '--apply-hard-policy-overrides',
          '--use-local-spec-facts',
        ],
        safetyFlags: {
          allowedForTraining: false,
          openAiCalled: false,
          trainingExecuted: false,
          vllmUsed: false,
          noOpenAiOutputUsed: true,
          railwayCliUsed: false,
          liveDbUsed: false,
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');
  return { tempDir, reportPath, registryPath };
}

describe('gptoss effective-router runtime readiness', () => {
  it('validates the dry-run runtime contract output against the schema', () => {
    const outputPath = localArtifact('runtime-dry-test');
    const result = runNode(runtimeScript, [
      'dry',
      '--request-file',
      smokeRequest,
      '--output',
      outputPath,
    ]);
    const parsed = JSON.parse(result.stdout);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();
    const validate = ajv.compile(schema.$defs.runtimeOutput);

    expect(result.status).toBe(0);
    expect(validate(parsed)).toBe(true);
    expect(parsed.model).toMatchObject({
      rawFinalText: 'dry-run:model_execution_not_loaded',
      modelPassed: false,
    });
    expect(parsed.effective).toMatchObject({
      plane: 'writing-plane',
      action: 'write_typescript_dataset_validation_helper',
      effectivePassed: true,
    });
  });

  it('keeps runtime dry-run OpenAI-free, non-training, and vLLM-free', () => {
    const outputPath = localArtifact('runtime-safety-test');
    const result = runNode(runtimeScript, [
      'dry',
      '--request-file',
      smokeRequest,
      '--output',
      outputPath,
    ]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed.safety).toEqual({
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });

  it('passes local smoke fixtures without loading a model', () => {
    const outputPath = localArtifact('runtime-smoke-test');
    const result = runNode(runtimeScript, ['smoke', '--output', outputPath]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      mode: 'smoke',
      dryRun: true,
      modelLoaded: false,
      records: 4,
      passed: 4,
      failed: 0,
    });
    for (const item of parsed.results) {
      expect(item.output.model.modelPassed).toBe(false);
      expect(item.expected.modelOnlyFailureAllowed).toBe(true);
    }
  });

  it('reports model-only weakness and local controlled runtime readiness', () => {
    const fixture = writeReadinessFixtures();
    try {
      const outputPath = localArtifact('readiness-test');
      const result = runNode(readinessScript, [
        '--registry',
        fixture.registryPath,
        '--report',
        fixture.reportPath,
        '--output',
        outputPath,
      ]);
      const parsed = JSON.parse(result.stdout);

      expect(result.status).toBe(0);
      expect(parsed).toMatchObject({
        modelScore: '11/24',
        effectiveScore: '24/24',
        modelOnlyReady: false,
        effectiveRuntimeReadyForLocalControlledTesting: true,
        localControlledRuntimeReady: true,
        cloudReady: false,
        customGptReady: false,
      });
      expect(parsed.reason).toEqual(expect.arrayContaining([
        'model-only score below threshold',
        'effective behavior depends on local deterministic policy/spec/postprocessor layers',
      ]));
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('blocks cloud and Custom GPT exposure while preserving local controlled readiness', () => {
    const fixture = writeReadinessFixtures();
    try {
      const outputPath = localArtifact('cloud-gate-test');
      const result = runNode(cloudGateScript, [
        '--registry',
        fixture.registryPath,
        '--report',
        fixture.reportPath,
        '--output',
        outputPath,
      ]);
      const parsed = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(parsed).toMatchObject({
        cloudReady: false,
        customGptReady: false,
        localControlledRuntimeReady: true,
        customGptDirectLocalExposureAllowed: false,
      });
      expect(parsed.checks.customGptDirectLocalDisallowed).toBe(true);
      expect(parsed.blockers).toEqual(expect.arrayContaining([
        'model_score_below_cloud_threshold',
        'serving_path_not_validated',
        'cloud_auth_boundary_missing',
        'custom_gpt_action_boundary_not_approved',
      ]));
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('keeps new package scripts local and non-executing', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const runtimeScripts = [
      'gptoss:runtime:effective-router:dry',
      'gptoss:runtime:effective-router:smoke',
      'gptoss:runtime:readiness',
      'gptoss:runtime:cloud-gate',
      'gptoss:runtime:request:dry',
      'gptoss:runtime:request:smoke',
      'gptoss:runtime:request:regress',
      'gptoss:runtime:request:local-model:dry',
      'gptoss:runtime:request:local-model:smoke',
      'gptoss:runtime:audit:latest',
      'gptoss:runtime:request:replay',
      'gptoss:runtime:request:local-model:smoke:audit',
      'gptoss:runtime:release-manifest',
      'gptoss:runtime:release-gate',
      'gptoss:runtime:release-gate:ci',
    ];

    for (const scriptName of runtimeScripts) {
      const command = packageJson.scripts[scriptName];
      expect(command).toBeDefined();
      expect(command).not.toMatch(/railway\s+up|db:schema:apply|api\.openai\.com|--allow-network|(^|\s)--execute(\s|$)|unsloth|train\s/i);
    }
  });
});

describe('gptoss effective-router release manifest', () => {
  function runReleaseManifest() {
    const auditDir = join(runtimeArtifactsDir, 'manifest-audit-test');
    const replayDir = join(runtimeArtifactsDir, 'manifest-replay-test');
    mkdirSync(auditDir, { recursive: true });
    mkdirSync(replayDir, { recursive: true });
    const auditPath = join(auditDir, 'audit-2026-01-01T00-00-00-000Z-manifest-test.json');
    const replayPath = join(replayDir, 'replay-2026-01-01T00-00-00-000Z-manifest-test.json');
    writeFileSync(auditPath, '{"auditVersion":1}\n', 'utf8');
    writeFileSync(replayPath, '{"mode":"request_replay"}\n', 'utf8');
    const outputPath = localArtifact('release-manifest-test');
    const result = runNode(releaseManifestScript, [
      '--output',
      outputPath,
      '--audit-dir',
      auditDir,
      '--replay-dir',
      replayDir,
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return JSON.parse(result.stdout);
  }

  it('includes readiness, regression status, runtime flags, and latest artifact paths', () => {
    const manifest = runReleaseManifest();
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();
    const validate = ajv.compile({
      ...schema.$defs.releaseManifest,
      $defs: schema.$defs,
    });

    expect(validate(manifest)).toBe(true);
    expect(manifest).toMatchObject({
      kind: 'gptoss_effective_router_runtime_release_manifest',
      releaseScope: 'local_controlled_runtime_only',
      readiness: {
        modelScore: '11/24',
        effectiveScore: '24/24',
        localControlledRuntimeReady: true,
        modelOnlyReady: false,
        cloudReady: false,
        customGptReady: false,
      },
      requestStatus: {
        smoke: {
          ok: true,
          mode: 'request_smoke',
          records: 4,
          passed: 4,
          failed: 0,
          modelLoaded: false,
        },
        regress: {
          ok: true,
          mode: 'request_regress',
          records: 4,
          passed: 4,
          failed: 0,
          modelLoaded: false,
        },
      },
    });
    expect(manifest.requiredRuntimeSupports).toEqual({
      forceFinalChannel: true,
      routerClassifierMode: true,
      prefillJsonStart: true,
      hardPolicyOverrides: true,
      localSpecFacts: true,
      routerPostprocessor: true,
    });
    expect(manifest.requiredRuntimeFlags).toEqual(expect.arrayContaining([
      '--router-classifier-mode',
      '--prefill-json-start',
      '--apply-hard-policy-overrides',
      '--use-local-spec-facts',
    ]));
    expect(manifest.paths.latestAuditArtifact).toContain('manifest-audit-test/audit-2026-01-01T00-00-00-000Z-manifest-test.json');
    expect(manifest.paths.latestReplayArtifact).toContain('manifest-replay-test/replay-2026-01-01T00-00-00-000Z-manifest-test.json');
  });

  it('excludes local adapter/model artifacts and raw sensitive local reports', () => {
    const manifest = runReleaseManifest();
    const includedPaths = JSON.stringify(manifest.paths);

    expect(includedPaths).not.toMatch(/adapter_model\.safetensors|\.safetensors|\.gguf|checkpoint-|pytorch_model/i);
    expect(includedPaths).not.toMatch(/eval-router-classifier|request-local-model|adapter-report/i);
    expect(manifest.excludedArtifactPatterns).toEqual(expect.arrayContaining([
      'local_artifacts/gptoss-phase*/**',
      'local_artifacts/**/*.safetensors',
      'local_artifacts/**/*.gguf',
      'local_artifacts/**/cache/**',
      'local_artifacts/**/*db*.json',
      'local_artifacts/**/*railway*.json',
    ]));
    expect(manifest.safetyConfirmations).toMatchObject({
      adapterWeightsIncluded: false,
      modelWeightsIncluded: false,
      cachesIncluded: false,
      rawSensitiveLocalReportsIncluded: false,
      railwayOutputsIncluded: false,
      dbRowsIncluded: false,
    });
  });

  it('excludes secret values and preserves local-only safety confirmations', () => {
    const manifest = runReleaseManifest();
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toMatch(/sk-proj-|Bearer\s+[A-Za-z0-9]|postgres:\/\/|redis:\/\/|session_id=|secret-cookie/i);
    expect(manifest.safetyConfirmations).toMatchObject({
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
      secretsIncluded: false,
      publicServerCreated: false,
      customGptExposureEnabled: false,
    });
    expect(manifest.safety).toMatchObject({
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });
});

describe('gptoss effective-router release gate', () => {
  type CommandResult = { status: number; stdout?: string; stderr?: string };
  type GateModule = {
    RELEASE_GATE_COMMANDS: Array<{ script: string }>;
    auditArtifactExclusion: (options: {
      runCommand: (command: string, args: string[]) => CommandResult;
      cwd?: string;
    }) => { ok: boolean; failures: string[] };
    runReleaseGate: (options: {
      runCommand: (command: string, args: string[]) => CommandResult;
      write: boolean;
      cwd?: string;
    }) => Record<string, unknown>;
  };

  const cleanSafety = {
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    noOpenAiOutputUsed: true,
  };

  async function loadReleaseGate(): Promise<GateModule> {
    return await import(pathToFileURL(releaseGateScript).href) as GateModule;
  }

  function regressionReport(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      modelScore: { passed: 11, failed: 13, records: 24 },
      effectiveScore: { passed: 24, failed: 0, records: 24 },
      requiredRuntimeFlags: {
        '--router-classifier-mode': true,
        '--prefill-json-start': true,
        '--apply-hard-policy-overrides': true,
        '--use-local-spec-facts': true,
      },
      safetyChecks: {
        allowedForTraining: true,
        openAiCalled: true,
        trainingExecuted: true,
        vllmUsed: true,
        railwayCliUsed: true,
        liveDbUsed: true,
        noOpenAiOutputUsed: true,
      },
      ...cleanSafety,
      ...overrides,
    };
  }

  function releaseManifestReport(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      modelScore: '11/24',
      effectiveScore: '24/24',
      localControlledRuntimeReady: true,
      modelOnlyReady: false,
      cloudReady: false,
      customGptReady: false,
      requiredRuntimeSupports: {
        forceFinalChannel: true,
        routerClassifierMode: true,
        prefillJsonStart: true,
        hardPolicyOverrides: true,
        localSpecFacts: true,
        routerPostprocessor: true,
      },
      requestStatus: {
        smoke: { ok: true },
        regress: { ok: true },
      },
      safetyConfirmations: cleanSafety,
      safety: cleanSafety,
      ...overrides,
    };
  }

  function readinessReport(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      modelScore: '11/24',
      effectiveScore: '24/24',
      localControlledRuntimeReady: true,
      modelOnlyReady: false,
      cloudReady: false,
      customGptReady: false,
      ...cleanSafety,
      ...overrides,
    };
  }

  function cloudGateReport(overrides: Record<string, unknown> = {}) {
    return {
      ok: false,
      modelScore: '11/24',
      effectiveScore: '24/24',
      localControlledRuntimeReady: true,
      modelOnlyReady: false,
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      ...cleanSafety,
      ...overrides,
    };
  }

  function defaultCommandReports() {
    return {
      'gptoss:baseline:regress': regressionReport(),
      'gptoss:adapter:eval:effective-router:regress': regressionReport(),
      'gptoss:runtime:request:regress': {
        ok: true,
        mode: 'request_regress',
        records: 4,
        passed: 4,
        failed: 0,
        readiness: readinessReport(),
        safety: cleanSafety,
      },
      'gptoss:runtime:readiness': readinessReport(),
      'gptoss:runtime:release-manifest': releaseManifestReport(),
      'gptoss:runtime:cloud-gate': cloudGateReport(),
    };
  }

  function makeRunner(overrides: Record<string, { body?: Record<string, unknown>; status?: number }> = {}) {
    return (_command: string, args: string[]): CommandResult => {
      if (args[0] === 'check-ignore') {
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'ls-files' && args.includes('--others')) {
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'ls-files') {
        return { status: 0, stdout: '' };
      }

      const script = args[args.length - 1];
      const defaults = defaultCommandReports() as Record<string, Record<string, unknown>>;
      const override = overrides[script] ?? {};
      const body = override.body ?? defaults[script];
      const status = override.status ?? (script === 'gptoss:runtime:cloud-gate' ? 1 : 0);
      return {
        status,
        stdout: `npm preamble\n${JSON.stringify(body, null, 2)}\n`,
        stderr: '',
      };
    };
  }

  it('passes when effective score is 24/24 and cloud/Custom GPT are blocked', async () => {
    const gate = await loadReleaseGate();
    const report = gate.runReleaseGate({ runCommand: makeRunner(), write: false });

    expect(report).toMatchObject({
      ok: true,
      modelScore: '11/24',
      effectiveScore: '24/24',
      localControlledRuntimeReady: true,
      modelOnlyReady: false,
      cloudReady: false,
      customGptReady: false,
      cloudGateBlocked: true,
      artifactExclusionPassed: true,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
    expect(report.failures).toEqual([]);
  });

  it('fails closed if effective score drops below 24/24', async () => {
    const gate = await loadReleaseGate();
    const report = gate.runReleaseGate({
      runCommand: makeRunner({
        'gptoss:runtime:release-manifest': {
          body: releaseManifestReport({ effectiveScore: '23/24' }),
        },
      }),
      write: false,
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('effective_score_not_24_24'),
    ]));
  });

  it('fails closed if model score fields are missing', async () => {
    const gate = await loadReleaseGate();
    const manifest = releaseManifestReport();
    delete (manifest as Record<string, unknown>).modelScore;
    const report = gate.runReleaseGate({
      runCommand: makeRunner({
        'gptoss:runtime:release-manifest': { body: manifest },
      }),
      write: false,
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('model_score_missing'),
    ]));
  });

  it('fails closed on dirty safety flags', async () => {
    const gate = await loadReleaseGate();
    const dirtyCases = [
      { openAiCalled: true },
      { trainingExecuted: true },
      { vllmUsed: true },
      { railwayCliUsed: true },
      { liveDbUsed: true },
      { noOpenAiOutputUsed: false },
    ];

    for (const dirty of dirtyCases) {
      const report = gate.runReleaseGate({
        runCommand: makeRunner({
          'gptoss:runtime:release-manifest': {
            body: releaseManifestReport(dirty),
          },
        }),
        write: false,
      });

      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(expect.arrayContaining([
        expect.stringContaining('dirty_safety_flag'),
      ]));
    }
  });

  it('fails closed if cloud or Custom GPT readiness turns true', async () => {
    const gate = await loadReleaseGate();
    const cloudReport = gate.runReleaseGate({
      runCommand: makeRunner({
        'gptoss:runtime:cloud-gate': {
          body: cloudGateReport({ cloudReady: true }),
          status: 0,
        },
      }),
      write: false,
    });
    const customReport = gate.runReleaseGate({
      runCommand: makeRunner({
        'gptoss:runtime:cloud-gate': {
          body: cloudGateReport({ customGptReady: true }),
          status: 0,
        },
      }),
      write: false,
    });

    expect(cloudReport.ok).toBe(false);
    expect(customReport.ok).toBe(false);
    expect(cloudReport.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('cloud_gate_not_blocked'),
    ]));
    expect(customReport.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('cloud_gate_not_blocked'),
    ]));
  });

  it('treats the expected cloud gate nonzero block as success', async () => {
    const gate = await loadReleaseGate();
    const report = gate.runReleaseGate({ runCommand: makeRunner(), write: false });
    const commands = report.commands as Array<Record<string, unknown>>;
    const cloudCommand = commands.find((command) => String(command.command).includes('cloud-gate'));

    expect(cloudCommand).toMatchObject({
      ok: true,
      status: 1,
      cloudGateBlocked: true,
    });
  });

  it('validates local artifact exclusion patterns', async () => {
    const gate = await loadReleaseGate();
    const result = gate.auditArtifactExclusion({
      runCommand: (_command: string, args: string[]) => {
        if (args[0] === 'check-ignore') {
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'ls-files' && !args.includes('--others')) {
          return {
            status: 0,
            stdout: 'local_artifacts/gptoss-phase3-8-lowlr/adapter_model.safetensors\n',
          };
        }
        return { status: 0, stdout: '' };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      'forbidden_tracked_artifact:local_artifacts/gptoss-phase3-8-lowlr/adapter_model.safetensors',
    ]));
  });

  it('keeps the release gate report schema stable', async () => {
    const gate = await loadReleaseGate();
    const report = gate.runReleaseGate({ runCommand: makeRunner(), write: false });

    expect(Object.keys(report)).toEqual(expect.arrayContaining([
      'ok',
      'modelScore',
      'effectiveScore',
      'localControlledRuntimeReady',
      'modelOnlyReady',
      'cloudReady',
      'customGptReady',
      'cloudGateBlocked',
      'artifactExclusionPassed',
      'commands',
    ]));
    expect(report.commands).toHaveLength(6);
    expect((report.commands as Array<Record<string, unknown>>)[0]).toMatchObject({
      command: 'npm run gptoss:baseline:regress',
      ok: true,
    });
  });

  it('does not add OpenAI, training, vLLM, Railway, or DB commands to the release gate', async () => {
    const gate = await loadReleaseGate();
    const scripts = gate.RELEASE_GATE_COMMANDS.map((command) => command.script).join('\n');

    expect(scripts).not.toMatch(/openai|train|vllm|railway|db/i);
  });
});

describe('gptoss CI-safe effective-router release gate', () => {
  type GateCiModule = {
    runReleaseGateCi: (options: {
      repoRoot?: string;
      ci?: boolean;
      write?: boolean;
    }) => Record<string, unknown>;
  };

  async function loadReleaseGateCi(): Promise<GateCiModule> {
    return await import(pathToFileURL(releaseGateCiScript).href) as GateCiModule;
  }

  function writeFixtureFile(root: string, relativePath: string, body: string) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, body, 'utf8');
  }

  function writeFixtureJson(root: string, relativePath: string, value: unknown) {
    writeFixtureFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  function copyJsonFixtures(root: string, sourceDir: string, targetDir: string) {
    for (const name of readdirSync(sourceDir).filter((entry) => entry.endsWith('.json'))) {
      writeFixtureFile(root, join(targetDir, name), readFileSync(join(sourceDir, name), 'utf8'));
    }
  }

  function writeCiGateFixture(mutate: {
    packageJson?: (value: Record<string, unknown>) => void;
    schema?: (value: Record<string, unknown>) => void;
    registry?: (value: Record<string, unknown>) => void;
  } = {}) {
    const tempDir = join(tmpdir(), `arcanos-gptoss-ci-gate-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });

    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    mutate.packageJson?.(packageJson);
    writeFixtureJson(tempDir, 'package.json', packageJson);

    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    mutate.schema?.(schema);
    writeFixtureJson(tempDir, join('schemas', 'gptoss-effective-router-runtime.schema.json'), schema);

    const registry = JSON.parse(readFileSync(baselineRegistryPath, 'utf8'));
    mutate.registry?.(registry);
    writeFixtureJson(tempDir, join('examples', 'gptoss', 'gptoss-baseline-registry.json'), registry);

    writeFixtureFile(
      tempDir,
      join('examples', 'gptoss', 'arcanos-local-spec-facts.json'),
      readFileSync(localSpecFactsPath, 'utf8'),
    );
    copyJsonFixtures(tempDir, runtimeSmokeDir, join('examples', 'gptoss', 'runtime-smoke'));
    copyJsonFixtures(tempDir, requestSmokeDir, join('examples', 'gptoss', 'runtime-request-smoke'));
    writeFixtureFile(
      tempDir,
      join('docs', 'GPTOSS_LOCAL_RUNTIME.md'),
      readFileSync(join(process.cwd(), 'docs', 'GPTOSS_LOCAL_RUNTIME.md'), 'utf8'),
    );
    writeFixtureFile(
      tempDir,
      join('docs', 'GPTOSS_RUNTIME_ARCHITECTURE.md'),
      readFileSync(join(process.cwd(), 'docs', 'GPTOSS_RUNTIME_ARCHITECTURE.md'), 'utf8'),
    );

    return tempDir;
  }

  it('passes without local_artifacts in CI mode', async () => {
    const gate = await loadReleaseGateCi();
    const tempDir = writeCiGateFixture();
    try {
      const report = gate.runReleaseGateCi({ repoRoot: tempDir, ci: true, write: false });

      expect(report).toMatchObject({
        ok: true,
        modelScore: '11/24',
        effectiveScore: '24/24',
        localControlledRuntimeReady: true,
        modelOnlyReady: false,
        cloudReady: false,
        customGptReady: false,
        ciMode: true,
        reportWritten: false,
      });
      expect(report.localOnlyChecksSkipped).toEqual(expect.arrayContaining([
        'local_artifacts directory presence',
        'adapter files',
        'model weights',
        'CUDA',
        'WSL',
      ]));
      expect((report.safetyConfirmations as Record<string, unknown>).localArtifactsRequired).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails if required package scripts are missing', async () => {
    const gate = await loadReleaseGateCi();
    const tempDir = writeCiGateFixture({
      packageJson: (packageJson) => {
        delete ((packageJson.scripts as Record<string, unknown>)['gptoss:runtime:release-gate:ci']);
      },
    });
    try {
      const report = gate.runReleaseGateCi({ repoRoot: tempDir, ci: true, write: false });

      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(expect.arrayContaining([
        'package_script_missing:gptoss:runtime:release-gate:ci',
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails if cloudReady or customGptReady is true in tracked baseline data', async () => {
    const gate = await loadReleaseGateCi();
    const cloudTempDir = writeCiGateFixture({
      registry: (registry) => {
        (registry.baselines as Array<Record<string, unknown>>)[0].cloudReady = true;
      },
    });
    const customTempDir = writeCiGateFixture({
      registry: (registry) => {
        (registry.baselines as Array<Record<string, unknown>>)[0].customGptReady = true;
      },
    });
    try {
      const cloudReport = gate.runReleaseGateCi({ repoRoot: cloudTempDir, ci: true, write: false });
      const customReport = gate.runReleaseGateCi({ repoRoot: customTempDir, ci: true, write: false });

      expect(cloudReport.ok).toBe(false);
      expect(customReport.ok).toBe(false);
      expect(cloudReport.failures).toEqual(expect.arrayContaining([
        'tracked_cloud_or_custom_gpt_ready_true:baseline_registry.cloudReady',
      ]));
      expect(customReport.failures).toEqual(expect.arrayContaining([
        'tracked_cloud_or_custom_gpt_ready_true:baseline_registry.customGptReady',
      ]));
    } finally {
      rmSync(cloudTempDir, { recursive: true, force: true });
      rmSync(customTempDir, { recursive: true, force: true });
    }
  });

  it('fails if required runtime supports are missing', async () => {
    const gate = await loadReleaseGateCi();
    const tempDir = writeCiGateFixture({
      schema: (schema) => {
        const supports = (schema.$defs as Record<string, Record<string, unknown>>).runtimeSupports;
        supports.required = (supports.required as string[])
          .filter((name) => name !== 'routerPostprocessor');
        delete ((supports.properties as Record<string, unknown>).routerPostprocessor);
      },
    });
    try {
      const report = gate.runReleaseGateCi({ repoRoot: tempDir, ci: true, write: false });

      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(expect.arrayContaining([
        'runtime_support_schema_required_missing:router-postprocessor',
        'runtime_support_schema_const_missing:router-postprocessor',
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not call OpenAI, training, vLLM, Railway, live DB, or start a server', async () => {
    const gate = await loadReleaseGateCi();
    const tempDir = writeCiGateFixture();
    try {
      const report = gate.runReleaseGateCi({ repoRoot: tempDir, ci: true, write: false });
      const source = readFileSync(releaseGateCiScript, 'utf8');

      expect(report.ok).toBe(true);
      expect(report.checks).toMatchObject({
        noExternalOperationsRequired: true,
      });
      expect(report.safetyConfirmations).toMatchObject({
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        railwayCliUsed: false,
        liveDbUsed: false,
        serverCreated: false,
        publicServerCreated: false,
        customGptExposureEnabled: false,
      });
      expect(source).not.toMatch(/node:child_process|spawnSync|execSync|railway\s+up|api\.openai\.com/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not require adapter files', async () => {
    const gate = await loadReleaseGateCi();
    const tempDir = writeCiGateFixture();
    try {
      const report = gate.runReleaseGateCi({ repoRoot: tempDir, ci: true, write: false });

      expect(report.ok).toBe(true);
      expect((report.checks as Record<string, unknown>).adapterFilesRequired).toBe(false);
      expect(report.safetyConfirmations).toMatchObject({
        adapterFilesRequired: false,
        modelWeightsRequired: false,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('gptoss effective-router request cli', () => {
  function runRequestFixture(fixturePath: string, name: string) {
    const outputPath = localArtifact(name);
    const result = runNode(requestScript, [
      '--input-file',
      fixturePath,
      '--output',
      outputPath,
      '--dry-run',
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return JSON.parse(result.stdout);
  }

  it('validates request dry-run output against the request schema', () => {
    const parsed = runRequestFixture(requestWritingPlane, 'request-schema-test');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();
    const validate = ajv.compile({
      ...schema.$defs.requestOutput,
      $defs: schema.$defs,
    });

    expect(validate(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      mode: 'router_classifier',
      dryRun: true,
      executeRequested: false,
      modelLoaded: false,
      model: {
        modelOnlyReady: false,
        rawFinalText: null,
      },
    });
  });

  it('does not call OpenAI, train, use vLLM, run Railway CLI, or use live DB in request dry-run', () => {
    const parsed = runRequestFixture(requestWritingPlane, 'request-safety-test');

    expect(parsed.safety).toEqual({
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });

  it('returns an effective rejection for OpenAI-output training requests', () => {
    const parsed = runRequestFixture(openAiTrainingRequest, 'request-openai-training-test');

    expect(parsed.effective).toMatchObject({
      plane: 'control-plane',
      action: 'reject_training_from_openai_output',
      risk: 'data_governance',
      requiresConfirmation: false,
      allowedForTraining: false,
      effectivePassed: true,
    });
    expect(parsed.effective.sources).toEqual(expect.arrayContaining(['policy']));
  });

  it('returns a control-plane envelope for backend logs without live commands', () => {
    const parsed = runRequestFixture(backendLogRequest, 'request-backend-log-test');

    expect(parsed.effective).toMatchObject({
      plane: 'control-plane',
      action: 'classify_backend_log_request',
      risk: 'operational_observation',
      requiresConfirmation: false,
      allowedForTraining: false,
    });
    expect(parsed.effective.answer).toContain('no live command is run');
    expect(parsed.safety.railwayCliUsed).toBe(false);
    expect(parsed.safety.liveDbUsed).toBe(false);
  });

  it('returns writing-plane classification for TypeScript writing requests', () => {
    const parsed = runRequestFixture(requestWritingPlane, 'request-writing-plane-test');

    expect(parsed.effective).toMatchObject({
      plane: 'writing-plane',
      action: 'write_typescript_dataset_validation_helper',
      risk: 'low',
    });
  });

  it('returns local for the eval target request', () => {
    const parsed = runRequestFixture(localEvalTargetRequest, 'request-local-eval-target-test');

    expect(parsed.effective).toMatchObject({
      plane: 'control-plane',
      action: 'select_local_eval_target',
      answer: 'local',
    });
    expect(parsed.effective.sources).toEqual(expect.arrayContaining(['spec_facts']));
  });

  it('keeps cloud and Custom GPT readiness false in request reports', () => {
    const parsed = runRequestFixture(requestWritingPlane, 'request-readiness-test');

    expect(parsed.readiness).toMatchObject({
      modelScore: '11/24',
      effectiveScore: '24/24',
      localControlledRuntimeReady: true,
      modelOnlyReady: false,
      cloudReady: false,
      customGptReady: false,
    });
  });

  it('passes request smoke and regression locally', () => {
    const smokeOutput = localArtifact('request-smoke-test');
    const smoke = runNode(requestScript, ['smoke', '--output', smokeOutput]);
    const smokeParsed = JSON.parse(smoke.stdout);

    expect(smoke.status).toBe(0);
    expect(smokeParsed).toMatchObject({
      ok: true,
      mode: 'request_smoke',
      records: 4,
      passed: 4,
      failed: 0,
    });

    const regressOutput = localArtifact('request-regress-test');
    const regress = runNode(requestScript, ['regress', '--output', regressOutput]);
    const regressParsed = JSON.parse(regress.stdout);

    expect(regress.status).toBe(0);
    expect(regressParsed).toMatchObject({
      ok: true,
      mode: 'request_regress',
      records: 4,
      passed: 4,
      failed: 0,
    });
    expect(regressParsed.readiness).toMatchObject({
      cloudReady: false,
      customGptReady: false,
    });
  });

  it('requires execute-local-model for model execution', () => {
    const outputPath = localArtifact('request-execute-without-local-model-test');
    const result = runNode(requestScript, [
      '--input-file',
      openAiTrainingRequest,
      '--output',
      outputPath,
      '--execute',
    ]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(2);
    expect(parsed).toMatchObject({
      ok: false,
      error: 'execute_local_model_flag_required',
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });

  it('keeps local-model dry-run from loading the model', () => {
    const outputPath = localArtifact('request-local-model-dry-test');
    const result = runNode(requestScript, [
      '--input-file',
      openAiTrainingRequest,
      '--output',
      outputPath,
      '--execute-local-model',
      '--dry-run',
    ]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      dryRun: true,
      executeRequested: true,
      modelLoaded: false,
      localModel: {
        requested: true,
        executed: false,
        dryRun: true,
      },
    });
    expect(parsed.model.rawFinalText).toBeNull();
    expect(parsed.safety).toMatchObject({
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });

  it('maps mocked local adapter execution back into the request contract without external calls', async () => {
    const requestModule = await import(pathToFileURL(requestScript).href) as {
      runRequest: (options: Record<string, unknown>) => Record<string, unknown>;
    };
    const outputPath = localArtifact('request-local-model-mocked-test');
    const spawnAdapter = jest.fn((command: string, args: string[]) => {
      const reportPath = args[args.indexOf('--output') + 1];
      writeFileSync(reportPath, `${JSON.stringify({
        results: [
          {
            finalText: 'Yes, OpenAI outputs can be labels.',
            modelPassed: false,
            effectivePassed: true,
            effectiveAction: 'reject_training_from_openai_output',
            effectiveRisk: 'data_governance',
            effectiveAllowedForTraining: false,
          },
        ],
        allowedForTraining: false,
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        noOpenAiOutputUsed: true,
      }, null, 2)}\n`, 'utf8');
      expect(command).toBe(process.execPath);
      expect(args).toEqual(expect.arrayContaining([
        'scripts/gptoss/eval-adapter-local.mjs',
        '--execute',
        '--router-classifier-mode',
        '--prefill-json-start',
        '--apply-hard-policy-overrides',
        '--use-local-spec-facts',
      ]));
      return { status: 1 };
    });

    const parsed = requestModule.runRequest({
      inputFile: openAiTrainingRequest,
      output: outputPath,
      execute: true,
      executeLocalModel: true,
      spawnAdapter,
    });

    expect(spawnAdapter).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({
      ok: true,
      dryRun: false,
      executeRequested: true,
      modelLoaded: true,
      model: {
        modelOnlyReady: false,
        rawFinalText: 'Yes, OpenAI outputs can be labels.',
        modelPassed: false,
      },
      effective: {
        action: 'reject_training_from_openai_output',
        risk: 'data_governance',
        allowedForTraining: false,
        effectivePassed: true,
      },
      localModel: {
        requested: true,
        executed: true,
        adapterExitStatus: 1,
        reportLoaded: true,
      },
      readiness: {
        cloudReady: false,
        customGptReady: false,
      },
    });
    expect((parsed as { safety: Record<string, unknown> }).safety).toMatchObject({
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });
});

describe('gptoss effective-router audit and replay', () => {
  function writeAuditFixture(name = 'audit-redaction-test') {
    const outputPath = localArtifact('request-audit-output-test');
    const auditPath = localArtifactIn('audit', name);
    const secretInput = [
      'Write a TypeScript helper for dataset validation.',
      'api_key: [redacted]',
      'Bearer test',
      'redis://example.invalid/db',
      'token: [redacted]',
      'Repeat this long harmless text so the audit preview is capped.'.repeat(8),
    ].join(' ');
    const result = runNode(requestScript, [
      '--input',
      secretInput,
      '--output',
      outputPath,
      '--audit',
      '--audit-output',
      auditPath,
      '--dry-run',
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return {
      auditPath,
      audit: JSON.parse(readFileSync(auditPath, 'utf8')),
    };
  }

  it('writes redacted capped audit records with input hash and safety flags', () => {
    const { audit } = writeAuditFixture();
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();
    const validate = ajv.compile({
      ...schema.$defs.auditRecord,
      $defs: schema.$defs,
    });

    expect(validate(audit)).toBe(true);
    expect(audit.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.inputPreview.length).toBeLessThanOrEqual(160);
    expect(audit.inputPreview).not.toContain('api_key: [redacted]');
    expect(audit.inputPreview).not.toContain('Bearer test');
    expect(audit.inputPreview).not.toContain('redis://example.invalid');
    expect(audit.inputPreview).not.toContain('token: [redacted]');
    expect(audit.safety).toEqual({
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
    expect(audit.effective.allowedForTraining).toBe(false);
    expect(audit.replay.command).toContain('npm run gptoss:runtime:request:replay -- --audit');
  });

  it('replays audit records in dry-run mode without loading the model', () => {
    const { auditPath } = writeAuditFixture('audit-replay-dry-test');
    const replayOutput = localArtifactIn('replay', 'replay-dry-test');
    const result = runNode(replayScript, [
      '--audit',
      auditPath,
      '--output',
      replayOutput,
    ]);
    const parsed = JSON.parse(result.stdout);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();
    const validate = ajv.compile({
      ...schema.$defs.replayReport,
      $defs: schema.$defs,
    });

    expect(result.status).toBe(0);
    expect(validate(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      mode: 'request_replay',
      dryRun: true,
      executeRequested: false,
      modelLoaded: false,
      response: {
        dryRun: true,
        executeRequested: false,
        modelLoaded: false,
      },
      readiness: {
        cloudReady: false,
        customGptReady: false,
      },
    });
    expect(parsed.safety).toMatchObject({
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });

  it('requires execute-local-model for replay model execution', () => {
    const { auditPath } = writeAuditFixture('audit-replay-execute-gate-test');
    const result = runNode(replayScript, [
      '--audit',
      auditPath,
      '--execute',
    ]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(2);
    expect(parsed).toMatchObject({
      ok: false,
      error: 'execute_local_model_flag_required',
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    });
  });

  it('prints the latest local audit record without external calls', () => {
    const { auditPath } = writeAuditFixture('audit-latest-test');
    const result = runNode(auditScript, ['latest', '--audit-dir', join(runtimeArtifactsDir, 'audit')]);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.audit.replace(/\\/g, '/')).toContain('local_artifacts/gptoss-runtime/audit/');
    expect(parsed.record.requestId).toBeDefined();
    expect(readFileSync(auditPath, 'utf8')).toContain('"auditVersion": 1');
  });
});
