#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateJsonl } from './dataset-gate.mjs';

const DEFAULT_DATASET = 'examples/gptoss/arcanos-phase3-7-weighted-repair-training.jsonl';
const APPROVED_SOURCES = new Set(['arcanos_owned_spec', 'repo_schema', 'human_authored']);
const TARGET_SHAPES = new Set(['label_only', 'json_only', 'compact_final']);
const REQUIRED_TOKENS = ['No', 'TypeScript', 'control-plane', 'writing-plane', 'validate_dataset', 'QLoRA 4-bit', '100', 'false'];

function parseRows(filePath, errors) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => {
      try {
        return { lineNumber, record: JSON.parse(line) };
      } catch {
        errors.push({ line: lineNumber, code: 'phase37_invalid_json' });
        return null;
      }
    })
    .filter(Boolean);
}

function assistantTarget(record) {
  return record.messages?.find((message) => message.role === 'assistant')?.content || '';
}

function validatePhase37Record(record, lineNumber, errors) {
  if (!APPROVED_SOURCES.has(record.source)) {
    errors.push({ line: lineNumber, code: 'phase37_source_not_approved', source: record.source ?? null });
  }

  if (record.source === 'railway_cli_observation') {
    errors.push({ line: lineNumber, code: 'phase37_railway_observation_forbidden' });
  }

  if (record.reviewed !== true) {
    errors.push({ line: lineNumber, code: 'phase37_review_required' });
  }

  if (record.allowed_for_training !== true) {
    errors.push({ line: lineNumber, code: 'phase37_training_flag_required' });
  }

  if (record.metadata?.no_openai_output_used !== true) {
    errors.push({ line: lineNumber, code: 'phase37_no_openai_required' });
  }

  if (!TARGET_SHAPES.has(record.metadata?.target_shape)) {
    errors.push({ line: lineNumber, code: 'phase37_target_shape_required' });
  }

  const target = assistantTarget(record);
  if (record.metadata?.target_shape === 'json_only') {
    try {
      JSON.parse(target);
    } catch {
      errors.push({ line: lineNumber, code: 'phase37_json_target_invalid' });
    }
  }

  if (
    record.metadata?.target_shape === 'label_only' &&
    (!/^\S{1,64}$/.test(target) || /[{}[\]:,]/.test(target))
  ) {
    errors.push({ line: lineNumber, code: 'phase37_label_target_not_compact' });
  }
}

function tokenCoverage(targets, labelTargets) {
  return {
    No: targets.some((target) => target.startsWith('No')),
    TypeScript: targets.some((target) => target.includes('TypeScript')),
    'control-plane': labelTargets.includes('control-plane'),
    'writing-plane': labelTargets.includes('writing-plane'),
    validate_dataset: targets.some((target) => target.includes('validate_dataset')),
    'QLoRA 4-bit': targets.some((target) => target.includes('QLoRA 4-bit')),
    '100': targets.some((target) => /\b100\b/.test(target)),
    false: targets.some((target) => target === 'false' || target.includes(':false')),
  };
}

export function validatePhase37Dataset(filePath = DEFAULT_DATASET) {
  const gateResult = validateJsonl(filePath);
  const errors = [...gateResult.errors];
  const rows = parseRows(filePath, errors);

  for (const row of rows) {
    validatePhase37Record(row.record, row.lineNumber, errors);
  }

  const repairRows = rows.filter(({ record }) => record.metadata?.phase3_7_repair === true);
  const targets = repairRows.map(({ record }) => assistantTarget(record));
  const labelTargets = repairRows
    .filter(({ record }) => record.metadata?.target_shape === 'label_only')
    .map(({ record }) => assistantTarget(record));
  const openAiRejections = repairRows.filter(({ record }) => record.task_type === 'openai_output_rejection');
  const coverage = tokenCoverage(targets, labelTargets);

  if (repairRows.length < 16 || repairRows.length > 24) {
    errors.push({ code: 'phase37_repair_record_count_invalid', count: repairRows.length });
  }

  if (openAiRejections.length < 5 || openAiRejections.some(({ record }) => !assistantTarget(record).startsWith('No'))) {
    errors.push({ code: 'phase37_openai_rejections_must_begin_no' });
  }

  for (const token of REQUIRED_TOKENS) {
    if (!coverage[token]) {
      errors.push({ code: 'phase37_required_token_missing', token });
    }
  }

  return {
    ok: errors.length === 0,
    file: filePath,
    checked: rows.length,
    accepted: errors.length === 0 ? rows.length : 0,
    rejected: errors.length === 0 ? 0 : rows.length,
    repairRecords: repairRows.length,
    gate: gateResult,
    coverage,
    errors,
  };
}

export function main(argv = process.argv.slice(2)) {
  const result = validatePhase37Dataset(argv[0] || DEFAULT_DATASET);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
