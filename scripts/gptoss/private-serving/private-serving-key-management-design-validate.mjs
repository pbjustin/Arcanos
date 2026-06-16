#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildCloudGate } from '../cloud-readiness-gate.mjs';
import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';

export const PRIVATE_SERVING_SCHEMA = 'schemas/gptoss-private-serving-boundary.schema.json';
export const KEY_MANAGEMENT_DESIGN_DOCS = [
  'docs/GPTOSS_PRODUCTION_KEY_MANAGEMENT_DESIGN.md',
  'docs/GPTOSS_KEY_ROTATION_RUNBOOK.md',
];
export const KEY_MANAGEMENT_DESIGN_VALIDATOR =
  'scripts/gptoss/private-serving/private-serving-key-management-design-validate.mjs';
export const KEY_MANAGEMENT_DESIGN_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-key-management-design-report.json';
export const KEY_MANAGEMENT_PACKAGE_SCRIPT = 'gptoss:private-serving:key-management:design:validate';
export const KEY_MANAGEMENT_PACKAGE_COMMAND =
  'node scripts/gptoss/private-serving/private-serving-key-management-design-validate.mjs';

const SCHEMA_DEFS = [
  'productionKeyManagementDesign',
  'keyDescriptor',
  'keyRotationPolicy',
  'keyRevocationPolicy',
  'keyManagementReadinessReport',
];

const SOURCE_SCAN_PATHS = [
  PRIVATE_SERVING_SCHEMA,
  KEY_MANAGEMENT_DESIGN_VALIDATOR,
];

const SECRET_LITERAL_PATTERNS = [
  ['openai_key_literal', new RegExp(`${'s'}${'k'}-[A-Za-z0-9_-]{16,}`, 'i')],
  ['bearer_literal', /Bearer\s+[A-Za-z0-9._-]{12,}/i],
  [
    'db_url_literal',
    new RegExp(`${'postgres'}:\\/\\/[^\\s"'<>]+|${'redis'}:\\/\\/[^\\s"'<>]+`, 'i'),
  ],
  [
    'secret_assignment_literal',
    /\b(api[_-]?key|token|password|secret|cookie)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
  ],
];

const ENV_SECRET_READ_PATTERNS = [
  [
    'process_env_secret_lookup',
    new RegExp(
      `${'process'}\\s*\\.\\s*${'env'}[^\\n;]*(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE|REDIS|OPENAI|RAILWAY)`,
      'i',
    ),
  ],
  [
    'secret_from_process_env',
    new RegExp(
      `(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE|REDIS|OPENAI|RAILWAY)[^\\n;=]*=\\s*${'process'}\\s*\\.\\s*${'env'}`,
      'i',
    ),
  ],
];

const KMS_IMPORT_PATTERN = new RegExp(`${'kms'}|${'key'}${'vault'}|${'cloud'}${'kms'}`, 'i');
const CLOUD_SDK_IMPORT_PATTERN = new RegExp(
  [
    `${'@aw'}${'s'}-${'sdk'}`,
    `${'aw'}${'s'}-${'sdk'}`,
    `${'@google'}-${'cloud'}`,
    `${'google'}${'apis'}`,
    `${'@azure'}/`,
    `${'boto'}${'3'}`,
  ].join('|'),
  'i',
);

const SERVER_LISTENER_PATTERNS = [
  [
    'server_module_import',
    new RegExp(
      `from\\s+['"](?:${'node'}:${'http'}|${'node'}:${'https'}|${'node'}:${'net'}|express|fastify)['"]`,
      'i',
    ),
  ],
  ['server_create_call', new RegExp(`${'create'}${'Server'}\\s*\\(`, 'i')],
  ['listener_call', new RegExp(`\\.${'listen'}\\s*\\(`, 'i')],
];

const EXTERNAL_OPERATION_PATTERNS = [
  [
    'openai_path',
    new RegExp(
      `${'api'}\\.${'openai'}\\.com|${'responses'}\\.${'create'}|from\\s+['"]${'openai'}['"]|new\\s+${'Open'}${'AI'}\\s*\\(`,
      'i',
    ),
  ],
  [
    'railway_path',
    new RegExp(
      `${'rail'}${'way'}\\s+(up|status|logs|link|whoami|run|${'de'}${'ploy'}|variables)`,
      'i',
    ),
  ],
  [
    'db_path',
    new RegExp(
      [
        `from\\s+['"](@${'prisma'}/client|pg|knex|redis)['"]`,
        `new\\s+${'Prisma'}${'Client'}`,
        `new\\s+${'Pool'}\\s*\\(`,
        `${'create'}${'Client'}\\s*\\(`,
        `${'postgres'}:\\/\\/`,
        `${'redis'}:\\/\\/`,
      ].join('|'),
      'i',
    ),
  ],
  ['vllm_path', new RegExp(`${'v'}${'llm'}\\s+${'serve'}|${'v'}${'llm'}\\.`, 'i')],
  ['deployment_path', new RegExp(`\\b${'de'}${'ploy'}\\b|${'migrate'}\\s+${'de'}${'ploy'}`, 'i')],
  [
    'custom_gpt_exposure_path',
    new RegExp(`custom-gpt\\s+(action|expose|${'de'}${'ploy'})|customGptExposureCreated\\s*:\\s*true`, 'i'),
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

function importSpecifiers(text) {
  const specifiers = [];
  for (const match of text.matchAll(/^\s*import(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function privateServingPackageCommands(packageJson) {
  return Object.entries(packageJson?.scripts ?? {})
    .filter(([name]) => name.startsWith('gptoss:private-serving:'))
    .map(([name, command]) => ({
      path: `package.json:scripts:${name}`,
      text: String(command),
    }));
}

function validateDocs(failures) {
  const docs = {};
  for (const path of KEY_MANAGEMENT_DESIGN_DOCS) {
    const text = readText(path, failures);
    docs[path] = Boolean(text);
  }
  return docs;
}

function validateSchema(failures) {
  const schema = readJson(PRIVATE_SERVING_SCHEMA, failures);
  const defs = schema?.$defs ?? {};
  for (const name of SCHEMA_DEFS) {
    if (!defs[name]) {
      pushFailure(failures, 'schema_def_missing', name);
    }
  }
  for (const name of SCHEMA_DEFS) {
    const ref = schema?.properties?.[name]?.$ref;
    if (ref !== `#/$defs/${name}`) {
      pushFailure(failures, 'schema_property_missing', name);
    }
  }

  const report = defs.keyManagementReadinessReport;
  for (const field of [
    'productionKeyManagementDesigned',
    'productionKeyManagementImplemented',
    'keyRotationPolicyDesigned',
    'keyRotationPolicyImplemented',
    'keyRevocationPolicyDesigned',
    'keyRevocationPolicyImplemented',
    'noRealSecretLiterals',
    'noEnvSecretReads',
    'noKmsImports',
    'noCloudSdkImports',
    'noServerListener',
    'noOpenAiPath',
    'noRailwayPath',
    'noDbPath',
    'noVllmPath',
    'readinessBlocked',
  ]) {
    if (!report?.required?.includes(field)) {
      pushFailure(failures, 'key_management_report_field_missing', field);
    }
  }

  const readiness = defs.readinessFlags;
  const expectedReadiness = {
    productionKeyManagementDesigned: true,
    productionKeyManagementImplemented: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
  };
  for (const [field, expectedValue] of Object.entries(expectedReadiness)) {
    if (readiness?.properties?.[field]?.const !== expectedValue) {
      pushFailure(failures, 'readiness_schema_field_unexpected', `${field}=${expectedValue}`);
    }
  }

  return Boolean(schema);
}

function validatePackageScript(failures) {
  const packageJson = readJson('package.json', failures);
  const command = packageJson?.scripts?.[KEY_MANAGEMENT_PACKAGE_SCRIPT];
  if (command !== KEY_MANAGEMENT_PACKAGE_COMMAND) {
    pushFailure(failures, 'package_script_missing_or_unexpected', KEY_MANAGEMENT_PACKAGE_SCRIPT);
  }
  return privateServingPackageCommands(packageJson);
}

function scanPatterns(targets, patterns, failures, failureCode) {
  for (const target of targets) {
    for (const [label, pattern] of patterns) {
      if (pattern.test(target.text)) {
        pushFailure(failures, failureCode, `${label}:${target.path}`);
      }
    }
  }
}

function validateNoKmsOrCloudSdkImports(targets, failures) {
  for (const target of targets) {
    for (const specifier of importSpecifiers(target.text)) {
      if (KMS_IMPORT_PATTERN.test(specifier)) {
        pushFailure(failures, 'kms_import_detected', `${target.path}:${specifier}`);
      }
      if (CLOUD_SDK_IMPORT_PATTERN.test(specifier)) {
        pushFailure(failures, 'cloud_sdk_import_detected', `${target.path}:${specifier}`);
      }
    }
  }
}

function validateStaticSafety(failures, packageCommands) {
  const docTargets = KEY_MANAGEMENT_DESIGN_DOCS.map((path) => ({
    path,
    text: readText(path, failures),
  }));
  const sourceTargets = SOURCE_SCAN_PATHS.map((path) => ({
    path,
    text: readText(path, failures),
  }));
  const commandTargets = packageCommands;
  const allTextTargets = [...docTargets, ...sourceTargets, ...commandTargets];
  const operationTargets = [...sourceTargets, ...commandTargets];

  scanPatterns(allTextTargets, SECRET_LITERAL_PATTERNS, failures, 'real_secret_literal_detected');
  scanPatterns(allTextTargets, ENV_SECRET_READ_PATTERNS, failures, 'env_secret_read_detected');
  validateNoKmsOrCloudSdkImports(sourceTargets, failures);
  scanPatterns(operationTargets, SERVER_LISTENER_PATTERNS, failures, 'server_listener_detected');
  scanPatterns(operationTargets, EXTERNAL_OPERATION_PATTERNS, failures, 'external_operation_path_detected');

  return {
    checkedDocs: docTargets.map((target) => target.path),
    checkedSources: sourceTargets.map((target) => target.path),
    checkedPackageScripts: commandTargets.map((target) => target.path),
  };
}

function validateReadiness(failures) {
  const readiness = buildReadinessReport();
  const expected = {
    productionKeyManagementDesigned: true,
    productionKeyManagementImplemented: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
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
  if (cloudGate.productionKeyManagementImplemented !== false) {
    pushFailure(failures, 'cloud_gate_key_management_implemented_not_false');
  }

  return { readiness, cloudGate };
}

function writeReport(path, report) {
  if (path !== KEY_MANAGEMENT_DESIGN_REPORT) {
    throw new Error(`key management report path is fixed: ${KEY_MANAGEMENT_DESIGN_REPORT}`);
  }
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runPrivateServingKeyManagementDesignValidation({ write = true } = {}) {
  const failures = [];
  const docs = validateDocs(failures);
  const schemaParsed = validateSchema(failures);
  const packageCommands = validatePackageScript(failures);
  const checked = validateStaticSafety(failures, packageCommands);
  const { readiness, cloudGate } = validateReadiness(failures);

  const hasFailure = (code) => failures.some((failure) => failure.startsWith(code));
  const noRealSecretLiterals = !hasFailure('real_secret_literal_detected');
  const noEnvSecretReads = !hasFailure('env_secret_read_detected');
  const noKmsImports = !hasFailure('kms_import_detected');
  const noCloudSdkImports = !hasFailure('cloud_sdk_import_detected');
  const noServerListener = !hasFailure('server_listener_detected');
  const noExternalOperationPath = !hasFailure('external_operation_path_detected');
  const noOpenAiPath = !failures.some((failure) => failure.includes('openai_path'));
  const noRailwayPath = !failures.some((failure) => failure.includes('railway_path'));
  const noDbPath = !failures.some((failure) => failure.includes('db_path'));
  const noVllmPath = !failures.some((failure) => failure.includes('vllm_path'));
  const readinessBlocked = (
    readiness.productionKeyManagementImplemented === false &&
    readiness.privateServingImplemented === false &&
    readiness.privateServingExposed === false &&
    cloudGate.cloudReady === false &&
    cloudGate.customGptReady === false
  );

  if (!readinessBlocked) {
    pushFailure(failures, 'readiness_not_blocked');
  }

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_key_management_design_validation',
    ok: failures.length === 0,
    productionKeyManagementDesigned: true,
    productionKeyManagementImplemented: false,
    keyRotationPolicyDesigned: true,
    keyRotationPolicyImplemented: false,
    keyRevocationPolicyDesigned: true,
    keyRevocationPolicyImplemented: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
    noRealSecretLiterals,
    noEnvSecretReads,
    noKmsImports,
    noCloudSdkImports,
    noServerListener,
    noExternalOperationPath,
    noOpenAiPath,
    noRailwayPath,
    noDbPath,
    noVllmPath,
    readinessBlocked,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    serverCreated: false,
    docs,
    schemaParsed,
    packageScript: {
      name: KEY_MANAGEMENT_PACKAGE_SCRIPT,
      command: KEY_MANAGEMENT_PACKAGE_COMMAND,
    },
    checked,
    readiness: {
      productionKeyManagementDesigned: readiness.productionKeyManagementDesigned,
      productionKeyManagementImplemented: readiness.productionKeyManagementImplemented,
      realSecretsUsed: readiness.realSecretsUsed,
      envSecretsRead: readiness.envSecretsRead,
      kmsIntegrated: readiness.kmsIntegrated,
      privateServingImplemented: readiness.privateServingImplemented,
      privateServingExposed: readiness.privateServingExposed,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
    },
    cloudGate: {
      cloudReady: cloudGate.cloudReady,
      customGptReady: cloudGate.customGptReady,
      customGptDirectLocalExposureAllowed: cloudGate.customGptDirectLocalExposureAllowed,
      productionKeyManagementDesigned: cloudGate.productionKeyManagementDesigned,
      productionKeyManagementImplemented: cloudGate.productionKeyManagementImplemented,
      realSecretsUsed: cloudGate.realSecretsUsed,
      envSecretsRead: cloudGate.envSecretsRead,
      kmsIntegrated: cloudGate.kmsIntegrated,
      blockers: cloudGate.blockers,
    },
    failures,
  };

  if (write) {
    writeReport(KEY_MANAGEMENT_DESIGN_REPORT, report);
  }
  return report;
}

function parseArgs(argv = []) {
  const options = { write: true };
  for (const flag of argv) {
    if (flag === '--no-write') {
      options.write = false;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

function main() {
  const report = runPrivateServingKeyManagementDesignValidation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
