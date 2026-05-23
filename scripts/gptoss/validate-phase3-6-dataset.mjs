#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateJsonl } from './dataset-gate.mjs';

const DEFAULT_DATASET = 'examples/gptoss/arcanos-phase3-6-action-label-training.jsonl';
const APPROVED_SOURCES = new Set(['arcanos_owned_spec', 'repo_schema', 'human_authored']);
const TARGET_SHAPES = new Set(['label_only', 'json_only', 'compact_final']);

function parseRows(filePath, errors) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => {
      try {
        return { lineNumber, record: JSON.parse(line) };
      } catch {
        errors.push({ line: lineNumber, code: 'phase36_invalid_json' });
        return null;
      }
    })
    .filter(Boolean);
}

function assistantTarget(record) {
  return record.messages?.find((message) => message.role === 'assistant')?.content || '';
}

function validatePhase36Record(record, lineNumber, errors) {
  if (!APPROVED_SOURCES.has(record.source)) {
    errors.push({ line: lineNumber, code: 'phase36_source_not_approved', source: record.source ?? null });
  }

  if (record.source === 'railway_cli_observation') {
    errors.push({ line: lineNumber, code: 'phase36_railway_observation_forbidden' });
  }

  if (record.reviewed !== true) {
    errors.push({ line: lineNumber, code: 'phase36_review_required' });
  }

  if (record.allowed_for_training !== true) {
    errors.push({ line: lineNumber, code: 'phase36_training_flag_required' });
  }

  if (record.metadata?.no_openai_output_used !== true) {
    errors.push({ line: lineNumber, code: 'phase36_no_openai_required' });
  }

  if (!TARGET_SHAPES.has(record.metadata?.target_shape)) {
    errors.push({ line: lineNumber, code: 'phase36_target_shape_required' });
  }

  const target = assistantTarget(record);
  if (record.metadata?.target_shape === 'json_only') {
    try {
      JSON.parse(target);
    } catch {
      errors.push({ line: lineNumber, code: 'phase36_json_target_invalid' });
    }
  }

  if (
    record.metadata?.target_shape === 'label_only' &&
    (!/^\S{1,64}$/.test(target) || /[{}[\]:,]/.test(target))
  ) {
    errors.push({ line: lineNumber, code: 'phase36_label_target_not_compact' });
  }
}

export function validatePhase36Dataset(filePath = DEFAULT_DATASET) {
  const gateResult = validateJsonl(filePath);
  const errors = [...gateResult.errors];
  const rows = parseRows(filePath, errors);

  for (const row of rows) {
    validatePhase36Record(row.record, row.lineNumber, errors);
  }

  const newRows = rows.filter(({ record }) => String(record.id).startsWith('phase3-6-'));
  const targets = newRows.map(({ record }) => assistantTarget(record));
  const labelTargets = newRows
    .filter(({ record }) => record.metadata?.target_shape === 'label_only')
    .map(({ record }) => assistantTarget(record));

  if (newRows.length < 24 || newRows.length > 32) {
    errors.push({ code: 'phase36_targeted_record_count_invalid', count: newRows.length });
  }

  if (!targets.some((target) => target.includes('validate_dataset'))) {
    errors.push({ code: 'phase36_validate_dataset_missing' });
  }

  if (!labelTargets.includes('control-plane')) {
    errors.push({ code: 'phase36_control_plane_label_missing' });
  }

  if (!labelTargets.includes('writing-plane')) {
    errors.push({ code: 'phase36_writing_plane_label_missing' });
  }

  return {
    ok: errors.length === 0,
    file: filePath,
    checked: rows.length,
    accepted: errors.length === 0 ? rows.length : 0,
    rejected: errors.length === 0 ? 0 : rows.length,
    targetedRecords: newRows.length,
    gate: gateResult,
    coverage: {
      validateDataset: targets.some((target) => target.includes('validate_dataset')),
      controlPlaneLabel: labelTargets.includes('control-plane'),
      writingPlaneLabel: labelTargets.includes('writing-plane'),
    },
    errors,
  };
}

export function main(argv = process.argv.slice(2)) {
  const result = validatePhase36Dataset(argv[0] || DEFAULT_DATASET);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
