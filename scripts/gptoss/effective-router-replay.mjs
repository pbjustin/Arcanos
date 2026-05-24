#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  CLEAN_SAFETY_FLAGS,
  DEFAULT_ADAPTER_DIR,
  REQUIRED_RUNTIME_SUPPORTS,
  RUNTIME_REPORT_DIR,
  assertRuntimeReportPath,
  normalizeRuntimeRequest,
} from './effective-router-runtime.mjs';
import { readAuditRecord } from './effective-router-audit-log.mjs';
import { runRequest } from './effective-router-request.mjs';

export const DEFAULT_REPLAY_DIR = join(RUNTIME_REPORT_DIR, 'replay');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function defaultReplayPath(prefix = 'replay') {
  return join(DEFAULT_REPLAY_DIR, `${prefix}-${stamp()}.json`);
}

function toDisplayPath(path) {
  return String(path).replace(/\\/g, '/');
}

function writeJson(path, value) {
  assertRuntimeReportPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validateAuditRuntimeSupports(record) {
  for (const [name, expected] of Object.entries(REQUIRED_RUNTIME_SUPPORTS)) {
    if (record?.runtimeSupports?.[name] !== expected) {
      throw new Error(`audit_missing_runtime_support:${name}`);
    }
  }
}

export function requestFromAudit(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('audit_record_required');
  }
  if (!record.inputPreview) {
    throw new Error('audit_replay_input_unavailable');
  }
  validateAuditRuntimeSupports(record);
  return normalizeRuntimeRequest({
    requestId: `replay-${record.requestId || 'request'}`,
    userInput: record.inputPreview,
    mode: 'router_classifier',
    adapterDir: record.adapterDir || DEFAULT_ADAPTER_DIR,
    runtimeSupports: record.runtimeSupports,
  });
}

export function runReplay({
  audit,
  output = defaultReplayPath(),
  execute = false,
  executeLocalModel = false,
} = {}) {
  if (!audit) {
    throw new Error('audit_file_required');
  }
  if (execute && !executeLocalModel) {
    throw new Error('execute_local_model_flag_required');
  }
  const auditRecord = readAuditRecord(audit);
  const request = requestFromAudit(auditRecord);
  const requestReportPath = defaultReplayPath('request');
  const response = runRequest({
    request,
    output: requestReportPath,
    execute,
    executeLocalModel,
    audit: false,
  });
  const report = {
    ok: response.ok === true,
    mode: 'request_replay',
    audit: toDisplayPath(audit),
    requestReport: toDisplayPath(requestReportPath),
    dryRun: !execute,
    executeRequested: execute,
    modelLoaded: response.modelLoaded === true,
    request,
    response,
    safety: response.safety || CLEAN_SAFETY_FLAGS,
    readiness: response.readiness,
  };
  writeJson(output, report);
  return report;
}

function parseArgs(argv = []) {
  const options = {
    audit: undefined,
    output: undefined,
    execute: false,
    executeLocalModel: false,
    dryRun: true,
    dryRunExplicit: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--audit' && next) {
      options.audit = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--dry-run') {
      options.dryRun = true;
      options.dryRunExplicit = true;
    } else if (flag === '--execute') {
      options.execute = true;
      options.dryRun = false;
    } else if (flag === '--execute-local-model') {
      options.executeLocalModel = true;
      if (!options.dryRunExplicit) {
        options.execute = true;
        options.dryRun = false;
      }
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  if (options.dryRun) {
    options.execute = false;
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runReplay({
    audit: options.audit,
    output: options.output,
    execute: options.execute,
    executeLocalModel: options.executeLocalModel,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      safety: CLEAN_SAFETY_FLAGS,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
