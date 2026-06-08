#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DEFAULT_REGISTRY } from './baseline-registry.mjs';
import { RUNTIME_REPORT_DIR } from './effective-router-runtime.mjs';

export const MODEL_READY_THRESHOLD_PASSED = 20;
export const DEFAULT_OUTPUT = join(RUNTIME_REPORT_DIR, 'model-readiness-report.json');
export const PRIVATE_SERVING_DESIGN_READINESS = {
  privateServingDesignReady: true,
  privateServingScaffoldReady: true,
  privateServingImplemented: false,
  privateServingExposed: false,
  requestSigningDesigned: true,
  requestSigningScaffoldReady: true,
  requestSigningImplemented: true,
  authBoundaryDesigned: true,
  authBoundaryScaffoldReady: true,
  authBoundaryImplemented: true,
  replayProtectionScaffoldReady: true,
  replayProtectionImplemented: true,
  replayProtectionDurable: false,
  rateLimitScaffoldReady: true,
  rateLimitImplemented: false,
  responseShapingScaffoldReady: true,
  publicServerCreated: false,
  customGptExposureCreated: false,
};

function readJson(path) {
  if (!existsSync(path)) {
    throw new Error(`missing_json_file:${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function optionalJson(path) {
  return existsSync(path) ? readJson(path) : undefined;
}

function assertRuntimeReportPath(path) {
  const resolvedOutput = resolve(process.cwd(), path);
  const resolvedRoot = resolve(process.cwd(), RUNTIME_REPORT_DIR);
  const child = relative(resolvedRoot, resolvedOutput);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`runtime report must stay under ${RUNTIME_REPORT_DIR}: ${path}`);
  }
}

function writeJson(path, value) {
  assertRuntimeReportPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function currentBaseline(registry) {
  const current = registry.current;
  const baseline = (Array.isArray(registry.baselines) ? registry.baselines : [])
    .find((entry) => entry?.id === current);
  if (!baseline) {
    throw new Error(`missing_current_baseline:${current}`);
  }
  return baseline;
}

function scoreString(score) {
  return `${score.passed}/${score.records}`;
}

function scoreFromValues(values, fallback) {
  const passed = Number(values?.passed ?? fallback?.passed);
  const failed = Number(values?.failed ?? fallback?.failed);
  const records = Number(values?.records ?? fallback?.records ?? (passed + failed));
  return {
    passed: Number.isFinite(passed) ? passed : 0,
    failed: Number.isFinite(failed) ? failed : 0,
    records: Number.isFinite(records) ? records : 0,
  };
}

function modelScore(report, baseline) {
  return scoreFromValues({
    passed: report?.modelScore?.passed ?? report?.passed,
    failed: report?.modelScore?.failed ?? report?.failed,
    records: report?.modelScore?.records ?? report?.records,
  }, baseline.modelScore);
}

function effectiveScore(report, baseline) {
  return scoreFromValues({
    passed: report?.effectiveRouterScore?.passed ?? report?.effectivePassed,
    failed: report?.effectiveRouterScore?.failed ?? report?.effectiveFailed,
    records: report?.effectiveRouterScore?.records ?? report?.records,
  }, baseline.effectiveScore);
}

function anyTruthy(report, names) {
  return names.some((name) => report?.[name] === true);
}

function safetyFlags(report, baseline) {
  const baselineSafety = baseline.safetyFlags || {};
  return {
    allowedForTraining: report?.allowedForTraining ?? baselineSafety.allowedForTraining,
    openAiCalled: report?.openAiCalled ?? baselineSafety.openAiCalled,
    trainingExecuted: report?.trainingExecuted ?? baselineSafety.trainingExecuted,
    vllmUsed: report?.vllmUsed ?? baselineSafety.vllmUsed,
    railwayCliUsed: anyTruthy(report, ['railwayCliUsed', 'railwayCliExecuted'])
      ? true
      : Boolean(baselineSafety.railwayCliUsed),
    liveDbUsed: anyTruthy(report, ['liveDbUsed', 'liveDbConnected', 'liveDbWrite'])
      ? true
      : Boolean(baselineSafety.liveDbUsed),
    noOpenAiOutputUsed: report?.noOpenAiOutputUsed ?? baselineSafety.noOpenAiOutputUsed,
  };
}

function safetyClean(safety) {
  return (
    safety.allowedForTraining === false &&
    safety.openAiCalled === false &&
    safety.trainingExecuted === false &&
    safety.vllmUsed === false &&
    safety.railwayCliUsed === false &&
    safety.liveDbUsed === false &&
    safety.noOpenAiOutputUsed === true
  );
}

export function buildReadinessReport({
  registryPath = DEFAULT_REGISTRY,
  reportPath,
} = {}) {
  const registry = readJson(registryPath);
  const baseline = currentBaseline(registry);
  const resolvedReportPath = reportPath || baseline.evalReport;
  const report = optionalJson(resolvedReportPath);
  const model = modelScore(report, baseline);
  const effective = effectiveScore(report, baseline);
  const safety = safetyFlags(report, baseline);
  const modelOnlyReady = model.passed >= MODEL_READY_THRESHOLD_PASSED && model.records === 24;
  const effectiveRuntimeReadyForLocalControlledTesting = (
    effective.passed === 24 &&
    effective.failed === 0 &&
    effective.records === 24 &&
    safetyClean(safety)
  );

  return {
    schemaVersion: 1,
    kind: 'gptoss_model_readiness_report',
    baselineId: baseline.id,
    modelScore: scoreString(model),
    effectiveScore: scoreString(effective),
    modelScoreDetail: model,
    effectiveScoreDetail: effective,
    thresholds: {
      modelOnlyReadyPassedMinimum: MODEL_READY_THRESHOLD_PASSED,
      totalRecords: 24,
      effectiveRequiredPassed: 24,
    },
    modelOnlyReady,
    effectiveRuntimeReadyForLocalControlledTesting,
    localControlledRuntimeReady: effectiveRuntimeReadyForLocalControlledTesting,
    deterministicRuntimeSupportRequired: true,
    ...PRIVATE_SERVING_DESIGN_READINESS,
    cloudReady: false,
    customGptReady: false,
    safety,
    reason: [
      'model-only score below threshold',
      'effective behavior depends on local deterministic policy/spec/postprocessor layers',
      'serving path not validated',
      'OpenAI reference comparison not enabled',
      'Cloud/Custom GPT exposure not approved',
    ],
    sources: {
      registry: registryPath,
      evalReport: resolvedReportPath,
      evalReportLoaded: Boolean(report),
      evalReportSource: report ? 'eval_report' : 'baseline_registry',
    },
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    noOpenAiOutputUsed: true,
  };
}

function parseArgs(argv = []) {
  const options = {
    registryPath: DEFAULT_REGISTRY,
    reportPath: undefined,
    output: DEFAULT_OUTPUT,
    write: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--registry' && next) {
      options.registryPath = next;
      index += 1;
    } else if (flag === '--report' && next) {
      options.reportPath = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--no-write') {
      options.write = false;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = buildReadinessReport(options);
  if (options.write) {
    writeJson(options.output, result);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
