#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildReadinessReport } from './model-readiness-report.mjs';
import { RUNTIME_REPORT_DIR } from './effective-router-runtime.mjs';

export const DEFAULT_OUTPUT = join(RUNTIME_REPORT_DIR, 'cloud-readiness-gate.json');
export const RUNTIME_CONTRACT_SCRIPT = 'scripts/gptoss/effective-router-runtime.mjs';
export const RUNTIME_CONTRACT_SCHEMA = 'schemas/gptoss-effective-router-runtime.schema.json';
export const ARCHITECTURE_DOC = 'docs/GPTOSS_RUNTIME_ARCHITECTURE.md';

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

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function hasText(path, pattern) {
  return pattern.test(readTextIfExists(path));
}

export function buildCloudGate({
  registryPath,
  reportPath,
  architectureDoc = ARCHITECTURE_DOC,
} = {}) {
  const readiness = buildReadinessReport({ registryPath, reportPath });
  const checks = {
    effectiveScore24Of24: readiness.effectiveScore === '24/24',
    modelThresholdMet: readiness.modelOnlyReady === true,
    deterministicRuntimeSupportExplicitlyRequired: readiness.deterministicRuntimeSupportRequired === true,
    noOpenAiCallInEval: readiness.safety.openAiCalled === false,
    noTrainingDuringEval: readiness.safety.trainingExecuted === false,
    noVllmUsed: readiness.safety.vllmUsed === false,
    noRailwayCliUsed: readiness.safety.railwayCliUsed === false,
    noLiveDbUsed: readiness.safety.liveDbUsed === false,
    runtimeContractExists: existsSync(RUNTIME_CONTRACT_SCRIPT),
    runtimeContractSchemaExists: existsSync(RUNTIME_CONTRACT_SCHEMA),
    authBoundaryRequirementDocumented: hasText(architectureDoc, /auth boundary/i),
    cloudServingPathValidated: false,
    cloudAuthBoundaryExists: false,
    customGptActionBoundaryApproved: false,
    customGptDirectLocalDisallowed: hasText(
      architectureDoc,
      /direct custom gpt to local gpt-oss is disallowed|direct .*custom gpt.*local .*disallowed/i,
    ),
  };

  const modelOrDeterministicRuntimeReady = (
    checks.modelThresholdMet ||
    checks.deterministicRuntimeSupportExplicitlyRequired
  );
  const localControlledRuntimeReady = (
    readiness.localControlledRuntimeReady === true &&
    checks.effectiveScore24Of24 &&
    modelOrDeterministicRuntimeReady &&
    checks.noOpenAiCallInEval &&
    checks.noTrainingDuringEval &&
    checks.noVllmUsed &&
    checks.noRailwayCliUsed &&
    checks.noLiveDbUsed &&
    checks.runtimeContractExists &&
    checks.runtimeContractSchemaExists &&
    checks.customGptDirectLocalDisallowed
  );
  const cloudReady = (
    localControlledRuntimeReady &&
    checks.cloudServingPathValidated &&
    checks.cloudAuthBoundaryExists
  );
  const customGptReady = (
    cloudReady &&
    checks.customGptActionBoundaryApproved &&
    checks.customGptDirectLocalDisallowed
  );

  const blockers = [];
  if (!checks.modelThresholdMet) blockers.push('model_score_below_cloud_threshold');
  if (!checks.cloudServingPathValidated) blockers.push('serving_path_not_validated');
  if (!checks.cloudAuthBoundaryExists) blockers.push('cloud_auth_boundary_missing');
  if (!checks.customGptActionBoundaryApproved) blockers.push('custom_gpt_action_boundary_not_approved');
  if (!checks.customGptDirectLocalDisallowed) blockers.push('custom_gpt_direct_local_disallowance_missing');
  if (readiness.cloudReady !== true) blockers.push('readiness_report_cloud_ready_false');
  if (readiness.customGptReady !== true) blockers.push('readiness_report_custom_gpt_ready_false');

  return {
    schemaVersion: 1,
    kind: 'gptoss_cloud_readiness_gate',
    cloudReady,
    customGptReady,
    localControlledRuntimeReady,
    checks,
    blockers,
    readiness: {
      modelScore: readiness.modelScore,
      effectiveScore: readiness.effectiveScore,
      modelOnlyReady: readiness.modelOnlyReady,
      effectiveRuntimeReadyForLocalControlledTesting:
        readiness.effectiveRuntimeReadyForLocalControlledTesting,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
    },
    customGptDirectLocalExposureAllowed: false,
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
    registryPath: undefined,
    reportPath: undefined,
    output: DEFAULT_OUTPUT,
    write: true,
    reportOnly: false,
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
    } else if (flag === '--report-only') {
      options.reportOnly = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = buildCloudGate(options);
  if (options.write) {
    writeJson(options.output, result);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!options.reportOnly && (!result.cloudReady || !result.customGptReady)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
