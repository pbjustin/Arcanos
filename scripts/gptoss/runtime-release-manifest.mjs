#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DEFAULT_REGISTRY } from './baseline-registry.mjs';
import {
  CLEAN_SAFETY_FLAGS,
  REQUIRED_RUNTIME_SUPPORTS,
  RUNTIME_REPORT_DIR,
  assertRuntimeReportPath,
} from './effective-router-runtime.mjs';
import { DEFAULT_AUDIT_DIR } from './effective-router-audit-log.mjs';
import { DEFAULT_REPLAY_DIR } from './effective-router-replay.mjs';
import { runRegression, runSmoke } from './effective-router-request.mjs';
import { buildReadinessReport } from './model-readiness-report.mjs';

export const DEFAULT_RELEASE_MANIFEST = join(RUNTIME_REPORT_DIR, 'release-manifest.json');

export const EXCLUDED_ARTIFACT_PATTERNS = [
  'local_artifacts/gptoss-phase*/**',
  'local_artifacts/gptoss-*/adapter_model.safetensors',
  'local_artifacts/gptoss-*/adapter_config.json',
  'local_artifacts/**/*.safetensors',
  'local_artifacts/**/*.bin',
  'local_artifacts/**/*.pt',
  'local_artifacts/**/*.pth',
  'local_artifacts/**/*.gguf',
  'local_artifacts/**/pytorch_model*',
  'local_artifacts/**/model-*',
  'local_artifacts/**/checkpoint-*',
  'local_artifacts/**/cache/**',
  'local_artifacts/**/.cache/**',
  'local_artifacts/**/*eval*.json',
  'local_artifacts/**/*adapter*.json',
  'local_artifacts/**/*request-local-model*.json',
  'local_artifacts/**/*request-local-model*.jsonl',
  'local_artifacts/**/*db*.json',
  'local_artifacts/**/*railway*.json',
  '**/.env',
  '**/.env.*',
  '**/*secret*',
  '**/*token*',
  '**/*credential*',
  '**/*database-url*',
];

function toDisplayPath(path) {
  return path ? String(path).replace(/\\/g, '/') : null;
}

function writeJson(path, value) {
  assertRuntimeReportPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function latestJsonPath(dir, prefixes = ['']) {
  if (!existsSync(dir)) {
    return null;
  }
  for (const prefix of prefixes) {
    const candidates = readdirSync(dir)
      .filter((name) => name.endsWith('.json') && (!prefix || name.startsWith(prefix)))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile())
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (candidates[0]) {
      return candidates[0];
    }
  }
  return null;
}

function statusSummary(report) {
  return {
    ok: report.ok === true,
    mode: report.mode,
    records: report.records,
    passed: report.passed,
    failed: report.failed,
    dryRun: report.dryRun === true,
    modelLoaded: report.modelLoaded === true,
    safety: {
      openAiCalled: report.safety?.openAiCalled === true,
      trainingExecuted: report.safety?.trainingExecuted === true,
      vllmUsed: report.safety?.vllmUsed === true,
      railwayCliUsed: report.safety?.railwayCliUsed === true,
      liveDbUsed: report.safety?.liveDbUsed === true,
      noOpenAiOutputUsed: report.safety?.noOpenAiOutputUsed !== false,
    },
  };
}

export function buildReleaseManifest({
  registryPath = DEFAULT_REGISTRY,
  output = DEFAULT_RELEASE_MANIFEST,
  auditDir = DEFAULT_AUDIT_DIR,
  replayDir = DEFAULT_REPLAY_DIR,
} = {}) {
  const readiness = buildReadinessReport({ registryPath });
  const smoke = runSmoke({
    output: join(RUNTIME_REPORT_DIR, 'release-request-smoke-status.json'),
  });
  const regress = runRegression({
    output: join(RUNTIME_REPORT_DIR, 'release-request-regress-status.json'),
  });
  const latestAudit = latestJsonPath(auditDir, ['audit-20', 'audit-']);
  const latestReplay = latestJsonPath(replayDir, ['replay-20', 'replay-']);

  return {
    schemaVersion: 1,
    kind: 'gptoss_effective_router_runtime_release_manifest',
    generatedAt: new Date().toISOString(),
    releaseScope: 'local_controlled_runtime_only',
    output: toDisplayPath(output),
    modelScore: readiness.modelScore,
    effectiveScore: readiness.effectiveScore,
    localControlledRuntimeReady: readiness.localControlledRuntimeReady,
    modelOnlyReady: readiness.modelOnlyReady,
    cloudReady: false,
    customGptReady: false,
    baselineRegistryPath: registryPath,
    latestAuditArtifactPath: toDisplayPath(latestAudit),
    latestReplayArtifactPath: toDisplayPath(latestReplay),
    readiness: {
      modelScore: readiness.modelScore,
      effectiveScore: readiness.effectiveScore,
      localControlledRuntimeReady: readiness.localControlledRuntimeReady,
      modelOnlyReady: readiness.modelOnlyReady,
      cloudReady: false,
      customGptReady: false,
    },
    requiredRuntimeSupports: REQUIRED_RUNTIME_SUPPORTS,
    requiredRuntimeFlags: [
      '--router-classifier-mode',
      '--prefill-json-start',
      '--apply-hard-policy-overrides',
      '--use-local-spec-facts',
    ],
    paths: {
      baselineRegistry: registryPath,
      docs: [
        'docs/GPTOSS_LOCAL_RUNTIME.md',
        'docs/GPTOSS_RUNTIME_ARCHITECTURE.md',
      ],
      runtimeContractSchema: 'schemas/gptoss-effective-router-runtime.schema.json',
      runtimeRequestCli: 'scripts/gptoss/effective-router-request.mjs',
      auditLogger: 'scripts/gptoss/effective-router-audit-log.mjs',
      replayCli: 'scripts/gptoss/effective-router-replay.mjs',
      latestAuditArtifact: toDisplayPath(latestAudit),
      latestReplayArtifact: toDisplayPath(latestReplay),
    },
    requestStatus: {
      smoke: statusSummary(smoke),
      regress: statusSummary(regress),
    },
    excludedArtifactPatterns: EXCLUDED_ARTIFACT_PATTERNS,
    safetyConfirmations: {
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
      adapterWeightsIncluded: false,
      modelWeightsIncluded: false,
      cachesIncluded: false,
      secretsIncluded: false,
      railwayOutputsIncluded: false,
      dbRowsIncluded: false,
      rawSensitiveLocalReportsIncluded: false,
      publicServerCreated: false,
      customGptExposureEnabled: false,
    },
    safety: CLEAN_SAFETY_FLAGS,
  };
}

function parseArgs(argv = []) {
  const options = {
    registryPath: DEFAULT_REGISTRY,
    output: DEFAULT_RELEASE_MANIFEST,
    auditDir: DEFAULT_AUDIT_DIR,
    replayDir: DEFAULT_REPLAY_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--registry' && next) {
      options.registryPath = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--audit-dir' && next) {
      options.auditDir = next;
      index += 1;
    } else if (flag === '--replay-dir' && next) {
      options.replayDir = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = buildReleaseManifest(options);
  writeJson(options.output, manifest);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      safety: CLEAN_SAFETY_FLAGS,
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
