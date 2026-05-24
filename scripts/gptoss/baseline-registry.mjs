#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REGISTRY = 'examples/gptoss/gptoss-baseline-registry.json';
export const PHASE_313_BASELINE_ID = 'phase3.13';
export const PHASE_313_EVAL_REPORT =
  'local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-effective-spec-v3.json';

const REQUIRED_RUNTIME_FLAGS = [
  '--router-classifier-mode',
  '--prefill-json-start',
  '--apply-hard-policy-overrides',
  '--use-local-spec-facts',
];

const REQUIRED_DIAGNOSTIC_MODES = {
  '--router-classifier-mode': 'routerClassifierMode',
  '--prefill-json-start': 'prefillJsonStart',
  '--apply-hard-policy-overrides': 'applyHardPolicyOverrides',
  '--use-local-spec-facts': 'useLocalSpecFacts',
};

export function parseArgs(argv = []) {
  const options = {
    command: argv[0] || 'regress',
    registry: DEFAULT_REGISTRY,
    baselineId: PHASE_313_BASELINE_ID,
    report: undefined,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--registry' && next) {
      options.registry = next;
      index += 1;
    } else if (flag === '--baseline-id' && next) {
      options.baselineId = next;
      index += 1;
    } else if (flag === '--report' && next) {
      options.report = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  if (!['record', 'regress'].includes(options.command)) {
    throw new Error(`Unknown baseline command: ${options.command}`);
  }

  return options;
}

function readJson(path) {
  if (!existsSync(path)) {
    throw new Error(`missing_json_file:${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function score(passed, failed, records) {
  const resolvedPassed = finiteNumber(Number(passed));
  const resolvedFailed = finiteNumber(Number(failed));
  const resolvedRecords = finiteNumber(Number(records), resolvedPassed + resolvedFailed);
  return {
    passed: resolvedPassed,
    failed: resolvedFailed,
    records: resolvedRecords,
  };
}

function modelScoreFromReport(report) {
  return score(report.passed, report.failed, report.records);
}

function hasModelScore(report) {
  return (
    Number.isFinite(Number(report?.passed)) &&
    Number.isFinite(Number(report?.failed)) &&
    Number.isFinite(Number(report?.records))
  );
}

function effectiveScoreFromReport(report) {
  return score(
    report.effectiveRouterScore?.passed ?? report.effectivePassed,
    report.effectiveRouterScore?.failed ?? report.effectiveFailed,
    report.records,
  );
}

function anyTruthy(report, names) {
  return names.some((name) => report?.[name] === true);
}

function buildSafetyFlags(report) {
  return {
    allowedForTraining: report.allowedForTraining === false,
    openAiCalled: report.openAiCalled === false,
    trainingExecuted: report.trainingExecuted === false,
    vllmUsed: report.vllmUsed === false,
    noOpenAiOutputUsed: report.noOpenAiOutputUsed === true,
    railwayCliUsed: !anyTruthy(report, ['railwayCliUsed', 'railwayCliExecuted']),
    liveDbUsed: !anyTruthy(report, ['liveDbUsed', 'liveDbConnected', 'liveDbWrite']),
  };
}

function buildRuntimeFlags(report, baseline) {
  const diagnosticModes = report.diagnosticModes ?? {};
  const requiredFlags = baseline.requiredRuntimeFlags ?? [];
  return Object.fromEntries(
    requiredFlags.map((flag) => [flag, diagnosticModes[REQUIRED_DIAGNOSTIC_MODES[flag]] === true]),
  );
}

export function buildPhase313Baseline(report) {
  return {
    id: PHASE_313_BASELINE_ID,
    label: 'Phase 3.13',
    adapterPath: 'local_artifacts/gptoss-phase3-8-lowlr',
    evalReport: PHASE_313_EVAL_REPORT,
    modelScore: {
      passed: 11,
      failed: 13,
      records: 24,
    },
    effectiveScore: {
      passed: 24,
      failed: 0,
      records: 24,
    },
    requiredRuntimeFlags: REQUIRED_RUNTIME_FLAGS,
    requiredDiagnosticModes: Object.fromEntries(
      REQUIRED_RUNTIME_FLAGS.map((flag) => [REQUIRED_DIAGNOSTIC_MODES[flag], true]),
    ),
    safetyFlags: {
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      noOpenAiOutputUsed: true,
      railwayCliUsed: anyTruthy(report, ['railwayCliUsed', 'railwayCliExecuted']),
      liveDbUsed: anyTruthy(report, ['liveDbUsed', 'liveDbConnected', 'liveDbWrite']),
    },
  };
}

function readRegistry(path) {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      kind: 'gptoss_baseline_registry',
      current: PHASE_313_BASELINE_ID,
      baselines: [],
    };
  }
  return readJson(path);
}

function upsertBaseline(registry, baseline) {
  const baselines = Array.isArray(registry.baselines) ? registry.baselines : [];
  const nextBaselines = baselines.filter((entry) => entry?.id !== baseline.id);
  nextBaselines.push(baseline);
  nextBaselines.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    schemaVersion: registry.schemaVersion ?? 1,
    kind: registry.kind ?? 'gptoss_baseline_registry',
    current: baseline.id,
    baselines: nextBaselines,
  };
}

function findBaseline(registry, baselineId) {
  const baseline = (Array.isArray(registry.baselines) ? registry.baselines : [])
    .find((entry) => entry?.id === baselineId);
  if (!baseline) {
    throw new Error(`missing_baseline:${baselineId}`);
  }
  return baseline;
}

export function validateRegression(report, baseline) {
  const model = modelScoreFromReport(report);
  const effective = effectiveScoreFromReport(report);
  const safety = buildSafetyFlags(report);
  const runtimeFlags = buildRuntimeFlags(report, baseline);
  const failures = [];

  if (!hasModelScore(report)) {
    failures.push('model_score_missing');
  }

  if (
    effective.passed < baseline.effectiveScore.passed ||
    effective.failed > baseline.effectiveScore.failed ||
    effective.records !== baseline.effectiveScore.records
  ) {
    failures.push('effective_score_below_24_of_24');
  }

  for (const [flag, present] of Object.entries(runtimeFlags)) {
    if (!present) {
      failures.push(`missing_runtime_flag:${flag}`);
    }
  }

  if (!safety.allowedForTraining) failures.push('allowed_for_training_not_false');
  if (!safety.openAiCalled) failures.push('openai_called');
  if (!safety.trainingExecuted) failures.push('training_executed');
  if (!safety.vllmUsed) failures.push('vllm_used');
  if (!safety.noOpenAiOutputUsed) failures.push('no_openai_output_used_not_true');
  if (!safety.railwayCliUsed) failures.push('railway_cli_used');
  if (!safety.liveDbUsed) failures.push('live_db_used');

  return {
    ok: failures.length === 0,
    baselineId: baseline.id,
    adapterPath: baseline.adapterPath,
    evalReport: baseline.evalReport,
    modelScore: model,
    effectiveScore: effective,
    requiredRuntimeFlags: runtimeFlags,
    safetyChecks: safety,
    failures,
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
  };
}

function validateRecordInput(report, baseline) {
  const regression = validateRegression(report, baseline);
  const model = modelScoreFromReport(report);
  const failures = [...regression.failures];
  if (
    model.passed !== baseline.modelScore.passed ||
    model.failed !== baseline.modelScore.failed ||
    model.records !== baseline.modelScore.records
  ) {
    failures.push('model_score_mismatch');
  }
  return {
    ...regression,
    ok: failures.length === 0,
    failures,
  };
}

export function run(options) {
  if (options.command === 'record') {
    const reportPath = options.report || PHASE_313_EVAL_REPORT;
    const report = readJson(reportPath);
    const baseline = buildPhase313Baseline(report);
    const checks = validateRecordInput(report, baseline);
    if (!checks.ok) {
      return {
        ok: false,
        mode: 'record',
        registry: options.registry,
        report: reportPath,
        checks,
      };
    }
    const registry = upsertBaseline(readRegistry(options.registry), baseline);
    writeJson(options.registry, registry);
    return {
      ok: true,
      mode: 'record',
      registry: options.registry,
      baseline,
      checks,
    };
  }

  const registry = readRegistry(options.registry);
  const baseline = findBaseline(registry, options.baselineId);
  const reportPath = options.report || baseline.evalReport;
  const report = readJson(reportPath);
  return {
    mode: 'regress',
    registry: options.registry,
    ...validateRegression(report, baseline),
  };
}

async function main() {
  const result = run(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
