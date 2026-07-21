#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildCloudGate } from '../cloud-readiness-gate.mjs';
import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';
import { runReleaseGateCi } from '../runtime-release-gate-ci.mjs';

export const PRIVATE_SERVING_SCHEMA = 'schemas/gptoss-private-serving-boundary.schema.json';
export const FINAL_READINESS_VALIDATOR =
  'scripts/gptoss/private-serving/private-serving-final-readiness-validate.mjs';
export const FINAL_READINESS_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-final-readiness-report.json';
export const FINAL_READINESS_PACKAGE_SCRIPT =
  'gptoss:private-serving:final-readiness:validate';
export const FINAL_READINESS_PACKAGE_COMMAND =
  'node scripts/gptoss/private-serving/private-serving-final-readiness-validate.mjs';

export const REQUIRED_PHASE5_DOCS = [
  'docs/GPTOSS_LOCAL_RUNTIME.md',
  'docs/GPTOSS_RUNTIME_ARCHITECTURE.md',
  'docs/GPTOSS_PRIVATE_SERVING_BOUNDARY.md',
  'docs/GPTOSS_PRIVATE_ENDPOINT_CONTRACT.md',
  'docs/GPTOSS_PRIVATE_SERVING_RUNBOOK.md',
  'docs/GPTOSS_PRIVATE_SERVING_THREAT_MODEL.md',
  'docs/GPTOSS_DURABLE_REPLAY_STORE_DESIGN.md',
  'docs/GPTOSS_DURABLE_REPLAY_STORE_IMPLEMENTATION_PLAN.md',
  'docs/GPTOSS_DURABLE_REPLAY_IMPLEMENTATION_READINESS.md',
  'docs/GPTOSS_DURABLE_REPLAY_ROLLBACK_PLAN.md',
  'docs/GPTOSS_DURABLE_REPLAY_SECURITY_REVIEW.md',
  'docs/GPTOSS_PRODUCTION_KEY_MANAGEMENT_DESIGN.md',
  'docs/GPTOSS_KEY_ROTATION_RUNBOOK.md',
  'docs/GPTOSS_DURABLE_RATE_LIMIT_DESIGN.md',
  'docs/GPTOSS_RATE_LIMIT_RUNBOOK.md',
  'docs/GPTOSS_PRIVATE_SERVING_OPERATIONS_READINESS.md',
  'docs/GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE.md',
  'docs/GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST.md',
  'docs/GPTOSS_PRIVATE_SERVING_FINAL_READINESS_REVIEW.md',
  'docs/GPTOSS_PHASE6_IMPLEMENTATION_ENTRY_CRITERIA.md',
  'docs/GPTOSS_PRODUCTION_NO_GO_CHECKLIST.md',
];

export const REQUIRED_VALIDATORS = [
  'scripts/gptoss/model-readiness-report.mjs',
  'scripts/gptoss/cloud-readiness-gate.mjs',
  'scripts/gptoss/private-serving-design-validate.mjs',
  'scripts/gptoss/private-serving-threat-model-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-scaffold-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-auth-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-replay-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-durable-replay-design-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-durable-replay-implementation-plan-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-durable-replay-migration-guard.mjs',
  'scripts/gptoss/private-serving/private-serving-durable-replay-readiness-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-key-management-design-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-rate-limit-design-validate.mjs',
  'scripts/gptoss/private-serving/private-serving-operations-readiness-validate.mjs',
  'scripts/gptoss/runtime-release-gate-ci.mjs',
  FINAL_READINESS_VALIDATOR,
];

const PHASE_512_SOURCE_PATHS = [
  PRIVATE_SERVING_SCHEMA,
  'scripts/gptoss/model-readiness-report.mjs',
  'scripts/gptoss/cloud-readiness-gate.mjs',
  FINAL_READINESS_VALIDATOR,
];

const FINAL_REPORT_REQUIRED_FIELDS = [
  'schemaVersion',
  'kind',
  'ok',
  'effectiveScore',
  'phase6ImplementationReady',
  'finalArchitectureReadinessReviewed',
  'localControlledRuntimeReady',
  'requestSigningImplemented',
  'authBoundaryImplemented',
  'replayProtectionImplemented',
  'replayProtectionDurableDesigned',
  'replayProtectionDurableImplemented',
  'durableReplayMigrationApplyAllowed',
  'durableRateLimitDesigned',
  'durableRateLimitImplemented',
  'productionKeyManagementDesigned',
  'productionKeyManagementImplemented',
  'operationsReadinessDesigned',
  'incidentResponseReady',
  'productionGoNoGoChecklistReady',
  'productionGoAllowed',
  'privateServingImplemented',
  'privateServingExposed',
  'cloudReady',
  'customGptReady',
  'allRequiredPhase5DocsExist',
  'allKeyValidatorsExist',
  'ciReleaseGatePassed',
  'trackedBaselineValid',
  'noServerListener',
  'noDbPath',
  'noMigrationApplyPath',
  'noRailwayPath',
  'noOpenAiPath',
  'noTrainingPath',
  'noVllmPath',
  'noRealSecretLiterals',
  'noEnvSecretReads',
  'noKmsImports',
  'serverCreated',
  'liveDbUsed',
  'railwayCliUsed',
  'openAiCalled',
  'trainingExecuted',
  'vllmUsed',
  'realSecretsUsed',
  'envSecretsRead',
  'kmsIntegrated',
  'requiredDocs',
  'requiredValidators',
  'phase6EntryCriteria',
  'productionNoGoChecklist',
  'failures',
];

const SECRET_LITERAL_PATTERNS = [
  ['provider_key_literal', new RegExp(`${'s'}${'k'}-[A-Za-z0-9_-]{16,}`, 'i')],
  ['bearer_literal', /Bearer\s+[A-Za-z0-9._-]{12,}/i],
  [
    'connection_literal',
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

const SERVER_LISTENER_PATTERNS = [
  [
    'server_module_import',
    new RegExp(
      `from\\s+['"](?:${'node'}:${'http'}|${'node'}:${'https'}|${'node'}:${'net'}|${'ex'}${'press'}|${'fast'}${'ify'})['"]`,
      'i',
    ),
  ],
  ['server_create_call', new RegExp(`${'create'}${'Server'}\\s*\\(`, 'i')],
  ['listener_call', new RegExp(`\\.${'listen'}\\s*\\(`, 'i')],
];

const DB_PATH_PATTERNS = [
  [
    'database_client_import',
    new RegExp(
      `from\\s+['"](?:@${'prisma'}/client|pg|knex|redis|ioredis|mysql2?|mongoose)['"]`,
      'i',
    ),
  ],
  ['prisma_client_call', new RegExp(`new\\s+${'Prisma'}${'Client'}\\s*\\(`, 'i')],
  ['pool_client_call', new RegExp(`new\\s+${'Pool'}\\s*\\(`, 'i')],
  ['database_create_client_call', new RegExp(`${'create'}${'Client'}\\s*\\(`, 'i')],
  ['database_env_name', new RegExp(`${'DATABASE'}_${'URL'}`, 'i')],
  ['connection_scheme', new RegExp(`${'postgres'}:\\/\\/|${'redis'}:\\/\\/`, 'i')],
];

const MIGRATION_APPLY_PATTERNS = [
  ['execute_flag', new RegExp(`--${'exe'}${'cute'}\\b`, 'i')],
  ['database_write_flag', new RegExp(`--allow-${'db'}-${'write'}\\b`, 'i')],
  ['schema_apply_command', new RegExp(`${'db'}:${'schema'}:${'apply'}\\b`, 'i')],
  [
    'migration_apply_command',
    new RegExp(
      `${'prisma'}\\s+${'migrate'}\\s+${'deploy'}|${'knex'}\\s+${'migrate'}:${'latest'}|${'sequelize'}\\s+${'db'}:${'migrate'}`,
      'i',
    ),
  ],
];

const RAILWAY_PATH_PATTERNS = [
  [
    'railway_command',
    new RegExp(
      `\\b${'rail'}${'way'}\\s+(?:up|status|logs|link|whoami|run|${'de'}${'ploy'}|variables)\\b`,
      'i',
    ),
  ],
];

const OPEN_AI_PATH_PATTERNS = [
  [
    'openai_client_path',
    new RegExp(
      `${'api'}\\.${'openai'}\\.com|${'responses'}\\.${'create'}|from\\s+['"]${'openai'}['"]|new\\s+${'Open'}${'AI'}\\s*\\(`,
      'i',
    ),
  ],
];

const TRAINING_PATH_PATTERNS = [
  [
    'training_execution',
    new RegExp(
      `\\.${'tr'}${'ain'}\\s*\\(|${'fine'}_${'tuning'}\\.${'jobs'}\\.${'create'}|${'fine'}-${'tune'}\\s+(?:run|create)`,
      'i',
    ),
  ],
];

const VLLM_PATH_PATTERNS = [
  [
    'vllm_invocation',
    new RegExp(`${'v'}${'llm'}\\s+${'serve'}|from\\s+['"]${'v'}${'llm'}|${'v'}${'llm'}\\.`, 'i'),
  ],
];

const DEPLOYMENT_PATH_PATTERNS = [
  [
    'deployment_execution',
    new RegExp(
      `${'kubectl'}\\s+${'apply'}|${'terraform'}\\s+${'apply'}|\\.${'deploy'}\\s*\\(|npm\\s+run\\s+${'deploy'}\\b`,
      'i',
    ),
  ],
];

const CUSTOM_GPT_EXPOSURE_PATTERNS = [
  [
    'custom_gpt_exposure',
    new RegExp(
      `${'custom'}-${'gpt'}\\s+(?:action|expose|${'deploy'})|customGptExposureCreated\\s*:\\s*true`,
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

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}:${detail}` : code);
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function readText(path, failures) {
  if (!isFile(path)) {
    pushFailure(failures, 'missing_file', path);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function readJson(path, failures) {
  const text = readText(path, failures);
  if (!text) return undefined;
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

function validateRequiredFiles(paths, failures, failureCode) {
  return Object.fromEntries(paths.map((path) => {
    const exists = isFile(path);
    if (!exists) pushFailure(failures, failureCode, path);
    return [path, exists];
  }));
}

function validateSchema(failures) {
  const schema = readJson(PRIVATE_SERVING_SCHEMA, failures);
  const definitions = [
    'finalArchitectureReadinessReport',
    'phase6EntryCriteriaReport',
    'productionNoGoChecklistReport',
  ];
  for (const name of definitions) {
    if (!schema?.$defs?.[name]) pushFailure(failures, 'schema_def_missing', name);
    if (schema?.properties?.[name]?.$ref !== `#/$defs/${name}`) {
      pushFailure(failures, 'schema_property_missing', name);
    }
  }

  const report = schema?.$defs?.finalArchitectureReadinessReport;
  for (const field of FINAL_REPORT_REQUIRED_FIELDS) {
    if (!report?.required?.includes(field)) {
      pushFailure(failures, 'final_report_schema_field_missing', field);
    }
  }

  const readinessFlags = schema?.$defs?.readinessFlags;
  const readinessExpected = {
    phase6ImplementationReady: true,
    finalArchitectureReadinessReviewed: true,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
  };
  for (const [field, expected] of Object.entries(readinessExpected)) {
    if (readinessFlags?.properties?.[field]?.const !== expected) {
      pushFailure(failures, 'readiness_schema_field_unexpected', `${field}=${expected}`);
    }
  }

  return Boolean(schema);
}

function validatePackageScript(failures) {
  const packageJson = readJson('package.json', failures);
  const actual = packageJson?.scripts?.[FINAL_READINESS_PACKAGE_SCRIPT];
  const valid = actual === FINAL_READINESS_PACKAGE_COMMAND;
  if (!valid) {
    pushFailure(failures, 'package_script_missing_or_unexpected', FINAL_READINESS_PACKAGE_SCRIPT);
  }
  return {
    name: FINAL_READINESS_PACKAGE_SCRIPT,
    command: FINAL_READINESS_PACKAGE_COMMAND,
    valid,
  };
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

function scanPatterns(targets, patterns, failures, failureCode) {
  for (const target of targets) {
    for (const [label, pattern] of patterns) {
      if (pattern.test(target.text)) {
        pushFailure(failures, failureCode, `${label}:${target.path}`);
      }
    }
  }
}

function validateImports(targets, failures) {
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

function validateStaticSafety(failures, packageScript) {
  const sourceTargets = PHASE_512_SOURCE_PATHS.map((path) => ({
    path,
    text: readText(path, failures),
  }));
  const commandTargets = [{
    path: `package.json:scripts:${FINAL_READINESS_PACKAGE_SCRIPT}`,
    text: packageScript.valid ? packageScript.command : '',
  }];
  const targets = [...sourceTargets, ...commandTargets];

  scanPatterns(targets, SECRET_LITERAL_PATTERNS, failures, 'real_secret_literal_detected');
  scanPatterns(targets, ENV_SECRET_READ_PATTERNS, failures, 'env_secret_read_detected');
  validateImports(sourceTargets, failures);
  scanPatterns(targets, SERVER_LISTENER_PATTERNS, failures, 'server_listener_detected');
  scanPatterns(targets, DB_PATH_PATTERNS, failures, 'db_path_detected');
  scanPatterns(targets, MIGRATION_APPLY_PATTERNS, failures, 'migration_apply_path_detected');
  scanPatterns(targets, RAILWAY_PATH_PATTERNS, failures, 'railway_path_detected');
  scanPatterns(targets, OPEN_AI_PATH_PATTERNS, failures, 'openai_path_detected');
  scanPatterns(targets, TRAINING_PATH_PATTERNS, failures, 'training_path_detected');
  scanPatterns(targets, VLLM_PATH_PATTERNS, failures, 'vllm_path_detected');
  scanPatterns(targets, DEPLOYMENT_PATH_PATTERNS, failures, 'deployment_path_detected');
  scanPatterns(
    targets,
    CUSTOM_GPT_EXPOSURE_PATTERNS,
    failures,
    'custom_gpt_exposure_path_detected',
  );

  return {
    checkedSources: sourceTargets.map((target) => target.path),
    checkedPackageScripts: commandTargets.map((target) => target.path),
  };
}

function validateExpectedFields(sourceName, source, expected, failures) {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (source?.[field] !== expectedValue) {
      pushFailure(
        failures,
        `${sourceName}_field_unexpected`,
        `${field}=${String(source?.[field])}`,
      );
    }
  }
}

function validateReadiness(failures) {
  const readiness = buildReadinessReport();
  const cloudGate = buildCloudGate({ reportPath: undefined });
  const expected = {
    effectiveScore: '24/24',
    localControlledRuntimeReady: true,
    phase6ImplementationReady: true,
    finalArchitectureReadinessReviewed: true,
    requestSigningImplemented: true,
    authBoundaryImplemented: true,
    replayProtectionImplemented: true,
    replayProtectionDurableDesigned: true,
    replayProtectionDurableImplemented: false,
    durableReplayMigrationApplyAllowed: false,
    durableRateLimitDesigned: true,
    durableRateLimitImplemented: false,
    productionKeyManagementDesigned: true,
    productionKeyManagementImplemented: false,
    operationsReadinessDesigned: true,
    incidentResponseReady: true,
    productionGoNoGoChecklistReady: true,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    publicServerCreated: false,
    customGptExposureCreated: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
  };
  validateExpectedFields('readiness', readiness, expected, failures);

  validateExpectedFields('cloud_gate', cloudGate, {
    localControlledRuntimeReady: true,
    phase6ImplementationReady: true,
    finalArchitectureReadinessReviewed: true,
    requestSigningImplemented: true,
    authBoundaryImplemented: true,
    replayProtectionImplemented: true,
    replayProtectionDurableDesigned: true,
    replayProtectionDurableImplemented: false,
    durableReplayMigrationApplyAllowed: false,
    durableRateLimitDesigned: true,
    durableRateLimitImplemented: false,
    productionKeyManagementDesigned: true,
    productionKeyManagementImplemented: false,
    operationsReadinessDesigned: true,
    incidentResponseReady: true,
    productionGoNoGoChecklistReady: true,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    publicServerCreated: false,
    customGptDirectLocalExposureAllowed: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
  }, failures);

  return { readiness, cloudGate };
}

function validateReleaseGate(failures) {
  const releaseGate = runReleaseGateCi({ ci: true, write: false });
  const trackedBaselineValid = (
    releaseGate.effectiveScore === '24/24' &&
    releaseGate.localControlledRuntimeReady === true &&
    releaseGate.cloudReady === false &&
    releaseGate.customGptReady === false &&
    releaseGate.checks?.baselineMetadataStable === true
  );
  const ciReleaseGatePassed = releaseGate.ok === true && trackedBaselineValid;
  if (!trackedBaselineValid) pushFailure(failures, 'tracked_baseline_invalid');
  if (!ciReleaseGatePassed) pushFailure(failures, 'ci_release_gate_failed');

  return {
    ciReleaseGatePassed,
    trackedBaselineValid,
    releaseGate: {
      ok: releaseGate.ok,
      effectiveScore: releaseGate.effectiveScore,
      localControlledRuntimeReady: releaseGate.localControlledRuntimeReady,
      cloudReady: releaseGate.cloudReady,
      customGptReady: releaseGate.customGptReady,
      failures: releaseGate.failures,
    },
  };
}

function hasFailure(failures, code) {
  return failures.some((failure) => failure.startsWith(code));
}

function writeReport(path, report) {
  if (path !== FINAL_READINESS_REPORT) {
    throw new Error(`final readiness report path is fixed: ${FINAL_READINESS_REPORT}`);
  }
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runPrivateServingFinalReadinessValidation({ write = true } = {}) {
  const failures = [];
  const requiredDocs = validateRequiredFiles(
    REQUIRED_PHASE5_DOCS,
    failures,
    'required_phase5_doc_missing',
  );
  const requiredValidators = validateRequiredFiles(
    REQUIRED_VALIDATORS,
    failures,
    'required_validator_missing',
  );
  const allRequiredPhase5DocsExist = Object.values(requiredDocs).every(Boolean);
  const allKeyValidatorsExist = Object.values(requiredValidators).every(Boolean);
  const schemaParsed = validateSchema(failures);
  const packageScript = validatePackageScript(failures);
  const checked = validateStaticSafety(failures, packageScript);
  const { readiness, cloudGate } = validateReadiness(failures);
  const {
    ciReleaseGatePassed,
    trackedBaselineValid,
    releaseGate,
  } = validateReleaseGate(failures);

  const noServerListener = !hasFailure(failures, 'server_listener_detected');
  const noDbPath = !hasFailure(failures, 'db_path_detected');
  const noMigrationApplyPath = !hasFailure(failures, 'migration_apply_path_detected');
  const noRailwayPath = !hasFailure(failures, 'railway_path_detected');
  const noOpenAiPath = !hasFailure(failures, 'openai_path_detected');
  const noTrainingPath = !hasFailure(failures, 'training_path_detected');
  const noVllmPath = !hasFailure(failures, 'vllm_path_detected');
  const noDeploymentPath = !hasFailure(failures, 'deployment_path_detected');
  const noCustomGptExposurePath = !hasFailure(
    failures,
    'custom_gpt_exposure_path_detected',
  );
  const noRealSecretLiterals = !hasFailure(failures, 'real_secret_literal_detected');
  const noEnvSecretReads = !hasFailure(failures, 'env_secret_read_detected');
  const noKmsImports = !hasFailure(failures, 'kms_import_detected');
  const noCloudSdkImports = !hasFailure(failures, 'cloud_sdk_import_detected');

  const phase6EntryCriteria = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_phase6_entry_criteria',
    ok: failures.length === 0,
    phase6ImplementationReady: true,
    finalArchitectureReadinessReviewed: true,
    internalPrivateServingRequestHandlerAllowed: true,
    publicServerAllowed: false,
    publicExposureAllowed: false,
    customGptBridgeAllowed: false,
    rawModelEndpointAllowed: false,
    liveDbAllowed: false,
    deploymentAllowed: false,
    railwayCommandPathAllowed: false,
    openAiReferencePathAllowed: false,
    trainingPathAllowed: false,
    vllmPathAllowed: false,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
  };
  const productionNoGoChecklist = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_production_no_go_checklist',
    ok: failures.length === 0,
    phase6ImplementationReady: true,
    finalArchitectureReadinessReviewed: true,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    replayProtectionDurableImplemented: false,
    durableRateLimitImplemented: false,
    productionKeyManagementImplemented: false,
    durableReplayMigrationApplyAllowed: false,
    serverCreated: false,
    liveDbUsed: false,
    railwayCliUsed: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
  };

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_final_architecture_readiness',
    ok: failures.length === 0,
    effectiveScore: readiness.effectiveScore,
    phase6ImplementationReady: true,
    finalArchitectureReadinessReviewed: true,
    localControlledRuntimeReady: readiness.localControlledRuntimeReady,
    requestSigningImplemented: readiness.requestSigningImplemented,
    authBoundaryImplemented: readiness.authBoundaryImplemented,
    replayProtectionImplemented: readiness.replayProtectionImplemented,
    replayProtectionDurableDesigned: readiness.replayProtectionDurableDesigned,
    replayProtectionDurableImplemented: readiness.replayProtectionDurableImplemented,
    durableReplayMigrationApplyAllowed: readiness.durableReplayMigrationApplyAllowed,
    durableRateLimitDesigned: readiness.durableRateLimitDesigned,
    durableRateLimitImplemented: readiness.durableRateLimitImplemented,
    productionKeyManagementDesigned: readiness.productionKeyManagementDesigned,
    productionKeyManagementImplemented: readiness.productionKeyManagementImplemented,
    operationsReadinessDesigned: readiness.operationsReadinessDesigned,
    incidentResponseReady: readiness.incidentResponseReady,
    productionGoNoGoChecklistReady: readiness.productionGoNoGoChecklistReady,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    allRequiredPhase5DocsExist,
    allKeyValidatorsExist,
    ciReleaseGatePassed,
    trackedBaselineValid,
    noServerListener,
    noDbPath,
    noMigrationApplyPath,
    noRailwayPath,
    noOpenAiPath,
    noTrainingPath,
    noVllmPath,
    noDeploymentPath,
    noCustomGptExposurePath,
    noRealSecretLiterals,
    noEnvSecretReads,
    noKmsImports,
    noCloudSdkImports,
    noExternalOperationPath: (
      noServerListener &&
      noDbPath &&
      noMigrationApplyPath &&
      noRailwayPath &&
      noOpenAiPath &&
      noTrainingPath &&
      noVllmPath &&
      noDeploymentPath &&
      noCustomGptExposurePath
    ),
    serverCreated: false,
    publicServerCreated: false,
    liveDbUsed: false,
    migrationApplied: false,
    railwayCliUsed: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    deploymentExecuted: false,
    customGptExposureCreated: false,
    realSecretsUsed: false,
    envSecretsRead: false,
    kmsIntegrated: false,
    requiredDocs,
    requiredValidators,
    schemaParsed,
    packageScript,
    checked,
    readiness: {
      effectiveScore: readiness.effectiveScore,
      localControlledRuntimeReady: readiness.localControlledRuntimeReady,
      phase6ImplementationReady: readiness.phase6ImplementationReady,
      finalArchitectureReadinessReviewed: readiness.finalArchitectureReadinessReviewed,
      productionGoAllowed: readiness.productionGoAllowed,
      privateServingImplemented: readiness.privateServingImplemented,
      privateServingExposed: readiness.privateServingExposed,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
    },
    cloudGate: {
      localControlledRuntimeReady: cloudGate.localControlledRuntimeReady,
      phase6ImplementationReady: cloudGate.phase6ImplementationReady,
      finalArchitectureReadinessReviewed: cloudGate.finalArchitectureReadinessReviewed,
      productionGoAllowed: cloudGate.productionGoAllowed,
      privateServingImplemented: cloudGate.privateServingImplemented,
      privateServingExposed: cloudGate.privateServingExposed,
      cloudReady: cloudGate.cloudReady,
      customGptReady: cloudGate.customGptReady,
      customGptDirectLocalExposureAllowed: cloudGate.customGptDirectLocalExposureAllowed,
      blockers: cloudGate.blockers,
    },
    releaseGate,
    phase6EntryCriteria,
    productionNoGoChecklist,
    failures,
  };

  if (write) writeReport(FINAL_READINESS_REPORT, report);
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
  const report = runPrivateServingFinalReadinessValidation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
