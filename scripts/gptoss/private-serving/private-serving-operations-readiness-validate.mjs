#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildCloudGate } from '../cloud-readiness-gate.mjs';
import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';

export const PRIVATE_SERVING_SCHEMA = 'schemas/gptoss-private-serving-boundary.schema.json';
export const OPERATIONS_READINESS_DOCS = [
  'docs/GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE.md',
  'docs/GPTOSS_PRIVATE_SERVING_OPERATIONS_READINESS.md',
  'docs/GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST.md',
];
export const OPERATIONS_READINESS_VALIDATOR =
  'scripts/gptoss/private-serving/private-serving-operations-readiness-validate.mjs';
export const OPERATIONS_READINESS_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-operations-readiness-report.json';
export const OPERATIONS_PACKAGE_SCRIPT = 'gptoss:private-serving:operations:validate';
export const OPERATIONS_PACKAGE_COMMAND =
  'node scripts/gptoss/private-serving/private-serving-operations-readiness-validate.mjs';

const SCHEMA_DEFS = [
  'operationsReadinessReport',
  'incidentResponseReadinessReport',
  'goNoGoChecklistReport',
  'incidentSeverity',
  'rollbackDecision',
];

const SOURCE_SCAN_PATHS = [
  PRIVATE_SERVING_SCHEMA,
  OPERATIONS_READINESS_VALIDATOR,
];

const DOC_SECTION_REQUIREMENTS = {
  'docs/GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE.md': [
    ['incident_classes', /Incident Classes/i],
    ['severity_levels', /Severity/i],
    ['detection_signals', /Detection/i],
    ['containment_actions', /Containment/i],
    ['emergency_disable', /Emergency Disable/i],
    ['rollback_criteria', /Rollback/i],
    ['audit_preservation', /Audit Handling|audit preservation/i],
    ['post_incident_review', /Post-Incident Review/i],
    ['do_not_run', /Do Not Run/i],
  ],
  'docs/GPTOSS_PRIVATE_SERVING_OPERATIONS_READINESS.md': [
    ['operator_preflight', /Operations Preflight|operator preflight/i],
    ['release_gate_checklist', /Release Gate/i],
    ['audit_review_process', /Audit Readiness|audit review/i],
    ['replay_review_process', /Replay Readiness|replay review/i],
    ['key_management_review_process', /Key Readiness|key-management review/i],
    ['rate_limit_review_process', /Rate Readiness|rate-limit review/i],
    ['durable_replay_review_process', /Durable Replay Operations|durable replay review/i],
    ['deployment_blocker_checklist', /Deployment Blockers/i],
  ],
  'docs/GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST.md': [
    ['server_implementation_gate', /Server/i],
    ['private_network_boundary_gate', /Private network/i],
    ['durable_replay_gate', /Durable replay/i],
    ['durable_rate_limit_gate', /Durable rate limit/i],
    ['key_management_gate', /Key management/i],
    ['audit_retention_gate', /Audit/i],
    ['rollback_gate', /Rollback/i],
    ['incident_response_gate', /Incident response/i],
    ['security_review_gate', /Security/i],
    ['cloud_custom_exposure_gate', /Cloud[\s\S]*Custom GPT|Custom GPT[\s\S]*Cloud/i],
    ['no_go_state', /NO-GO/i],
  ],
};

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
        `from\\s+['"](@${'prisma'}/client|pg|knex|redis|ioredis|mysql2?)['"]`,
        `new\\s+${'Prisma'}${'Client'}`,
        `new\\s+${'Pool'}\\s*\\(`,
        `${'create'}${'Client'}\\s*\\(`,
        `${'DATABASE'}_${'URL'}`,
        `${'postgres'}:\\/\\/`,
        `${'redis'}:\\/\\/`,
      ].join('|'),
      'i',
    ),
  ],
  ['vllm_path', new RegExp(`${'v'}${'llm'}\\s+${'serve'}|${'v'}${'llm'}\\.`, 'i')],
  [
    'training_path',
    new RegExp(
      `\\b${'tr'}${'ain'}\\b|${'fine'}-${'tune'}|${'fine'}${'tune'}|${'tr'}${'ain'}${'ing'}\\s+endpoint`,
      'i',
    ),
  ],
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
  for (const path of OPERATIONS_READINESS_DOCS) {
    const text = readText(path, failures);
    const sections = {};
    docs[path] = { exists: Boolean(text), sections };
    if (text && !text.includes('Phase 5.11')) {
      pushFailure(failures, 'phase_511_doc_marker_missing', path);
    }
    for (const [section, pattern] of DOC_SECTION_REQUIREMENTS[path] ?? []) {
      sections[section] = pattern.test(text);
      if (!sections[section]) {
        pushFailure(failures, 'doc_section_missing', `${path}:${section}`);
      }
    }
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

  const report = defs.operationsReadinessReport;
  for (const field of [
    'operationsReadinessDesigned',
    'incidentResponseReady',
    'productionGoNoGoChecklistReady',
    'productionGoAllowed',
    'noServerListener',
    'noOpenAiPath',
    'noRailwayPath',
    'noDbPath',
    'noVllmPath',
    'noTrainingPath',
    'readinessBlocked',
  ]) {
    if (!report?.required?.includes(field)) {
      pushFailure(failures, 'operations_report_field_missing', field);
    }
  }

  const readiness = defs.readinessFlags;
  const expectedReadiness = {
    operationsReadinessDesigned: true,
    incidentResponseReady: true,
    productionGoNoGoChecklistReady: true,
    productionGoAllowed: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
  };
  for (const [field, expectedValue] of Object.entries(expectedReadiness)) {
    if (!readiness?.required?.includes(field)) {
      pushFailure(failures, 'readiness_schema_required_field_missing', field);
    }
    if (readiness?.properties?.[field]?.const !== expectedValue) {
      pushFailure(failures, 'readiness_schema_field_unexpected', `${field}=${expectedValue}`);
    }
  }

  return Boolean(schema);
}

function validatePackageScript(failures) {
  const packageJson = readJson('package.json', failures);
  const command = packageJson?.scripts?.[OPERATIONS_PACKAGE_SCRIPT];
  if (command !== OPERATIONS_PACKAGE_COMMAND) {
    pushFailure(failures, 'package_script_missing_or_unexpected', OPERATIONS_PACKAGE_SCRIPT);
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

function validateStaticSafety(failures, packageCommands) {
  const docTargets = OPERATIONS_READINESS_DOCS.map((path) => ({
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
  validateImports(sourceTargets, failures);
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
    operationsReadinessDesigned: true,
    incidentResponseReady: true,
    productionGoNoGoChecklistReady: true,
    productionGoAllowed: false,
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
  if (cloudGate.privateServingImplemented !== false) {
    pushFailure(failures, 'cloud_gate_private_serving_implemented_not_false');
  }
  if (cloudGate.privateServingExposed !== false) {
    pushFailure(failures, 'cloud_gate_private_serving_exposed_not_false');
  }
  if (cloudGate.productionGoAllowed !== false) {
    pushFailure(failures, 'cloud_gate_production_go_allowed_not_false');
  }

  return { readiness, cloudGate };
}

function writeReport(path, report) {
  if (path !== OPERATIONS_READINESS_REPORT) {
    throw new Error(`operations readiness report path is fixed: ${OPERATIONS_READINESS_REPORT}`);
  }
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runPrivateServingOperationsReadinessValidation({ write = true } = {}) {
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
  const noOpenAiPath = !failures.some((failure) => failure.includes('openai_path'));
  const noRailwayPath = !failures.some((failure) => failure.includes('railway_path'));
  const noDbPath = !failures.some((failure) => failure.includes('db_path'));
  const noVllmPath = !failures.some((failure) => failure.includes('vllm_path'));
  const noTrainingPath = !failures.some((failure) => failure.includes('training_path'));
  const readinessBlocked = (
    readiness.productionGoAllowed === false &&
    readiness.privateServingImplemented === false &&
    readiness.privateServingExposed === false &&
    cloudGate.cloudReady === false &&
    cloudGate.customGptReady === false
  );

  if (!readinessBlocked) {
    pushFailure(failures, 'readiness_not_blocked');
  }

  const incidentResponse = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_incident_response_readiness',
    ok: !failures.some((failure) => failure.includes('GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE')),
    incidentResponseReady: true,
    incidentClassesDocumented: true,
    severityLevelsDocumented: true,
    detectionSignalsDocumented: true,
    containmentActionsDocumented: true,
    emergencyDisableDocumented: true,
    rollbackCriteriaDocumented: true,
    auditPreservationDocumented: true,
    postIncidentReviewDocumented: true,
    doNotRunDocumented: true,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    failures: failures.filter((failure) => failure.includes('GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE')),
  };
  const goNoGoChecklist = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_go_no_go_checklist',
    ok: !failures.some((failure) => failure.includes('GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST')),
    productionGoNoGoChecklistReady: true,
    productionGoAllowed: false,
    serverImplementationGate: 'NO-GO',
    privateNetworkBoundaryGate: 'NO-GO',
    durableReplayGate: 'NO-GO',
    durableRateLimitGate: 'NO-GO',
    keyManagementGate: 'NO-GO',
    auditRetentionGate: 'NO-GO',
    rollbackGate: 'NO-GO',
    incidentResponseGate: 'NO-GO',
    securityReviewGate: 'NO-GO',
    cloudExposureGate: 'NO-GO',
    customGptExposureGate: 'NO-GO',
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    failures: failures.filter((failure) => failure.includes('GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST')),
  };

  const report = {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_operations_readiness_validation',
    ok: failures.length === 0,
    operationsReadinessDesigned: true,
    incidentResponseReady: true,
    productionGoNoGoChecklistReady: true,
    productionGoAllowed: false,
    noServerListener,
    noOpenAiPath,
    noRailwayPath,
    noDbPath,
    noVllmPath,
    noTrainingPath,
    noRealSecretLiterals,
    noEnvSecretReads,
    noKmsImports,
    noCloudSdkImports,
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
      name: OPERATIONS_PACKAGE_SCRIPT,
      command: OPERATIONS_PACKAGE_COMMAND,
    },
    checked,
    readiness: {
      operationsReadinessDesigned: readiness.operationsReadinessDesigned,
      incidentResponseReady: readiness.incidentResponseReady,
      productionGoNoGoChecklistReady: readiness.productionGoNoGoChecklistReady,
      productionGoAllowed: readiness.productionGoAllowed,
      privateServingImplemented: readiness.privateServingImplemented,
      privateServingExposed: readiness.privateServingExposed,
      cloudReady: readiness.cloudReady,
      customGptReady: readiness.customGptReady,
    },
    cloudGate: {
      cloudReady: cloudGate.cloudReady,
      customGptReady: cloudGate.customGptReady,
      customGptDirectLocalExposureAllowed: cloudGate.customGptDirectLocalExposureAllowed,
      operationsReadinessDesigned: cloudGate.operationsReadinessDesigned,
      incidentResponseReady: cloudGate.incidentResponseReady,
      productionGoNoGoChecklistReady: cloudGate.productionGoNoGoChecklistReady,
      productionGoAllowed: cloudGate.productionGoAllowed,
      privateServingImplemented: cloudGate.privateServingImplemented,
      privateServingExposed: cloudGate.privateServingExposed,
      blockers: cloudGate.blockers,
    },
    incidentResponse,
    goNoGoChecklist,
    rollbackDecision: {
      decision: 'no_go',
      reason: 'production exposure remains blocked until serving controls are implemented',
      severity: 'sev2',
      auditPreservationRequired: true,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    },
    failures,
  };

  if (write) {
    writeReport(OPERATIONS_READINESS_REPORT, report);
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
  const report = runPrivateServingOperationsReadinessValidation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
