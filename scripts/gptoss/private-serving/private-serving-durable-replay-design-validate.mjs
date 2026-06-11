#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildCloudGate } from '../cloud-readiness-gate.mjs';
import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';

export const DURABLE_REPLAY_DESIGN_DOC = 'docs/GPTOSS_DURABLE_REPLAY_STORE_DESIGN.md';
export const PRIVATE_SERVING_SCHEMA = 'schemas/gptoss-private-serving-boundary.schema.json';
export const DURABLE_REPLAY_DESIGN_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-durable-replay-design-report.json';

const VALIDATED_ARTIFACTS = [
  DURABLE_REPLAY_DESIGN_DOC,
  PRIVATE_SERVING_SCHEMA,
  'scripts/gptoss/private-serving/private-serving-durable-replay-design-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-replay-protection.mjs',
  'scripts/gptoss/private-serving/private-serving-replay-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-auth.mjs',
  'scripts/gptoss/private-serving/private-serving-auth-validate.mjs',
];

const REQUIRED_DOC_TERMS = [
  'purpose',
  'keyId + nonce',
  'timestamp window',
  'TTL',
  'pruning',
  'audit correlation',
  'failure modes',
  'migration safety',
  'rollback behavior',
  'raw request body',
  'secret storage',
  'live DB access',
  'design/schema/validation only',
];

const FORBIDDEN_SOURCE_PATTERNS = [
  [
    'live_db_client',
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

function validateDoc(failures) {
  const text = readText(DURABLE_REPLAY_DESIGN_DOC, failures);
  const lower = text.toLowerCase();
  for (const term of REQUIRED_DOC_TERMS) {
    if (!lower.includes(term.toLowerCase())) {
      pushFailure(failures, 'durable_replay_doc_term_missing', term);
    }
  }
  for (const term of [
    'rawRequestBodyStored',
    'secretsStored',
    'replayProtectionDurableDesigned:true',
    'replayProtectionDurableImplemented:false',
    'replayProtectionDurable:false',
  ]) {
    if (!text.includes(term)) {
      pushFailure(failures, 'durable_replay_doc_marker_missing', term);
    }
  }
  return Boolean(text);
}

function validateSchema(failures) {
  const schema = readJson(PRIVATE_SERVING_SCHEMA, failures);
  const defs = schema?.$defs ?? {};
  for (const name of [
    'durableReplayStoreDesign',
    'durableReplayStoreRecord',
    'durableReplayStorePolicy',
    'durableReplayStoreValidationReport',
  ]) {
    if (!defs[name]) {
      pushFailure(failures, 'durable_replay_schema_def_missing', name);
    }
  }
  const readiness = defs.readinessFlags;
  if (readiness?.properties?.replayProtectionDurableDesigned?.const !== true) {
    pushFailure(failures, 'readiness_replay_durable_design_not_true');
  }
  if (readiness?.properties?.replayProtectionDurableImplemented?.const !== false) {
    pushFailure(failures, 'readiness_replay_durable_implemented_not_false');
  }
  if (readiness?.properties?.replayProtectionDurable?.const !== false) {
    pushFailure(failures, 'readiness_replay_durable_not_false');
  }
  const policy = defs.durableReplayStorePolicy;
  if (policy?.properties?.uniquenessRule?.const !== 'keyId+nonce') {
    pushFailure(failures, 'durable_replay_policy_uniqueness_missing');
  }
  if (policy?.properties?.liveDbAccessInPhase?.const !== false) {
    pushFailure(failures, 'durable_replay_policy_live_db_not_false');
  }
  return Boolean(schema);
}

function validateNoForbiddenSource(failures) {
  for (const path of VALIDATED_ARTIFACTS) {
    const text = readText(path, failures);
    for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.test(text)) {
        pushFailure(failures, 'forbidden_durable_replay_pattern', `${label}:${path}`);
      }
    }
  }
}

function listSqlFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith('.sql'))
    .sort();
}

function validateMigrations(failures) {
  const replaySqlPattern = /gptoss.*(replay|nonce)|durable.*replay|replay.*nonce/i;
  const designOnlyPattern = /design[- ]only|not for execution|do not apply/i;
  const matching = [];
  for (const path of listSqlFiles('migrations')) {
    const text = readFileSync(path, 'utf8');
    if (!replaySqlPattern.test(text) && !replaySqlPattern.test(path)) {
      continue;
    }
    matching.push(path);
    if (!designOnlyPattern.test(text)) {
      pushFailure(failures, 'durable_replay_sql_migration_not_design_only', path);
    }
  }
  return matching;
}

function validatePackageScript(failures) {
  const packageJson = readJson('package.json', failures);
  const command = packageJson?.scripts?.['gptoss:private-serving:durable-replay:design:validate'];
  if (command !== 'node scripts/gptoss/private-serving/private-serving-durable-replay-design-validate.mjs') {
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

export function runPrivateServingDurableReplayDesignValidation({
  output = DURABLE_REPLAY_DESIGN_REPORT,
  write = true,
} = {}) {
  const failures = [];
  const docsParsed = validateDoc(failures);
  const schemaParsed = validateSchema(failures);
  validateNoForbiddenSource(failures);
  const matchingReplayMigrations = validateMigrations(failures);
  validatePackageScript(failures);
  const { readiness, cloudGate } = validateReadiness(failures);

  const noLiveDbCode = !failures.some((failure) =>
    failure.includes('live_db_client') || failure.includes('durable_replay_policy_live_db_not_false'),
  );
  const noDatabaseUrlUsage = !failures.some((failure) => failure.includes('db_url_env'));
  const noRailwayCliUsage = !failures.some((failure) => failure.includes('railway_command'));
  const noServerListener = !failures.some((failure) => failure.includes('server_listener'));
  const noSqlMigrationAdded = matchingReplayMigrations.length === 0;
  const sqlMigrationDesignOnly = matchingReplayMigrations.length > 0 && !failures.some((failure) =>
    failure.startsWith('durable_replay_sql_migration_not_design_only'),
  );

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_durable_replay_store_design_validation',
    ok: failures.length === 0,
    durableReplayStoreDesigned: true,
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
    docsParsed,
    schemaParsed,
    noLiveDbCode,
    noSqlMigrationAdded,
    sqlMigrationDesignOnly,
    noDatabaseUrlUsage,
    noRailwayCliUsage,
    noServerListener,
    failures,
    checkedPaths: VALIDATED_ARTIFACTS,
    matchingReplayMigrations,
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
    output: DURABLE_REPLAY_DESIGN_REPORT,
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
  const report = runPrivateServingDurableReplayDesignValidation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

