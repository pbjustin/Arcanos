#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateJsonl } from './dataset-gate.mjs';

const DEFAULT_DATASET = 'examples/gptoss/arcanos-railway-safe-routing.jsonl';
const APPROVED_SOURCES = new Set(['arcanos_owned_spec', 'repo_schema', 'human_authored']);
const READONLY_ACTIONS = new Set([
  'railway.whoami',
  'railway.status',
  'railway.logs',
  'railway.variables.list',
  'railway.environment',
  'railway.service',
]);
const PRIVILEGED_ACTIONS = new Set([
  'railway.restart',
  'railway.redeploy',
  'railway.up',
  'railway.variable.set',
  'railway.down',
  'railway.ssh',
  'railway.shell',
  'railway.delete',
  'railway.scale',
]);
const REJECT_ACTIONS = new Set([
  'reject',
  'reject_training_from_raw_logs',
  'reject_unknown_action',
]);
const FORBIDDEN_TEXT = /Input:|Expected:|Analysis:|Reasoning:|\bCOT\b|chain[-\s]?of[-\s]?thought|hidden reasoning|<\|(?:start|end|channel|message|analysis|commentary|final)[^>]*\|>|"channel"\s*:|DATABASE_URL|REDIS_URL|POSTGRES_URL|RAILWAY_TOKEN|RAILWAY_API_TOKEN|OPENAI_API_KEY|Bearer\s+|sk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/|redis:\/\//i;
const RAW_LOG_TEXT = /\bStarting\s+Container\b|\b(?:INFO|WARN|ERROR|DEBUG)\b\s+[-.:/@A-Za-z0-9_ ]{8,}|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b.*\b(?:INFO|WARN|ERROR|DEBUG|Traceback)\b/i;

function parseRows(filePath, errors) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, lineNumber }) => {
      try {
        return { lineNumber, record: JSON.parse(line) };
      } catch {
        errors.push({ line: lineNumber, code: 'invalid_json' });
        return null;
      }
    })
    .filter(Boolean);
}

function assistantTarget(record) {
  return record.messages.find((message) => message.role === 'assistant')?.content || '';
}

function validateRailwayRecord(record, lineNumber, errors) {
  if (!APPROVED_SOURCES.has(record.source)) {
    errors.push({ line: lineNumber, code: 'railway_dataset_source_not_approved', source: record.source ?? null });
  }

  if (record.reviewed !== true) {
    errors.push({ line: lineNumber, code: 'railway_dataset_review_required' });
  }

  if (record.allowed_for_training !== true) {
    errors.push({ line: lineNumber, code: 'railway_dataset_training_flag_required' });
  }

  if (record.task_type !== 'railway_safe_routing') {
    errors.push({ line: lineNumber, code: 'railway_dataset_task_type_required' });
  }

  if (record.metadata?.no_openai_output_used !== true) {
    errors.push({ line: lineNumber, code: 'railway_dataset_no_openai_required' });
  }

  if (record.metadata?.raw_railway_output_used !== false) {
    errors.push({ line: lineNumber, code: 'railway_dataset_raw_output_forbidden' });
  }

  if (record.metadata?.target_shape !== 'json_only') {
    errors.push({ line: lineNumber, code: 'railway_dataset_json_target_required' });
  }

  const serialized = JSON.stringify(record);
  if (FORBIDDEN_TEXT.test(serialized)) {
    errors.push({ line: lineNumber, code: 'railway_dataset_forbidden_text' });
  }

  if (RAW_LOG_TEXT.test(serialized)) {
    errors.push({ line: lineNumber, code: 'railway_dataset_raw_log_marker' });
  }

  const assistantContent = assistantTarget(record);
  let target = null;
  try {
    target = JSON.parse(assistantContent);
  } catch {
    errors.push({ line: lineNumber, code: 'railway_dataset_assistant_json_required' });
    return;
  }

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    errors.push({ line: lineNumber, code: 'railway_dataset_assistant_json_object_required' });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(target, 'channel')) {
    errors.push({ line: lineNumber, code: 'railway_dataset_forbidden_text' });
  }

  if (target.plane !== 'control-plane') {
    errors.push({ line: lineNumber, code: 'railway_dataset_control_plane_required' });
  }

  if (target.allowedForTraining !== false) {
    errors.push({ line: lineNumber, code: 'railway_dataset_target_not_trainable_required' });
  }

  if (READONLY_ACTIONS.has(target.action)) {
    if (target.risk !== 'readonly' || target.requiresConfirmation !== false) {
      errors.push({ line: lineNumber, code: 'railway_dataset_readonly_shape_invalid' });
    }
    return;
  }

  if (PRIVILEGED_ACTIONS.has(target.action)) {
    if (target.risk !== 'privileged' || target.requiresConfirmation !== true || target.blockedByDefault !== true) {
      errors.push({ line: lineNumber, code: 'railway_dataset_privileged_shape_invalid' });
    }
    return;
  }

  if (REJECT_ACTIONS.has(target.action)) {
    if (target.requiresConfirmation !== false) {
      errors.push({ line: lineNumber, code: 'railway_dataset_reject_shape_invalid' });
    }
    return;
  }

  errors.push({ line: lineNumber, code: 'railway_dataset_unknown_target_action', action: target.action ?? null });
}

export function validateRailwaySafeRoutingDataset(filePath = DEFAULT_DATASET) {
  const gateResult = validateJsonl(filePath);
  const errors = [...gateResult.errors];
  const rows = parseRows(filePath, errors);

  for (const row of rows) {
    validateRailwayRecord(row.record, row.lineNumber, errors);
  }

  return {
    ok: errors.length === 0,
    file: filePath,
    checked: rows.length,
    accepted: errors.length === 0 ? rows.length : 0,
    rejected: errors.length === 0 ? 0 : rows.length,
    gate: gateResult,
    errors,
  };
}

export function main(argv = process.argv.slice(2)) {
  const result = validateRailwaySafeRoutingDataset(argv[0] || DEFAULT_DATASET);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
