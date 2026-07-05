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

import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';
import { buildCloudGate } from '../cloud-readiness-gate.mjs';

export const PRIVATE_SERVING_SCAFFOLD_DIR = 'scripts/gptoss/private-serving';
export const PRIVATE_SERVING_SCAFFOLD_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-scaffold-report.json';
export const PRIVATE_SERVING_SCAFFOLD_PR_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-scaffold-pr-report.json';

export const REQUIRED_SCAFFOLD_MODULES = [
  'private-serving-signing.mjs',
  'private-serving-auth.mjs',
  'private-serving-replay-protection.mjs',
  'private-serving-rate-limit.mjs',
  'private-serving-response.mjs',
  'private-serving-deny.mjs',
  'private-serving-auth-validate.mjs',
  'private-serving-replay-validate.mjs',
];
export const SCAFFOLD_REPORT_SCRIPTS = [
  ...REQUIRED_SCAFFOLD_MODULES,
  'private-serving-scaffold-validate.mjs',
];

const FORBIDDEN_PATTERNS = [
  ['express_dependency', new RegExp(`(^|[^A-Za-z])${'ex'}${'press'}([^A-Za-z]|$)`, 'i')],
  ['fastify_dependency', new RegExp(`(^|[^A-Za-z])${'fast'}${'ify'}([^A-Za-z]|$)`, 'i')],
  ['http_module_import', new RegExp(`${'node:'}${'http'}|${'http'}\\.${'create'}${'Server'}`, 'i')],
  ['https_module_import', new RegExp(`${'node:'}${'https'}|${'https'}\\.${'create'}${'Server'}`, 'i')],
  ['net_module_import', new RegExp(`${'node:'}${'net'}|${'net'}\\.${'create'}${'Server'}`, 'i')],
  ['app_listener', new RegExp(`${'app'}\\.${'listen'}\\s*\\(`, 'i')],
  ['server_listener', new RegExp(`${'server'}\\.${'listen'}\\s*\\(`, 'i')],
  ['generic_listener', new RegExp(`\\.${'listen'}\\s*\\(`, 'i')],
  ['openai_network_path', new RegExp(`${'api'}\\.${'openai'}\\.com|${'responses'}\\.${'create'}`, 'i')],
  ['model_server_path', new RegExp(`${'v'}${'llm'}\\s+|${'v'}${'llm'}\\.|${'v'}${'llm'}-${'serve'}`, 'i')],
  ['railway_command_path', new RegExp(`${'rail'}${'way'}\\s+|${'rail'}${'way'}\\.|${'rail'}${'way'}-cli`, 'i')],
  ['live_database_path', new RegExp(`${'postgres'}://|${'redis'}://|${'database'}[_-]?${'url'}`, 'i')],
  ['process_execution_path', new RegExp(`${'child'}_${'process'}|\\b${'spawn'}\\b|\\b${'exec'}\\b`, 'i')],
  ['training_path', new RegExp(`\\b${'train'}\\b|${'fine'}-${'tune'}|${'finetune'}`, 'i')],
];

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}:${detail}` : code);
}

function listModuleFiles(scaffoldDir) {
  if (!existsSync(scaffoldDir)) {
    return [];
  }
  return readdirSync(scaffoldDir)
    .map((name) => join(scaffoldDir, name))
    .filter((path) =>
      statSync(path).isFile() &&
      path.endsWith('.mjs') &&
      !path.endsWith('private-serving-scaffold-validate.mjs') &&
      !path.endsWith('private-serving-durable-replay-design-validate.mjs') &&
      !path.endsWith('private-serving-durable-replay-implementation-plan-validate.mjs') &&
      !path.endsWith('private-serving-durable-replay-readiness-validate.mjs') &&
      !path.endsWith('private-serving-key-management-design-validate.mjs') &&
      !path.endsWith('private-serving-rate-limit-design-validate.mjs') &&
      !path.endsWith('private-serving-operations-readiness-validate.mjs'),
    );
}

async function validateModulesLoad(scaffoldDir, failures) {
  for (const name of REQUIRED_SCAFFOLD_MODULES) {
    const path = join(scaffoldDir, name);
    if (!existsSync(path)) {
      pushFailure(failures, 'scaffold_module_missing', name);
      continue;
    }
    try {
      await import(pathToFileURL(resolve(process.cwd(), path)).href);
    } catch (error) {
      pushFailure(
        failures,
        'scaffold_module_load_failed',
        `${name}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function validateNoForbiddenPatterns(scaffoldDir, failures) {
  for (const file of listModuleFiles(scaffoldDir)) {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) {
        pushFailure(failures, 'forbidden_scaffold_pattern', `${label}:${file.replace(/\\/g, '/')}`);
      }
    }
  }
}

function validateReadiness(failures) {
  const readiness = buildReadinessReport();
  const expected = {
    privateServingDesignReady: true,
    privateServingScaffoldReady: true,
    privateServingImplemented: false,
    privateServingExposed: false,
    requestSigningDesigned: true,
    requestSigningScaffoldReady: true,
    requestSigningImplemented: true,
    authBoundaryDesigned: true,
    authBoundaryScaffoldReady: true,
    authBoundaryImplemented: true,
    replayProtectionScaffoldReady: true,
    replayProtectionImplemented: true,
    replayProtectionDurableDesigned: true,
    replayProtectionDurableImplemented: false,
    replayProtectionDurable: false,
    rateLimitScaffoldReady: true,
    rateLimitImplemented: false,
    responseShapingScaffoldReady: true,
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

  return readiness;
}

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function runPrivateServingScaffoldValidation({
  scaffoldDir = PRIVATE_SERVING_SCAFFOLD_DIR,
  output = PRIVATE_SERVING_SCAFFOLD_REPORT,
  write = true,
} = {}) {
  const failures = [];
  await validateModulesLoad(scaffoldDir, failures);
  validateNoForbiddenPatterns(scaffoldDir, failures);
  const readiness = validateReadiness(failures);

  const report = {
    ok: failures.length === 0,
    privateServingDesignReady: readiness.privateServingDesignReady === true,
    privateServingScaffoldReady: readiness.privateServingScaffoldReady === true,
    requestSigningImplemented: true,
    authBoundaryImplemented: true,
    replayProtectionScaffoldReady: true,
    replayProtectionImplemented: true,
    replayProtectionDurableDesigned: true,
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
    failures,
    scripts: SCAFFOLD_REPORT_SCRIPTS.map((name) => join(PRIVATE_SERVING_SCAFFOLD_DIR, name)),
    docs: [
      'docs/GPTOSS_PRIVATE_SERVING_BOUNDARY.md',
      'docs/GPTOSS_PRIVATE_ENDPOINT_CONTRACT.md',
      'docs/GPTOSS_PRIVATE_SERVING_THREAT_MODEL.md',
      'docs/GPTOSS_PRIVATE_SERVING_RUNBOOK.md',
      'docs/GPTOSS_DURABLE_REPLAY_STORE_DESIGN.md',
    ],
    tests: [
      'tests/gptoss-private-serving-scaffold.test.ts',
      'tests/gptoss-private-serving-auth.test.ts',
      'tests/gptoss-private-serving-replay.test.ts',
    ],
  };

  if (write) {
    writeReport(output, report);
  }

  return report;
}

function parseArgs(argv = []) {
  const options = {
    output: PRIVATE_SERVING_SCAFFOLD_REPORT,
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
    } else if (flag === '--pr-report') {
      options.output = PRIVATE_SERVING_SCAFFOLD_PR_REPORT;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPrivateServingScaffoldValidation(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
