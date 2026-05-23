#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { evaluateApprovedTrainingExample } from './db-governance-policy.mjs';
import { validateRecord } from './dataset-gate.mjs';
import { redactString, redactValue } from './railway-redaction.mjs';

const DEFAULT_OUTPUT = 'local_artifacts/gptoss-db-export/approved-training.jsonl';

function parseArgs(argv) {
  const options = {
    execute: false,
    allowDbRead: false,
    input: undefined,
    output: DEFAULT_OUTPUT,
    limit: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--input' && next) {
      options.input = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--limit' && next) {
      options.limit = Number.parseInt(next, 10) || 0;
      index += 1;
    } else if (flag === '--execute') {
      options.execute = true;
    } else if (flag === '--allow-db-read') {
      options.allowDbRead = true;
    }
  }

  return options;
}

function normalizeMessages(messages) {
  return typeof messages === 'string' ? JSON.parse(messages) : messages;
}

export function normalizeApprovedRow(row) {
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : { ...(row.metadata || {}) };
  return {
    id: row.example_id || row.id,
    source: row.source,
    reviewed: row.reviewed,
    redacted: row.redacted,
    consent: row.consent ?? metadata.consent,
    allowed_for_training: row.allowed_for_training,
    task_type: row.task_type,
    messages: normalizeMessages(row.messages),
    metadata: {
      ...metadata,
      target_shape: row.target_shape || metadata.target_shape,
      no_openai_output_used: row.no_openai_output_used ?? metadata.no_openai_output_used,
    },
  };
}

function readInputRows(path) {
  if (!path) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed.rows)) {
    return parsed.rows;
  }
  return [parsed];
}

async function readDbRows(limit) {
  if (typeof process.env.DATABASE_URL !== 'string' || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error('required_db_connection_env_missing');
  }
  const { Pool } = await import('pg');
  const pool = new Pool();
  try {
    const result = await pool.query(
      `SELECT
        example_id,
        source,
        reviewed,
        redacted,
        allowed_for_training,
        no_openai_output_used,
        target_shape,
        task_type,
        messages,
        metadata
      FROM gptoss_approved_training_examples
      WHERE reviewed IS TRUE
        AND redacted IS TRUE
        AND allowed_for_training IS TRUE
        AND no_openai_output_used IS TRUE
        AND source IN ('arcanos_owned_spec','repo_schema','human_authored','redacted_consented_log')
      ORDER BY approved_at ASC
      ${limit > 0 ? 'LIMIT $1' : ''}`,
      limit > 0 ? [limit] : [],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

function validateExportRecord(record, index) {
  const errors = [];
  const rawLine = JSON.stringify(record);
  const policy = evaluateApprovedTrainingExample(record);
  validateRecord(record, rawLine, index + 1, errors);
  return {
    ok: policy.ok && errors.length === 0,
    policy,
    errors,
  };
}

export async function buildApprovedExport(argv = []) {
  const options = parseArgs(argv);
  let rawRows = readInputRows(options.input);
  let liveDbRead = false;

  if (rawRows.length === 0 && options.execute && options.allowDbRead) {
    rawRows = await readDbRows(options.limit);
    liveDbRead = true;
  }

  const limitedRows = options.limit > 0 ? rawRows.slice(0, options.limit) : rawRows;
  const records = limitedRows.map((row) => redactValue(normalizeApprovedRow(row)));
  const validations = records.map(validateExportRecord);
  const exportable = records.filter((_, index) => validations[index].ok);
  const rejected = records.length - exportable.length;

  return {
    ok: rejected === 0,
    dryRun: !options.execute,
    output: options.output,
    checked: records.length,
    exportable: exportable.length,
    rejected,
    records: exportable,
    validations,
    liveDbRead,
    liveDbWrite: false,
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliExecuted: false,
    options,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await buildApprovedExport(argv);
  if (result.options.execute && result.ok) {
    mkdirSync(dirname(result.output), { recursive: true });
    writeFileSync(result.output, result.records.map((record) => JSON.stringify(record)).join('\n') + (result.records.length ? '\n' : ''), 'utf8');
    result.liveDbWrite = false;
    result.wroteFile = true;
  } else {
    result.wroteFile = false;
  }

  const output = redactValue({
    ...result,
    options: undefined,
    records: undefined,
  });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = output.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'approved_export_failed',
      message: redactString(error instanceof Error ? error.message : String(error)),
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
      liveDbWrite: false,
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
