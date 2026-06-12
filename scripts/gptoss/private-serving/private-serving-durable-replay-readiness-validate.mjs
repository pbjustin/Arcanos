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
import { runPrivateServingDurableReplayMigrationGuard } from './private-serving-durable-replay-migration-guard.mjs';

export const DURABLE_REPLAY_IMPLEMENTATION_READINESS_DOC =
  'docs/GPTOSS_DURABLE_REPLAY_IMPLEMENTATION_READINESS.md';
export const DURABLE_REPLAY_SECURITY_REVIEW_DOC =
  'docs/GPTOSS_DURABLE_REPLAY_SECURITY_REVIEW.md';
export const DURABLE_REPLAY_ROLLBACK_PLAN_DOC =
  'docs/GPTOSS_DURABLE_REPLAY_ROLLBACK_PLAN.md';
export const DURABLE_REPLAY_READINESS_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-durable-replay-readiness-report.json';

const REQUIRED_DOCS = [
  'docs/GPTOSS_DURABLE_REPLAY_STORE_DESIGN.md',
  'docs/GPTOSS_DURABLE_REPLAY_STORE_IMPLEMENTATION_PLAN.md',
  DURABLE_REPLAY_IMPLEMENTATION_READINESS_DOC,
  DURABLE_REPLAY_SECURITY_REVIEW_DOC,
  DURABLE_REPLAY_ROLLBACK_PLAN_DOC,
];

const REQUIRED_DOC_TERMS = {
  [DURABLE_REPLAY_IMPLEMENTATION_READINESS_DOC]: [
    'PostgreSQL',
    'Alternatives considered',
    'Durability Requirements',
    'Retention Requirements',
    'Replay Window Requirements',
    'Audit Requirements',
    'Implementation Blockers',
    'Key Rotation Review',
  ],
  [DURABLE_REPLAY_SECURITY_REVIEW_DOC]: [
    'no raw nonce storage',
    'no raw body storage',
    'no secret storage',
    'no signature storage',
    'no OpenAI contamination',
    'no training data ingestion',
    'no DB access in current phase',
    'no endpoint exposure',
    'no Custom GPT access',
  ],
  [DURABLE_REPLAY_ROLLBACK_PLAN_DOC]: [
    'Migration Rollback Strategy',
    'Feature Disable Strategy',
    'Replay Fallback Behavior',
    'Audit Preservation',
    'Incident Recovery Checklist',
    'Fail-Closed Requirements',
    'No executable rollback code',
  ],
};

const REQUIRED_SCRIPTS = [
  'scripts/gptoss/private-serving/private-serving-durable-replay-migration-guard.mjs',
  'scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs',
];

const FORBIDDEN_IMPLEMENTATION_PATTERNS = [
  [
    'db_client_import',
    new RegExp([
      'from\\s+[\'"](@prisma/client|pg|knex|redis)[\'"]',
      'new\\s+PrismaClient',
      'new\\s+Pool',
      `${'create'}${'Client'}\\s*\\(`,
    ].join('|'), 'i'),
  ],
  [
    'db_env_lookup',
    new RegExp(`${'DATABASE'}_${'URL'}|process\\.env\\[['"]?${'DATABASE'}_${'URL'}`, 'i'),
  ],
  [
    'server_listener',
    new RegExp([
      `${'node'}:${'http'}`,
      `${'node'}:${'https'}`,
      `${'node'}:${'net'}`,
      `${'create'}${'Server'}`,
      `\\.${'listen'}\\s*\\(`,
    ].join('|'), 'i'),
  ],
  [
    'migration_apply_path',
    new RegExp(
      `${'--'}${'execute'}|${'--'}${'allow'}-${'db'}-${'write'}|` +
        `${'db'}:${'schema'}:${'apply'}|${'migrate'}\\s+${'deploy'}`,
      'i',
    ),
  ],
  [
    'railway_cli',
    new RegExp(`${'rail'}${'way'}\\s+(up|status|logs|link|whoami|run|deploy|variables)`, 'i'),
  ],
  ['openai_call', new RegExp(`${'api'}.${'openai'}.com|responses\\.create`, 'i')],
  [
    'training_path',
    new RegExp(`npm\\s+run\\s+[^\\r\\n]*${'train'}|${'fine'}-${'tune'}|${'fine'}${'tune'}`, 'i'),
  ],
  ['vllm_path', new RegExp(`${'v'}${'llm'}\\s+${'serve'}|${'v'}${'llm'}\\.`, 'i')],
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

function validateDocs(failures) {
  const docPresence = {};
  for (const path of REQUIRED_DOCS) {
    const text = readText(path, failures);
    docPresence[path] = Boolean(text);
    for (const term of REQUIRED_DOC_TERMS[path] || []) {
      if (!text.toLowerCase().includes(term.toLowerCase())) {
        pushFailure(failures, 'doc_term_missing', `${path}:${term}`);
      }
    }
  }
  return docPresence;
}

function validateScripts(failures) {
  const scriptPresence = {};
  for (const path of REQUIRED_SCRIPTS) {
    const text = readText(path, failures);
    scriptPresence[path] = Boolean(text);
  }
  return scriptPresence;
}

function validateNoImplementationPaths(failures) {
  const checkedPaths = [
    'scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs',
    'scripts/gptoss/private-serving/private-serving-durable-replay-implementation-plan-validate.mjs',
    'scripts/gptoss/private-serving/private-serving-durable-replay-migration-guard.mjs',
    'scripts/gptoss/private-serving/private-serving-durable-replay-readiness-validate.mjs',
  ];

  for (const path of checkedPaths) {
    const text = readText(path, failures);
    for (const [label, pattern] of FORBIDDEN_IMPLEMENTATION_PATTERNS) {
      if (pattern.test(text)) {
        pushFailure(failures, 'forbidden_implementation_pattern', `${label}:${path}`);
      }
    }
  }

  return checkedPaths;
}

function validateReadiness(failures) {
  const readiness = buildReadinessReport();
  const expected = {
    durableReplayImplementationReady: true,
    replayProtectionDurableDesigned: true,
    replayProtectionDurableImplemented: false,
    replayProtectionDurable: false,
    durableReplayMigrationApplyAllowed: false,
    durableReplayMigrationApplied: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    publicServerCreated: false,
    customGptExposureCreated: false,
    cloudReady: false,
    customGptReady: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
  };

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (readiness[field] !== expectedValue) {
      pushFailure(failures, 'readiness_field_unexpected', `${field}=${readiness[field]}`);
    }
  }

  const cloudGate = buildCloudGate({ reportPath: undefined });
  if (cloudGate.cloudReady !== false) pushFailure(failures, 'cloud_ready_not_false');
  if (cloudGate.customGptReady !== false) pushFailure(failures, 'custom_gpt_ready_not_false');
  if (cloudGate.customGptDirectLocalExposureAllowed !== false) {
    pushFailure(failures, 'custom_gpt_exposure_not_blocked');
  }

  return { readiness, cloudGate };
}

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runPrivateServingDurableReplayReadinessValidation({
  output = DURABLE_REPLAY_READINESS_REPORT,
  write = true,
} = {}) {
  const failures = [];
  const docs = validateDocs(failures);
  const scripts = validateScripts(failures);
  const checkedImplementationPaths = validateNoImplementationPaths(failures);
  const migrationGuard = runPrivateServingDurableReplayMigrationGuard({ write: false });
  const { readiness, cloudGate } = validateReadiness(failures);

  if (migrationGuard.ok !== true) pushFailure(failures, 'migration_guard_not_ok');
  if (migrationGuard.applyAllowed !== false) pushFailure(failures, 'migration_apply_allowed');
  if (migrationGuard.liveDbWrite !== false) pushFailure(failures, 'migration_live_db_write_allowed');
  if (migrationGuard.durableReplayMigrationApplied !== false) {
    pushFailure(failures, 'migration_applied');
  }

  const noDbImplementation = !failures.some((failure) =>
    failure.includes('db_client_import') ||
    failure.includes('db_env_lookup') ||
    failure.includes('migration_apply_path'),
  );
  const noServerImplementation = !failures.some((failure) =>
    failure.includes('server_listener'),
  );
  const noExposurePath = (
    readiness.privateServingExposed === false &&
    readiness.customGptExposureCreated === false &&
    cloudGate.customGptDirectLocalExposureAllowed === false
  );

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_durable_replay_implementation_readiness',
    ok: failures.length === 0,
    durableReplayImplementationReady: true,
    replayProtectionDurableDesigned: true,
    replayProtectionDurableImplemented: false,
    replayProtectionDurable: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    migrationGuardExists: scripts[
      'scripts/gptoss/private-serving/private-serving-durable-replay-migration-guard.mjs'
    ] === true,
    migrationApplyBlocked: migrationGuard.applyAllowed === false,
    durableReplayMigrationApplied: false,
    liveDbUsed: false,
    liveDbWrite: false,
    serverCreated: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    noDbImplementation,
    noServerImplementation,
    noExposurePath,
    docs,
    scripts,
    checkedImplementationPaths,
    readiness: {
      durableReplayImplementationReady: readiness.durableReplayImplementationReady,
      replayProtectionDurableDesigned: readiness.replayProtectionDurableDesigned,
      replayProtectionDurableImplemented: readiness.replayProtectionDurableImplemented,
      replayProtectionDurable: readiness.replayProtectionDurable,
      durableReplayMigrationDraftReady: readiness.durableReplayMigrationDraftReady,
      durableReplayMigrationApplyAllowed: readiness.durableReplayMigrationApplyAllowed,
      durableReplayMigrationApplied: readiness.durableReplayMigrationApplied,
      privateServingImplemented: readiness.privateServingImplemented,
      privateServingExposed: readiness.privateServingExposed,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
    },
    migrationGuard: {
      ok: migrationGuard.ok,
      migrationDraftReady: migrationGuard.migrationDraftReady,
      applyAllowed: migrationGuard.applyAllowed,
      liveDbWrite: migrationGuard.liveDbWrite,
      durableReplayMigrationApplied: migrationGuard.durableReplayMigrationApplied,
      failures: migrationGuard.failures,
    },
    cloudGate: {
      cloudReady: cloudGate.cloudReady,
      customGptReady: cloudGate.customGptReady,
      customGptDirectLocalExposureAllowed: cloudGate.customGptDirectLocalExposureAllowed,
      blockers: cloudGate.blockers,
    },
    failures,
  };

  if (write) {
    writeReport(output, report);
  }
  return report;
}

function parseArgs(argv = []) {
  const options = {
    output: DURABLE_REPLAY_READINESS_REPORT,
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
  const report = runPrivateServingDurableReplayReadinessValidation(
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
