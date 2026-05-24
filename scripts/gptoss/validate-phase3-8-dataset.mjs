#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateJsonl } from './dataset-gate.mjs';

const DEFAULT_DATASET = 'examples/gptoss/arcanos-phase3-8-true-error-repair-training.jsonl';
const DEFAULT_EVAL_REPORT = 'local_artifacts/gptoss-phase3-7-lowlr/eval-router-classifier-postprocessed-v2.json';
const APPROVED_SOURCES = new Set(['arcanos_owned_spec', 'repo_schema', 'human_authored']);
const FORBIDDEN_SOURCES = new Set([
  'eval_failure_observation',
  'self_reflection_observation',
  'railway_cli_observation',
  'openai_output',
  'openai_judgment',
]);
const TARGET_SHAPES = new Set(['label_only', 'json_only', 'compact_final']);
const REQUIRED_TOKENS = ['TypeScript', 'QLoRA 4-bit', '100', 'false', 'control-plane', 'writing-plane', 'validate_dataset'];

function parseArgs(argv) {
  const options = {
    dataset: DEFAULT_DATASET,
    evalReport: DEFAULT_EVAL_REPORT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--eval-report' && next) {
      options.evalReport = next;
      index += 1;
    } else if (!flag.startsWith('--')) {
      options.dataset = flag;
    }
  }

  return options;
}

function parseRows(filePath, errors) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => {
      try {
        return { lineNumber, record: JSON.parse(line) };
      } catch {
        errors.push({ line: lineNumber, code: 'phase38_invalid_json' });
        return null;
      }
    })
    .filter(Boolean);
}

function assistantTarget(record) {
  return record.messages?.find((message) => message.role === 'assistant')?.content || '';
}

function readObservedTargets(reportPath) {
  if (!reportPath || !existsSync(reportPath)) {
    return new Set();
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const failures = Array.isArray(report.failures)
    ? report.failures
    : Object.values(report.results || {}).filter((result) => result?.passed === false);
  return new Set(
    failures
      .flatMap((failure) => [failure.finalText, failure.assembledFinalText])
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim()),
  );
}

function validatePhase38Record(record, lineNumber, observedTargets, errors) {
  if (FORBIDDEN_SOURCES.has(record.source)) {
    errors.push({ line: lineNumber, code: 'phase38_forbidden_source', source: record.source });
  }

  if (!APPROVED_SOURCES.has(record.source)) {
    errors.push({ line: lineNumber, code: 'phase38_source_not_approved', source: record.source ?? null });
  }

  if (record.reviewed !== true) {
    errors.push({ line: lineNumber, code: 'phase38_review_required' });
  }

  if (record.allowed_for_training !== true) {
    errors.push({ line: lineNumber, code: 'phase38_training_flag_required' });
  }

  if (record.metadata?.no_openai_output_used !== true) {
    errors.push({ line: lineNumber, code: 'phase38_no_openai_required' });
  }

  if (record.metadata?.phase3_8_repair !== true) {
    errors.push({ line: lineNumber, code: 'phase38_repair_flag_required' });
  }

  if (!TARGET_SHAPES.has(record.metadata?.target_shape)) {
    errors.push({ line: lineNumber, code: 'phase38_target_shape_required' });
  }

  if (!Array.isArray(record.messages) || 'text' in record) {
    errors.push({ line: lineNumber, code: 'phase38_messages_format_required' });
  }

  const target = assistantTarget(record);
  if (observedTargets.has(target.trim())) {
    errors.push({ line: lineNumber, code: 'phase38_raw_eval_output_target_rejected' });
  }

  if (record.metadata?.target_shape === 'json_only') {
    try {
      JSON.parse(target);
    } catch {
      errors.push({ line: lineNumber, code: 'phase38_json_target_invalid' });
    }
  }

  if (
    record.metadata?.target_shape === 'label_only' &&
    (!/^\S{1,64}$/.test(target) || /[{}[\]:,]/.test(target))
  ) {
    errors.push({ line: lineNumber, code: 'phase38_label_target_not_compact' });
  }
}

function categoryBreakdown(rows) {
  return rows.reduce((counts, { record }) => {
    const taskType = record.task_type || 'unknown';
    counts[taskType] = (counts[taskType] || 0) + 1;
    return counts;
  }, {});
}

function tokenCoverage(repairRows) {
  const targets = repairRows.map(({ record }) => assistantTarget(record));
  const labelTargets = repairRows
    .filter(({ record }) => record.metadata?.target_shape === 'label_only')
    .map(({ record }) => assistantTarget(record));
  const jsonTargets = repairRows
    .filter(({ record }) => record.metadata?.target_shape === 'json_only')
    .map(({ record }) => assistantTarget(record));

  return {
    TypeScript: targets.some((target) => target.includes('TypeScript')),
    'QLoRA 4-bit': targets.some((target) => target.includes('QLoRA 4-bit')),
    '100': targets.some((target) => /\b100\b/.test(target)),
    false: targets.some((target) => target === 'false' || target.includes(':false')),
    'control-plane': labelTargets.includes('control-plane'),
    'writing-plane': labelTargets.includes('writing-plane'),
    validate_dataset: jsonTargets.some((target) => target.includes('validate_dataset')),
  };
}

export function validatePhase38Dataset(filePath = DEFAULT_DATASET, options = {}) {
  const gateResult = validateJsonl(filePath);
  const errors = [...gateResult.errors];
  const rows = parseRows(filePath, errors);
  const observedTargets = readObservedTargets(options.evalReport ?? DEFAULT_EVAL_REPORT);

  for (const row of rows) {
    validatePhase38Record(row.record, row.lineNumber, observedTargets, errors);
  }

  const repairRows = rows.filter(({ record }) => record.metadata?.phase3_8_repair === true);
  const openAiRejections = repairRows.filter(({ record }) => record.task_type === 'openai_output_rejection');
  const coverage = tokenCoverage(repairRows);

  if (repairRows.length < 8 || repairRows.length > 16) {
    errors.push({ code: 'phase38_repair_record_count_invalid', count: repairRows.length });
  }

  if (openAiRejections.length === 0 || openAiRejections.some(({ record }) => !assistantTarget(record).startsWith('No.'))) {
    errors.push({ code: 'phase38_openai_rejections_must_begin_no' });
  }

  for (const token of REQUIRED_TOKENS) {
    if (!coverage[token]) {
      errors.push({ code: 'phase38_required_token_missing', token });
    }
  }

  return {
    ok: errors.length === 0,
    file: filePath,
    checked: rows.length,
    accepted: errors.length === 0 ? rows.length : 0,
    rejected: errors.length === 0 ? 0 : rows.length,
    repairRecords: repairRows.length,
    categoryBreakdown: categoryBreakdown(repairRows),
    gate: gateResult,
    coverage,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliExecuted: false,
    liveDbWrite: false,
    errors,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = validatePhase38Dataset(options.dataset, { evalReport: options.evalReport });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
