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

import { buildCloudGate } from '../cloud-readiness-gate.mjs';
import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';
import {
  buildReplayStoreInsertPlan,
  createDurableReplayStoreContract,
} from './private-serving-durable-replay-store.mjs';

export const DURABLE_REPLAY_IMPLEMENTATION_PLAN_DOC =
  'docs/GPTOSS_DURABLE_REPLAY_STORE_IMPLEMENTATION_PLAN.md';
export const DURABLE_REPLAY_MIGRATION_DRAFT =
  'migrations/drafts/gptoss_durable_replay_store.sql';
export const DURABLE_REPLAY_STORE_CONTRACT =
  'scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs';
export const DURABLE_REPLAY_IMPLEMENTATION_PLAN_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-durable-replay-implementation-plan-report.json';

const VALIDATED_ARTIFACTS = [
  DURABLE_REPLAY_IMPLEMENTATION_PLAN_DOC,
  DURABLE_REPLAY_MIGRATION_DRAFT,
  DURABLE_REPLAY_STORE_CONTRACT,
  'scripts/gptoss/private-serving/private-serving-durable-replay-implementation-plan-validate.mjs',
];

const REQUIRED_MIGRATION_MARKERS = [
  'DESIGN DRAFT ONLY',
  'DO NOT APPLY',
  'NO LIVE DB EXECUTION',
];

const REQUIRED_MIGRATION_COLUMNS = [
  'id',
  'key_id',
  'nonce_hash',
  'request_id',
  'body_hash',
  'first_seen_at',
  'expires_at',
  'replay_window_seconds',
  'audience',
  'subject',
  'source',
  'created_at',
];

const FORBIDDEN_PATTERNS = [
  [
    'db_client_import',
    /from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i,
  ],
  [
    'db_url_env',
    new RegExp(`${'DATABASE'}_${'URL'}|process\\.env\\[['"]?${'DATABASE'}_${'URL'}`, 'i'),
  ],
  [
    'railway_command',
    new RegExp(`${'rail'}${'way'}\\s+(up|status|logs|link|whoami|run|deploy|variables)`, 'i'),
  ],
  [
    'server_listener',
    new RegExp(`${'node:'}${'http'}|${'node:'}${'https'}|${'node:'}${'net'}|${'create'}${'Server'}|\\.${'listen'}\\s*\\(`, 'i'),
  ],
  ['openai_call', /api\.openai\.com|responses\.create/i],
  [
    'training_command',
    new RegExp(`npm\\s+run\\s+[^\\r\\n]*${'train'}|${'fine'}-${'tune'}|${'fine'}${'tune'}`, 'i'),
  ],
  ['vllm_command', new RegExp(`${'v'}${'llm'}\\s+${'serve'}|${'v'}${'llm'}\\.`,'i')],
];

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}:${detail}` : code);
}

function readText(path, failures) {
  if (!existsSync(path)) {
    pushFailure(failures, 'missing_file', path);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function readJson(path, failures) {
  const text = readText(path, failures);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    pushFailure(
      failures,
      'invalid_json',
      `${path}:${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function stripSqlComments(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

function validateImplementationPlanDoc(failures) {
  const text = readText(DURABLE_REPLAY_IMPLEMENTATION_PLAN_DOC, failures);
  for (const term of [
    'migrations/drafts/gptoss_durable_replay_store.sql',
    'scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs',
    'unique(key_id, nonce_hash)',
    'replayProtectionDurableImplemented": false',
    'cloudReady": false',
    'customGptReady": false',
  ]) {
    if (!text.includes(term)) {
      pushFailure(failures, 'implementation_plan_term_missing', term);
    }
  }
  return Boolean(text);
}

function validateMigrationDraft(failures) {
  const text = readText(DURABLE_REPLAY_MIGRATION_DRAFT, failures);
  const executableSql = stripSqlComments(text);
  for (const marker of REQUIRED_MIGRATION_MARKERS) {
    if (!text.includes(marker)) {
      pushFailure(failures, 'migration_marker_missing', marker);
    }
  }
  for (const column of REQUIRED_MIGRATION_COLUMNS) {
    if (!new RegExp(`\\b${column}\\b`, 'i').test(executableSql)) {
      pushFailure(failures, 'migration_column_missing', column);
    }
  }
  if (!/\bnonce_hash\b/i.test(executableSql)) {
    pushFailure(failures, 'migration_nonce_hash_missing');
  }
  if (/^\s*(nonce|raw_nonce)\s+/im.test(executableSql)) {
    pushFailure(failures, 'migration_raw_nonce_column_present');
  }
  if (!/unique\s*\(\s*key_id\s*,\s*nonce_hash\s*\)/i.test(executableSql)) {
    pushFailure(failures, 'migration_unique_key_nonce_hash_missing');
  }
  if (/raw_request_body|request_body|secret|password|bearer_token/i.test(executableSql)) {
    pushFailure(failures, 'migration_forbidden_storage_column_present');
  }
  return Boolean(text);
}

function validateNoForbiddenPatterns(failures) {
  for (const path of VALIDATED_ARTIFACTS) {
    const text = readText(path, failures);
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) {
        pushFailure(failures, 'forbidden_implementation_plan_pattern', `${label}:${path}`);
      }
    }
  }
}

function validateContract(failures) {
  const contract = createDurableReplayStoreContract();
  const plan = buildReplayStoreInsertPlan({
    keyId: 'phase56-key',
    nonce: 'noncePhase56Replay',
    requestId: 'phase56-request',
    bodyHash: 'a'.repeat(64),
    timestamp: '2026-06-11T12:00:00.000Z',
    audience: 'gptoss-effective-router-private',
    subject: 'phase56-subject',
  });
  const serializedPlan = JSON.stringify(plan);

  if (contract.implemented !== false || contract.executesSql !== false) {
    pushFailure(failures, 'contract_not_design_only');
  }
  if (!Array.isArray(contract.uniqueConstraint) ||
      contract.uniqueConstraint.join('+') !== 'key_id+nonce_hash') {
    pushFailure(failures, 'contract_unique_constraint_missing');
  }
  if (serializedPlan.includes('noncePhase56Replay') || /"nonce"\s*:/.test(serializedPlan)) {
    pushFailure(failures, 'contract_insert_plan_raw_nonce_present');
  }
  if (plan.record?.nonce_hash?.length !== 64) {
    pushFailure(failures, 'contract_insert_plan_nonce_hash_missing');
  }
  return { contract, plan };
}

function validatePackageScript(failures) {
  const packageJson = readJson('package.json', failures);
  const command = packageJson?.scripts?.[
    'gptoss:private-serving:durable-replay:implementation-plan:validate'
  ];
  if (
    command !==
    'node scripts/gptoss/private-serving/private-serving-durable-replay-implementation-plan-validate.mjs'
  ) {
    pushFailure(failures, 'package_script_missing_or_unexpected');
  }
}

function validateReadiness(failures) {
  const readiness = buildReadinessReport();
  const expected = {
    replayProtectionDurableDesigned: true,
    replayProtectionDurableImplemented: false,
    replayProtectionDurable: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    publicServerCreated: false,
    cloudReady: false,
    customGptReady: false,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (readiness[field] !== expectedValue) {
      pushFailure(failures, 'readiness_field_unexpected', `${field}=${readiness[field]}`);
    }
  }
  const cloudGate = buildCloudGate({ reportPath: undefined });
  if (cloudGate.cloudReady !== false) pushFailure(failures, 'cloud_gate_cloud_ready_not_false');
  if (cloudGate.customGptReady !== false) pushFailure(failures, 'cloud_gate_custom_gpt_ready_not_false');
  if (cloudGate.customGptDirectLocalExposureAllowed !== false) {
    pushFailure(failures, 'cloud_gate_custom_gpt_exposure_not_false');
  }
  return { readiness, cloudGate };
}

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runPrivateServingDurableReplayImplementationPlanValidation({
  output = DURABLE_REPLAY_IMPLEMENTATION_PLAN_REPORT,
  write = true,
} = {}) {
  const failures = [];
  const implementationPlanExists = validateImplementationPlanDoc(failures);
  const migrationDraftExists = validateMigrationDraft(failures);
  validateNoForbiddenPatterns(failures);
  const { contract, plan } = validateContract(failures);
  validatePackageScript(failures);
  const { readiness, cloudGate } = validateReadiness(failures);

  const noDbClientImports = !failures.some((failure) => failure.includes('db_client_import'));
  const noDatabaseUrlUsage = !failures.some((failure) => failure.includes('db_url_env'));
  const noRailwayCliUsage = !failures.some((failure) => failure.includes('railway_command'));
  const noServerListener = !failures.some((failure) => failure.includes('server_listener'));
  const noRawNonceStorage = !failures.some((failure) =>
    failure.includes('raw_nonce') || failure.includes('contract_insert_plan_raw_nonce_present'),
  );
  const noOpenAiTrainingVllmPaths = !failures.some((failure) =>
    failure.includes('openai_call') ||
    failure.includes('training_command') ||
    failure.includes('vllm_command'),
  );

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_durable_replay_implementation_plan_validation',
    ok: failures.length === 0,
    implementationPlanExists,
    migrationDraftExists,
    migrationDraftDesignOnly: migrationDraftExists && !failures.some((failure) =>
      failure.startsWith('migration_marker_missing'),
    ),
    durableReplayStoreContractExists: existsSync(DURABLE_REPLAY_STORE_CONTRACT),
    replayProtectionDurableDesigned: readiness.replayProtectionDurableDesigned === true,
    replayProtectionDurableImplemented: false,
    replayProtectionDurable: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    publicServerCreated: false,
    cloudReady: false,
    customGptReady: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    serverCreated: false,
    noOpenAiOutputUsed: true,
    noDbClientImports,
    noDatabaseUrlUsage,
    noRailwayCliUsage,
    noServerListener,
    noRawNonceStorage,
    noOpenAiTrainingVllmPaths,
    uniqueKeyIdNonceHashPresent: !failures.some((failure) =>
      failure.startsWith('migration_unique_key_nonce_hash_missing') ||
      failure.startsWith('contract_unique_constraint_missing'),
    ),
    failures,
    checkedPaths: VALIDATED_ARTIFACTS,
    contractSummary: {
      table: contract.table,
      uniqueConstraint: contract.uniqueConstraint,
      executesSql: contract.executesSql,
      liveDbUsed: contract.liveDbUsed,
    },
    insertPlanPreview: {
      table: plan.table,
      conflictTarget: plan.conflictTarget,
      rawNonceStored: plan.rawNonceStored,
      executesSql: plan.executesSql,
      recordKeys: Object.keys(plan.record || {}).sort(),
    },
    readiness: {
      replayProtectionDurableDesigned: readiness.replayProtectionDurableDesigned,
      replayProtectionDurableImplemented: readiness.replayProtectionDurableImplemented,
      replayProtectionDurable: readiness.replayProtectionDurable,
      privateServingImplemented: readiness.privateServingImplemented,
      privateServingExposed: readiness.privateServingExposed,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
    },
    cloudGate: {
      cloudReady: cloudGate.cloudReady,
      customGptReady: cloudGate.customGptReady,
      customGptDirectLocalExposureAllowed: cloudGate.customGptDirectLocalExposureAllowed,
      blockers: cloudGate.blockers,
    },
  };

  if (write) {
    writeReport(output, report);
  }
  return report;
}

function parseArgs(argv = []) {
  const options = {
    output: DURABLE_REPLAY_IMPLEMENTATION_PLAN_REPORT,
    write: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--output' && next) {
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
  const report = runPrivateServingDurableReplayImplementationPlanValidation(
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
