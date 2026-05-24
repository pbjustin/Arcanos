#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repoRoot = process.cwd();
const localArtifactsRoot = resolve(repoRoot, 'local_artifacts');
const defaultOutputDir = 'local_artifacts/gptoss-force-final-comparison';
const evalFile = 'examples/gptoss/arcanos-eval-smoke.jsonl';

const knownAdapters = [
  { name: 'phase3-4-lowlr', adapterDir: 'local_artifacts/gptoss-phase3-4-lowlr', evaluateByDefault: true, normalEval: { passed: 4, failed: 20, source: 'known_baseline' } },
  { name: 'phase2', adapterDir: 'local_artifacts/gptoss-phase2', evaluateByDefault: true, normalEval: { passed: 7, failed: 17, source: 'known_baseline' } },
  { name: 'phase3-lowlr', adapterDir: 'local_artifacts/gptoss-phase3-lowlr', evaluateByDefault: true, normalEval: { passed: 4, failed: 20, source: 'known_baseline' } },
  { name: 'phase3', adapterDir: 'local_artifacts/gptoss-phase3', evaluateByDefault: true, normalEval: { passed: 2, failed: 22, source: 'existing_report_or_known_baseline' } },
  { name: 'phase3-prev', adapterDir: 'local_artifacts/gptoss-phase3-prev', evaluateByDefault: true, normalEval: { passed: 2, failed: 22, source: 'known_baseline' } },
  { name: 'single-json-overfit', adapterDir: 'local_artifacts/gptoss-single-json-overfit', evaluateByDefault: false, normalEval: null },
  { name: 'single-safety-overfit', adapterDir: 'local_artifacts/gptoss-single-safety-overfit', evaluateByDefault: false, normalEval: null },
  { name: 'micro-overfit', adapterDir: 'local_artifacts/gptoss-micro-overfit', evaluateByDefault: false, normalEval: null },
];

function parseArgs(argv) {
  const options = {
    outputDir: defaultOutputDir,
    adapterDirs: [],
    inventoryOnly: false,
    summaryOnly: false,
    maxNewTokens: 32,
    repetitionPenalty: '1.3',
    temperature: '0',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--adapter-dir') {
      options.adapterDirs.push(argv[++index]);
    } else if (arg === '--output-dir') {
      options.outputDir = argv[++index];
    } else if (arg === '--inventory-only') {
      options.inventoryOnly = true;
    } else if (arg === '--summary-only') {
      options.summaryOnly = true;
    } else if (arg === '--max-new-tokens') {
      options.maxNewTokens = Number(argv[++index]);
    } else if (arg === '--temperature') {
      options.temperature = argv[++index];
    } else if (arg === '--repetition-penalty') {
      options.repetitionPenalty = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function ensureLocalArtifactPath(path) {
  const resolved = resolve(repoRoot, path);
  const relativePath = relative(localArtifactsRoot, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`path must stay under local_artifacts: ${path}`);
  }
  return resolved;
}

function readJsonIfPresent(path) {
  const resolved = resolve(repoRoot, path);
  if (!existsSync(resolved)) {
    return null;
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

function writeJson(path, value) {
  const resolved = ensureLocalArtifactPath(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function adapterNameFromDir(adapterDir) {
  return basename(adapterDir).replace(/^gptoss-/, '');
}

function buildAdapterList(adapterDirs) {
  if (adapterDirs.length === 0) {
    return knownAdapters;
  }
  const knownByDir = new Map(knownAdapters.map((adapter) => [adapter.adapterDir.replace(/\\/g, '/'), adapter]));
  return adapterDirs.map((adapterDir) => {
    const normalized = adapterDir.replace(/\\/g, '/');
    const known = knownByDir.get(normalized);
    return known ?? {
      name: adapterNameFromDir(normalized),
      adapterDir: normalized,
      evaluateByDefault: true,
      normalEval: null,
    };
  });
}

function inspectAdapter(adapter) {
  let resolvedDir;
  try {
    resolvedDir = ensureLocalArtifactPath(adapter.adapterDir);
  } catch (error) {
    return {
      ...adapter,
      exists: false,
      validForEval: false,
      skipped: true,
      skipReason: error.message,
    };
  }

  const exists = existsSync(resolvedDir);
  if (!exists) {
    return {
      ...adapter,
      exists,
      validForEval: false,
      skipped: true,
      skipReason: 'adapter_directory_missing',
    };
  }

  const files = readdirSync(resolvedDir);
  const adapterConfigExists = files.includes('adapter_config.json');
  const adapterModelFiles = files.filter((file) => /^adapter_model\./.test(file));
  const metadataPath = resolve(resolvedDir, 'adapter-metadata.json');
  const adapterMetadataExists = existsSync(metadataPath);
  let metadataNoOpenAiOutputUsed = null;
  let metadataError = null;
  if (adapterMetadataExists) {
    try {
      metadataNoOpenAiOutputUsed = JSON.parse(readFileSync(metadataPath, 'utf8')).noOpenAiOutputUsed === true;
    } catch (error) {
      metadataError = error.message;
    }
  }

  const validForEval = adapterConfigExists
    && adapterModelFiles.length > 0
    && adapterMetadataExists
    && metadataNoOpenAiOutputUsed === true;
  return {
    ...adapter,
    exists,
    adapterConfigExists,
    adapterModelExists: adapterModelFiles.length > 0,
    adapterModelFiles,
    adapterMetadataExists,
    metadataNoOpenAiOutputUsed,
    metadataError,
    validForEval,
    skipped: !validForEval,
    skipReason: validForEval ? null : 'adapter_artifacts_incomplete_or_unsafe_metadata',
  };
}

function safetyFields() {
  return {
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
  };
}

function writeInventory(outputDir, adapters) {
  const inventory = {
    ok: true,
    kind: 'gptoss_force_final_adapter_inventory',
    evalFile,
    adapters,
    ...safetyFields(),
  };
  writeJson(`${outputDir}/adapter-inventory.json`, inventory);
  return inventory;
}

function forceFinalReportPath(adapterDir) {
  return `${adapterDir.replace(/\\/g, '/')}/eval-force-final.json`;
}

function runEval(adapter, options) {
  const output = forceFinalReportPath(adapter.adapterDir);
  const command = [
    'scripts/gptoss/eval-adapter-local.mjs',
    '--execute',
    '--adapter-dir', adapter.adapterDir,
    '--eval-file', evalFile,
    '--output', output,
    '--temperature', options.temperature,
    '--max-new-tokens', String(options.maxNewTokens),
    '--repetition-penalty', options.repetitionPenalty,
    '--force-final-channel',
  ];
  const completed = spawnSync('node', command, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const reportExists = existsSync(resolve(repoRoot, output));
  return {
    command: ['node', ...command],
    output,
    exitCode: completed.status,
    signal: completed.signal,
    reportExists,
    evalStatus: completed.status === 0 ? 'passed' : (reportExists ? 'report_written_eval_failed' : 'infrastructure_failed'),
  };
}

function readNormalEval(adapter) {
  const report = readJsonIfPresent(`${adapter.adapterDir}/eval-report.json`);
  if (report && Number.isFinite(report.passed) && Number.isFinite(report.failed) && report.records === 24) {
    return {
      passed: report.passed,
      failed: report.failed,
      source: `${adapter.adapterDir}/eval-report.json`,
    };
  }
  return adapter.normalEval;
}

function readForceEval(adapter, runResult = null) {
  const path = forceFinalReportPath(adapter.adapterDir);
  const report = readJsonIfPresent(path);
  if (!report) {
    return {
      path,
      reportExists: false,
      passed: 0,
      failed: 0,
      ok: false,
      evalStatus: runResult?.evalStatus ?? 'missing_report',
    };
  }
  return {
    path,
    reportExists: true,
    ok: report.ok === true,
    passed: Number(report.passed ?? 0),
    failed: Number(report.failed ?? 0),
    records: Number(report.records ?? 0),
    evalStatus: runResult?.evalStatus ?? 'report_found',
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
    safetyChecks: {
      allowedForTrainingFalse: report.allowedForTraining === false,
      openAiCalledFalse: report.openAiCalled === false,
      trainingExecutedFalse: report.trainingExecuted === false,
      vllmUsedFalse: report.vllmUsed === false,
      noOpenAiOutputUsedTrue: report.noOpenAiOutputUsed === true,
    },
  };
}

function summarizeAdapters(adapters, runResultsByName, includeInventoryOnly = false) {
  return adapters.map((adapter) => {
    if (!adapter.evaluateByDefault && !includeInventoryOnly) {
      return {
        name: adapter.name,
        adapterDir: adapter.adapterDir,
        skipped: true,
        skipReason: 'inventory_only_not_full_eval_adapter',
        normalEval: adapter.normalEval,
        forceFinalEval: {
          path: forceFinalReportPath(adapter.adapterDir),
          reportExists: false,
          passed: 0,
          failed: 0,
          ok: false,
          evalStatus: 'not_evaluated_inventory_only',
        },
        deltaPassed: null,
        ...safetyFields(),
      };
    }
    const runResult = runResultsByName.get(adapter.name) ?? null;
    const normalEval = readNormalEval(adapter);
    const forceFinalEval = readForceEval(adapter, runResult);
    const deltaPassed = normalEval ? forceFinalEval.passed - normalEval.passed : null;
    return {
      name: adapter.name,
      adapterDir: adapter.adapterDir,
      skipped: adapter.skipped,
      skipReason: adapter.skipReason,
      normalEval,
      forceFinalEval,
      deltaPassed,
      ...safetyFields(),
    };
  });
}

function bestAdapter(summaryAdapters) {
  const runnable = summaryAdapters.filter((adapter) => !adapter.skipped && adapter.forceFinalEval.reportExists);
  if (runnable.length === 0) {
    return null;
  }
  return runnable.reduce((best, current) => {
    if (current.forceFinalEval.passed > best.forceFinalEval.passed) {
      return current;
    }
    if (current.forceFinalEval.passed === best.forceFinalEval.passed && (current.deltaPassed ?? -999) > (best.deltaPassed ?? -999)) {
      return current;
    }
    return best;
  }, runnable[0]);
}

function writeSummary(outputDir, adapters) {
  const best = bestAdapter(adapters);
  const summary = {
    ok: true,
    kind: 'gptoss_force_final_comparison_summary',
    evalFile,
    forceFinalChannel: true,
    adapters,
    bestAdapter: best?.name ?? null,
    recommendation: recommendationFor(best, adapters),
    ...safetyFields(),
  };
  writeJson(`${outputDir}/force-final-comparison-summary.json`, summary);
  return summary;
}

function recommendationFor(best, adapters) {
  if (!best) {
    return 'No force-final adapter report was available; rerun comparison after valid adapters are present.';
  }
  const improved = adapters.some((adapter) => (adapter.deltaPassed ?? 0) > 0);
  if (!improved) {
    return 'Force-final did not improve full eval pass counts; inspect failure categories before changing training.';
  }
  return `${best.name} has the best force-final score; inspect remaining failures before any training decision.`;
}

function categoryForFailure(failure) {
  const reason = String(failure.reason ?? failure.failures?.join(', ') ?? '');
  const raw = String(failure.rawGeneratedTextSummary ?? '');
  const finalText = String(failure.finalText ?? '');
  const expected = failure.expected ?? {};
  if (failure.validJson === true && failure.requiredJsonFieldsPresent === true && reason) {
    return 'evaluator false negative';
  }
  if (/invalid_json/.test(reason) || failure.validJson === false) {
    return 'invalid JSON';
  }
  if (/plane_mismatch|missing:control|missing:writing/.test(reason)) {
    return 'route label missing';
  }
  if (/forbidden|secret|token|OPENAI|Railway|Custom GPT/i.test(reason) || /OpenAI reference|Railway production|Custom GPT/i.test(finalText)) {
    return 'safety boundary failure';
  }
  if (/missing:allowed|missing:validate_dataset|missing_json_field/.test(reason) || expected.json_object === true) {
    return 'wrong action';
  }
  if (/missing:/.test(reason)) {
    return 'missing required token';
  }
  if (failure.finalExtractionApplied && /first_json_object|final_marker|channel_prefix/.test(String(failure.finalExtractionReason ?? ''))) {
    return 'final extraction issue';
  }
  if (/(\b\w+\b)(?:\s+\1){2,}/i.test(`${raw} ${finalText}`)) {
    return 'repetition/degeneration';
  }
  return 'insufficient target likelihood';
}

function writeFailureBreakdown(outputDir, summary) {
  const best = summary.adapters.find((adapter) => adapter.name === summary.bestAdapter);
  const report = best ? readJsonIfPresent(best.forceFinalEval.path) : null;
  const categories = new Map();
  for (const failure of report?.failures ?? []) {
    const category = categoryForFailure(failure);
    const entry = categories.get(category) ?? { category, count: 0, recordIds: [] };
    entry.count += 1;
    entry.recordIds.push(failure.id);
    categories.set(category, entry);
  }
  const breakdown = {
    ok: true,
    kind: 'gptoss_force_final_best_adapter_failure_breakdown',
    evalFile,
    bestAdapter: summary.bestAdapter,
    adapterDir: best?.adapterDir ?? null,
    forceFinalEval: best?.forceFinalEval ?? null,
    categories: [...categories.values()].sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)),
    ...safetyFields(),
  };
  writeJson(`${outputDir}/best-adapter-failure-breakdown.json`, breakdown);
  return breakdown;
}

function writeDecision(outputDir, summary, breakdown) {
  const decisions = [];
  const phase34 = summary.adapters.find((adapter) => adapter.name === 'phase3-4-lowlr');
  const phase2 = summary.adapters.find((adapter) => adapter.name === 'phase2');
  const best = summary.adapters.find((adapter) => adapter.name === summary.bestAdapter);
  const improvedAny = summary.adapters.some((adapter) => (adapter.deltaPassed ?? 0) > 0);
  const categoryNames = new Set((breakdown.categories ?? []).map((entry) => entry.category));

  if ((phase34?.forceFinalEval.passed ?? 0) > 7) {
    decisions.push('phase34_becomes_best', 'force_final_makes_adapter_usable');
  }
  if (phase2 && summary.bestAdapter === 'phase2') {
    decisions.push('phase2_remains_best');
  }
  if (!improvedAny) {
    decisions.push('force_final_does_not_help_full_eval', 'decoding_or_extraction_next');
  }
  if (categoryNames.has('invalid JSON') && !categoryNames.has('route label missing') && !categoryNames.has('safety boundary failure')) {
    decisions.push('force_final_only_helps_json', 'dataset_target_shape_next');
  }
  if (categoryNames.has('route label missing') || categoryNames.has('wrong action') || categoryNames.has('missing required token')) {
    decisions.push('dataset_target_shape_next');
  }
  if (categoryNames.has('repetition/degeneration') || categoryNames.has('final extraction issue')) {
    decisions.push('decoding_or_extraction_next');
  }
  if (best && best.forceFinalEval.reportExists && best.forceFinalEval.passed > 0 && best.forceFinalEval.passed <= (best.normalEval?.passed ?? 0)) {
    decisions.push('training_dynamics_next');
  }

  const uniqueDecisions = [...new Set(decisions)];
  const decision = {
    ok: true,
    kind: 'gptoss_force_final_next_decision',
    evalFile,
    decisions: uniqueDecisions.length > 0 ? uniqueDecisions : ['training_dynamics_next'],
    bestAdapter: summary.bestAdapter,
    bestForceFinalPassed: best?.forceFinalEval.passed ?? 0,
    phase34ForceFinalPassed: phase34?.forceFinalEval.passed ?? 0,
    phase2ForceFinalPassed: phase2?.forceFinalEval.passed ?? 0,
    ...safetyFields(),
  };
  writeJson(`${outputDir}/next-decision.json`, decision);
  return decision;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = options.outputDir.replace(/\\/g, '/');
  ensureLocalArtifactPath(outputDir);
  const adapters = buildAdapterList(options.adapterDirs).map(inspectAdapter);
  const inventory = writeInventory(outputDir, adapters);
  if (options.inventoryOnly) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }

  const runResultsByName = new Map();
  if (!options.summaryOnly) {
    for (const adapter of adapters.filter((candidate) => candidate.evaluateByDefault && candidate.validForEval)) {
      runResultsByName.set(adapter.name, runEval(adapter, options));
    }
  }

  const summaryAdapters = summarizeAdapters(adapters, runResultsByName, options.adapterDirs.length > 0);
  const summary = writeSummary(outputDir, summaryAdapters);
  const breakdown = writeFailureBreakdown(outputDir, summary);
  const decision = writeDecision(outputDir, summary, breakdown);
  console.log(JSON.stringify({ inventoryPath: `${outputDir}/adapter-inventory.json`, summary, breakdown, decision }, null, 2));
}

try {
  main();
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: 'force_final_comparison_failed',
    message: error instanceof Error ? error.message : String(error),
    ...safetyFields(),
  }, null, 2));
  process.exit(2);
}

export {
  buildAdapterList,
  categoryForFailure,
  inspectAdapter,
  recommendationFor,
  safetyFields,
};
