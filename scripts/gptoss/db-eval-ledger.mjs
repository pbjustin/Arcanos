#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { redactString, redactValue } from './railway-redaction.mjs';

const DEFAULT_OUTPUT_DIR = 'local_artifacts/gptoss-db-ledger';

function parseArgs(argv) {
  const options = {
    report: undefined,
    adapterName: undefined,
    datasetPath: undefined,
    evalFile: undefined,
    outputDir: DEFAULT_OUTPUT_DIR,
    execute: false,
    allowDbWrite: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--report' && next) {
      options.report = next;
      index += 1;
    } else if (flag === '--adapter-name' && next) {
      options.adapterName = next;
      index += 1;
    } else if (flag === '--dataset-path' && next) {
      options.datasetPath = next;
      index += 1;
    } else if (flag === '--eval-file' && next) {
      options.evalFile = next;
      index += 1;
    } else if (flag === '--output-dir' && next) {
      options.outputDir = next;
      index += 1;
    } else if (flag === '--execute') {
      options.execute = true;
    } else if (flag === '--allow-db-write') {
      options.allowDbWrite = true;
    }
  }

  return options;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readEvalRecords(path) {
  if (!path || !existsSync(path)) {
    return new Map();
  }
  const rows = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return new Map(rows.map((row) => [row.id, row]));
}

function summarize(value, max = 240) {
  const text = redactString(String(value ?? '').replace(/\s+/g, ' ').trim());
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function expectedShape(expected = {}) {
  if (expected.json_object) {
    return 'json_only';
  }
  if (expected.plane || expected.must_include?.some((token) => String(token).includes('-plane'))) {
    return 'label_or_route';
  }
  return 'compact_final';
}

function expectedAction(expected = {}) {
  return expected.action || expected.required_action || expected.must_include?.find((token) => String(token).includes('_') || String(token).includes('.')) || null;
}

function expectedLabel(expected = {}) {
  return expected.plane || expected.must_include?.find((token) => ['control-plane', 'writing-plane'].includes(token)) || null;
}

function classifyFailure(failure) {
  const reasons = [];
  const expected = failure.expected || {};
  const finalText = String(failure.finalText || failure.assembledFinalText || '');

  if (failure.validJson === false || failure.jsonParseError) {
    reasons.push('invalid_json');
  }

  for (const token of expected.must_include || []) {
    if (!finalText.includes(token)) {
      reasons.push(`missing:${token}`);
    }
  }

  for (const token of expected.must_not_include || []) {
    if (finalText.includes(token)) {
      reasons.push(`forbidden:${token}`);
    }
  }

  const action = expectedAction(expected);
  if (action && !finalText.includes(action)) {
    reasons.push(`wrong_or_missing_action:${action}`);
  }

  const label = expectedLabel(expected);
  if (label && !finalText.includes(label)) {
    reasons.push(`route_label_missing:${label}`);
  }

  return reasons.length ? reasons : ['eval_failed'];
}

function defaultReport() {
  return {
    adapterDir: 'local_artifacts/gptoss-db-ledger-dry-run-adapter',
    evalFile: 'examples/gptoss/arcanos-eval-smoke.jsonl',
    passed: 0,
    failed: 0,
    failures: [],
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
  };
}

export function buildEvalLedger(report, options = {}) {
  const evalFile = options.evalFile || report.evalFile || '';
  const evalRecords = readEvalRecords(evalFile);
  const adapterPath = report.adapterDir || '';
  const adapterName = options.adapterName || (adapterPath ? basename(adapterPath) : 'unknown-adapter');
  const runId = report.runId || `gptoss-eval-${adapterName}-${randomUUID()}`;
  const failures = Array.isArray(report.failures)
    ? report.failures
    : Object.values(report.results || {}).filter((result) => result?.passed === false);

  const run = {
    run_id: runId,
    adapter_name: adapterName,
    adapter_path: adapterPath,
    dataset_path: options.datasetPath || report.datasetPath || '',
    eval_file: evalFile,
    force_final_channel: report.forceFinalChannel === true || report.diagnosticModes?.forceFinalChannel === true,
    passed_count: Number.isInteger(report.passed) ? report.passed : 0,
    failed_count: Number.isInteger(report.failed) ? report.failed : failures.length,
    openai_called: report.openAiCalled === true,
    training_executed: report.trainingExecuted === true,
    vllm_used: report.vllmUsed === true,
    no_openai_output_used: report.noOpenAiOutputUsed !== false,
    report_path: options.report || '',
  };

  const failureRecords = failures.map((failure) => {
    const evalRecord = evalRecords.get(failure.id) || {};
    const reasons = classifyFailure(failure);
    return {
      run_id: runId,
      eval_id: failure.id || 'unknown-eval-id',
      prompt_summary: summarize(evalRecord.prompt || failure.prompt || ''),
      expected_shape: expectedShape(failure.expected || evalRecord.expected || {}),
      expected_action: expectedAction(failure.expected || evalRecord.expected || {}),
      expected_label: expectedLabel(failure.expected || evalRecord.expected || {}),
      observed_summary: summarize(failure.finalText || failure.assembledFinalText || failure.rawGeneratedTextSummary || ''),
      failure_reasons: reasons,
      suggested_repair_target: reasons.find((reason) => reason.startsWith('missing:'))?.slice('missing:'.length) || null,
      redacted: true,
    };
  });

  return redactValue({
    run,
    failures: failureRecords,
    trainingExamplesCreated: 0,
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliExecuted: false,
  });
}

async function insertLedger(ledger) {
  if (typeof process.env.DATABASE_URL !== 'string' || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error('required_db_connection_env_missing');
  }
  const { Pool } = await import('pg');
  const pool = new Pool();
  try {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO gptoss_eval_runs (
        run_id,
        adapter_name,
        adapter_path,
        dataset_path,
        eval_file,
        force_final_channel,
        passed_count,
        failed_count,
        openai_called,
        training_executed,
        vllm_used,
        no_openai_output_used,
        report_path
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (run_id) DO UPDATE SET
        adapter_name = EXCLUDED.adapter_name,
        adapter_path = EXCLUDED.adapter_path,
        dataset_path = EXCLUDED.dataset_path,
        eval_file = EXCLUDED.eval_file,
        force_final_channel = EXCLUDED.force_final_channel,
        passed_count = EXCLUDED.passed_count,
        failed_count = EXCLUDED.failed_count,
        openai_called = EXCLUDED.openai_called,
        training_executed = EXCLUDED.training_executed,
        vllm_used = EXCLUDED.vllm_used,
        no_openai_output_used = EXCLUDED.no_openai_output_used,
        report_path = EXCLUDED.report_path`,
      [
        ledger.run.run_id,
        ledger.run.adapter_name,
        ledger.run.adapter_path,
        ledger.run.dataset_path,
        ledger.run.eval_file,
        ledger.run.force_final_channel,
        ledger.run.passed_count,
        ledger.run.failed_count,
        ledger.run.openai_called,
        ledger.run.training_executed,
        ledger.run.vllm_used,
        ledger.run.no_openai_output_used,
        ledger.run.report_path,
      ],
    );
    for (const failure of ledger.failures) {
      await pool.query(
        `INSERT INTO gptoss_eval_failures (
          run_id,
          eval_id,
          prompt_summary,
          expected_shape,
          expected_action,
          expected_label,
          observed_summary,
          failure_reasons,
          suggested_repair_target,
          redacted
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          failure.run_id,
          failure.eval_id,
          failure.prompt_summary,
          failure.expected_shape,
          failure.expected_action,
          failure.expected_label,
          failure.observed_summary,
          JSON.stringify(failure.failure_reasons),
          failure.suggested_repair_target,
          failure.redacted,
        ],
      );
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  } finally {
    await pool.end();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = options.report ? readJsonFile(options.report) : defaultReport();
  const ledger = buildEvalLedger(report, options);
  const result = {
    ok: true,
    dryRun: !options.execute,
    executeRequested: options.execute,
    dbInsertPlanned: options.execute && options.allowDbWrite,
    ledger,
    liveDbWrite: false,
    reportOutputPath: join(options.outputDir, 'eval-ledger-dry-run.json'),
  };

  if (options.execute && !options.allowDbWrite) {
    result.ok = false;
    result.error = 'db_write_requires_explicit_allow_flag';
  } else if (result.dbInsertPlanned) {
    await insertLedger(ledger);
    result.liveDbWrite = true;
  } else {
    mkdirSync(dirname(result.reportOutputPath), { recursive: true });
    writeFileSync(result.reportOutputPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(redactValue(result), null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'eval_ledger_failed',
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
