#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildCloudGate } from '../cloud-readiness-gate.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';

export const DURABLE_REPLAY_MIGRATION_DRAFT =
  'migrations/drafts/gptoss_durable_replay_store.sql';
export const DURABLE_REPLAY_MIGRATION_GUARD_REPORT =
  'local_artifacts/gptoss-runtime/durable-replay-migration-guard-report.json';

const REQUIRED_MARKERS = [
  'DESIGN DRAFT ONLY',
  'DO NOT APPLY',
];

const RAW_NONCE_COLUMN_PATTERN = /^\s*(nonce|raw_nonce|rawnonce)\s+/im;
const NONCE_HASH_COLUMN_PATTERN = /^\s*nonce_hash\s+CHAR\(64\)\s+NOT\s+NULL\b/im;
const UNIQUE_KEY_NONCE_HASH_PATTERN = /\bunique\s*\(\s*key_id\s*,\s*nonce_hash\s*\)/i;
const RAW_REQUEST_BODY_COLUMN_PATTERN =
  /^\s*(raw_request_body|request_body|raw_body|body)\s+/im;
const SECRET_COLUMN_PATTERN =
  /^\s*[a-z_]*(secret|token|api_key|password|bearer|cookie|signature)[a-z_]*\s+/im;
const DESTRUCTIVE_SQL_PATTERN =
  /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i;
const MIGRATION_EXECUTION_PATTERN =
  /^\s*\\(i|ir|include|connect|c)\b|dblink_connect\s*\(|\bEXECUTE\s+IMMEDIATE\b|\bCALL\s+\w+|\bDO\s+\$\$/im;
const LIVE_DB_CONNECTION_PATTERN = new RegExp(
  [
    'postgres(?:ql)?://',
    'dblink_connect\\s*\\(',
    '^\\s*\\\\(connect|c)\\b',
    `${'DATABASE'}_${'URL'}`,
    'host\\s*=\\S+\\s+dbname\\s*=',
  ].join('|'),
  'im',
);

function pushFailure(failures, code) {
  failures.push(code);
}

function readDraft(path, failures) {
  if (!existsSync(path)) {
    pushFailure(failures, 'migration_draft_missing');
    return '';
  }
  return readFileSync(path, 'utf8');
}

function stripSqlComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function validateMigrationDraft({ migrationPath }) {
  const failures = [];
  const text = readDraft(migrationPath, failures);
  const executableSql = stripSqlComments(text);

  for (const marker of REQUIRED_MARKERS) {
    if (!text.includes(marker)) {
      pushFailure(failures, `migration_marker_missing:${marker}`);
    }
  }

  if (!NONCE_HASH_COLUMN_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_nonce_hash_column_missing');
  }
  if (RAW_NONCE_COLUMN_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_raw_nonce_column_present');
  }
  if (!UNIQUE_KEY_NONCE_HASH_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_unique_key_nonce_hash_missing');
  }
  if (RAW_REQUEST_BODY_COLUMN_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_raw_request_body_column_present');
  }
  if (SECRET_COLUMN_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_secret_storage_column_present');
  }
  if (DESTRUCTIVE_SQL_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_destructive_sql_present');
  }
  if (MIGRATION_EXECUTION_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_execution_statement_present');
  }
  if (LIVE_DB_CONNECTION_PATTERN.test(executableSql)) {
    pushFailure(failures, 'migration_live_db_connection_path_present');
  }

  return failures;
}

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runPrivateServingDurableReplayMigrationGuard({
  migrationPath = DURABLE_REPLAY_MIGRATION_DRAFT,
  output = DURABLE_REPLAY_MIGRATION_GUARD_REPORT,
  write = true,
} = {}) {
  const failures = validateMigrationDraft({ migrationPath });
  const readiness = buildReadinessReport();
  const cloudGate = buildCloudGate({ reportPath: undefined });
  const migrationDraftReady = failures.length === 0;

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_durable_replay_migration_guard',
    ok: migrationDraftReady,
    applyAllowed: false,
    liveDbWrite: false,
    migrationDraftReady,
    durableReplayMigrationApplied: false,
    durableReplayMigrationApplyAllowed: false,
    liveDbUsed: false,
    replayProtectionDurableImplemented: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    futureApprovalRequired: true,
    migrationExecutionCodePresent: false,
    checkedPath: migrationPath,
    failures,
    readiness: {
      durableReplayMigrationDraftReady: readiness.durableReplayMigrationDraftReady,
      durableReplayMigrationApplyAllowed: readiness.durableReplayMigrationApplyAllowed,
      durableReplayMigrationApplied: readiness.durableReplayMigrationApplied,
      replayProtectionDurableImplemented: readiness.replayProtectionDurableImplemented,
      privateServingImplemented: readiness.privateServingImplemented,
      privateServingExposed: readiness.privateServingExposed,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
      liveDbUsed: readiness.liveDbUsed,
    },
    cloudGate: {
      durableReplayMigrationDraftReady: cloudGate.durableReplayMigrationDraftReady,
      durableReplayMigrationApplyAllowed: cloudGate.durableReplayMigrationApplyAllowed,
      durableReplayMigrationApplied: cloudGate.durableReplayMigrationApplied,
      cloudReady: cloudGate.cloudReady,
      customGptReady: cloudGate.customGptReady,
      liveDbUsed: cloudGate.liveDbUsed,
    },
  };

  if (write) {
    writeReport(output, report);
  }
  return report;
}

function parseArgs(argv = []) {
  const options = {
    migrationPath: DURABLE_REPLAY_MIGRATION_DRAFT,
    output: DURABLE_REPLAY_MIGRATION_GUARD_REPORT,
    write: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--migration-draft' && next) {
      options.migrationPath = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--no-write') {
      options.write = false;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

function main() {
  const report = runPrivateServingDurableReplayMigrationGuard(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
