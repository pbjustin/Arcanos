#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildCloudGate } from './cloud-readiness-gate.mjs';
import { assertRuntimeReportPath } from './effective-router-runtime.mjs';
import { buildReadinessReport } from './model-readiness-report.mjs';

export const PRIVATE_SERVING_SCHEMA = 'schemas/gptoss-private-serving-boundary.schema.json';
export const PRIVATE_SERVING_DOCS = [
  'docs/GPTOSS_PRIVATE_SERVING_BOUNDARY.md',
  'docs/GPTOSS_PRIVATE_ENDPOINT_CONTRACT.md',
  'docs/GPTOSS_PRIVATE_SERVING_THREAT_MODEL.md',
  'docs/GPTOSS_PRIVATE_SERVING_RUNBOOK.md',
];
export const PRIVATE_SERVING_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-design-report.json';

export const FORBIDDEN_ENDPOINT_MARKERS = [
  '/v1/chat/completions public clone',
  'raw completion endpoint',
  'arbitrary shell endpoint',
  'Railway command endpoint',
  'DB query endpoint',
  'training endpoint',
  'Custom GPT direct action endpoint',
  'public unauthenticated endpoint',
];

const ALLOWED_PRIVATE_ENDPOINTS = [
  'POST /private/gptoss/effective-router/classify',
  'POST /private/gptoss/effective-router/replay',
  'GET /private/gptoss/effective-router/readiness',
  'GET /private/gptoss/effective-router/release-gate',
];

const REQUIRED_PACKAGE_SCRIPTS = [
  'gptoss:private-serving:design:validate',
  'gptoss:private-serving:threat-model:validate',
];

const FORBIDDEN_PACKAGE_SCRIPT_NAMES = [
  'gptoss:private-serving:start',
  'gptoss:private-serving:serve',
  'gptoss:private-serving:listen',
  'gptoss:private-serving:deploy',
  'gptoss:private-serving:custom-gpt',
];

const FORBIDDEN_SCRIPT_PATTERN =
  /api\.openai\.com|railway\s+up|railway\s+(status|logs|link|whoami)|--allow-network|(^|\s)--execute(\s|$)|unsloth|train\s|vllm|db:schema:apply|DATABASE_URL|start-server|listen\b|custom-gpt/i;

const SECRET_PATTERN =
  /sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|postgres:\/\/|redis:\/\/|session_id=|railway[_-]?token\s*[:=]|openai[_-]?api[_-]?key\s*[:=]/i;

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}:${detail}` : code);
}

function readJson(path, failures, label = path) {
  if (!existsSync(path)) {
    pushFailure(failures, 'missing_json_file', label);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    pushFailure(
      failures,
      'invalid_json_file',
      `${label}:${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function readText(path, failures, label = path) {
  if (!existsSync(path)) {
    pushFailure(failures, 'missing_doc', label);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function schemaHasDefs(schema, failures) {
  const defs = schema?.$defs ?? {};
  const requiredDefs = [
    'signedRequestEnvelope',
    'responseEnvelope',
    'safetyFlags',
    'auditMetadata',
    'replayMetadata',
    'denialResponse',
    'rateLimitResponse',
    'authFailureResponse',
  ];
  for (const name of requiredDefs) {
    if (!defs[name]) {
      pushFailure(failures, 'private_serving_schema_def_missing', name);
    }
  }

  const request = defs.signedRequestEnvelope;
  const input = request?.properties?.input;
  if (request?.properties?.audience?.const !== 'gptoss-effective-router-private') {
    pushFailure(failures, 'private_serving_schema_audience_missing');
  }
  if (input?.properties?.mode?.const !== 'router_classifier') {
    pushFailure(failures, 'private_serving_schema_mode_missing');
  }
  const readiness = defs.readinessFlags;
  if (readiness?.properties?.privateServingDesignReady?.const !== true) {
    pushFailure(failures, 'private_serving_readiness_design_ready_missing');
  }
  if (readiness?.properties?.privateServingImplemented?.const !== false) {
    pushFailure(failures, 'private_serving_readiness_implemented_not_false');
  }
  if (readiness?.properties?.privateServingExposed?.const !== false) {
    pushFailure(failures, 'private_serving_readiness_exposed_not_false');
  }
  if (readiness?.properties?.requestSigningDesigned?.const !== true) {
    pushFailure(failures, 'private_serving_readiness_request_signing_designed_missing');
  }
  if (readiness?.properties?.requestSigningImplemented?.const !== false) {
    pushFailure(failures, 'private_serving_readiness_request_signing_not_false');
  }
  if (readiness?.properties?.authBoundaryDesigned?.const !== true) {
    pushFailure(failures, 'private_serving_readiness_auth_boundary_designed_missing');
  }
  if (readiness?.properties?.authBoundaryImplemented?.const !== false) {
    pushFailure(failures, 'private_serving_readiness_auth_boundary_not_false');
  }
  if (readiness?.properties?.publicServerCreated?.const !== false) {
    pushFailure(failures, 'private_serving_response_public_server_not_false');
  }
  if (readiness?.properties?.cloudReady?.const !== false) {
    pushFailure(failures, 'private_serving_response_cloud_ready_not_false');
  }
  if (readiness?.properties?.customGptReady?.const !== false) {
    pushFailure(failures, 'private_serving_response_custom_gpt_ready_not_false');
  }

  const effective = defs.effectiveResult;
  for (const field of [
    'plane',
    'action',
    'risk',
    'requiresConfirmation',
    'allowedForTraining',
    'sources',
  ]) {
    if (!effective?.required?.includes(field)) {
      pushFailure(failures, 'private_serving_effective_field_missing', field);
    }
  }
  const safety = defs.safetyFlags;
  for (const field of [
    'openAiCalled',
    'trainingExecuted',
    'vllmUsed',
    'railwayCliUsed',
    'liveDbUsed',
    'noOpenAiOutputUsed',
  ]) {
    if (!safety?.required?.includes(field)) {
      pushFailure(failures, 'private_serving_safety_field_missing', field);
    }
  }
}

function validateEndpointContract(text, failures) {
  for (const endpoint of ALLOWED_PRIVATE_ENDPOINTS) {
    if (!text.includes(endpoint)) {
      pushFailure(failures, 'allowed_private_endpoint_missing', endpoint);
    }
  }
  for (const marker of FORBIDDEN_ENDPOINT_MARKERS) {
    if (!text.includes(marker)) {
      pushFailure(failures, 'forbidden_endpoint_marker_missing', marker);
    }
  }
  if (!/private-only/i.test(text) || !/authenticated/i.test(text)) {
    pushFailure(failures, 'endpoint_contract_private_auth_missing');
  }
}

function validateDocs(failures) {
  const docs = {};
  for (const path of PRIVATE_SERVING_DOCS) {
    const text = readText(path, failures);
    docs[path] = text;
    if (SECRET_PATTERN.test(text)) {
      pushFailure(failures, 'doc_secret_pattern_detected', path);
    }
  }

  validateEndpointContract(docs['docs/GPTOSS_PRIVATE_ENDPOINT_CONTRACT.md'] ?? '', failures);

  const boundary = docs['docs/GPTOSS_PRIVATE_SERVING_BOUNDARY.md'] ?? '';
  for (const term of [
    'private-only',
    'request-signed',
    'rate-limited',
    'audited',
    'replayable',
    'fail-closed',
    'Only effective-router contract output may be exposed',
    'Raw model text may be logged only as capped/redacted preview in local audit artifacts',
  ]) {
    if (!boundary.includes(term)) {
      pushFailure(failures, 'boundary_term_missing', term);
    }
  }

  return docs;
}

function validatePackageScripts(failures) {
  const packageJson = readJson('package.json', failures, 'package_json');
  const scripts = packageJson?.scripts ?? {};
  for (const name of REQUIRED_PACKAGE_SCRIPTS) {
    if (typeof scripts[name] !== 'string') {
      pushFailure(failures, 'package_script_missing', name);
      continue;
    }
    if (FORBIDDEN_SCRIPT_PATTERN.test(scripts[name])) {
      pushFailure(failures, 'package_script_unsafe', name);
    }
  }

  for (const name of FORBIDDEN_PACKAGE_SCRIPT_NAMES) {
    if (scripts[name]) {
      pushFailure(failures, 'forbidden_private_serving_script_present', name);
    }
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (
      name.startsWith('gptoss:private-serving:') &&
      /start|serve|listen|deploy|custom-gpt/i.test(name)
    ) {
      pushFailure(failures, 'forbidden_private_serving_script_present', name);
    }
    if (
      name.startsWith('gptoss:private-serving:') &&
      FORBIDDEN_SCRIPT_PATTERN.test(String(command))
    ) {
      pushFailure(failures, 'private_serving_script_unsafe', name);
    }
  }
}

function validateNoServerFiles(failures) {
  const scriptDir = 'scripts/gptoss';
  const names = readdirSync(scriptDir)
    .map((name) => join(scriptDir, name))
    .filter((path) => statSync(path).isFile());
  const forbidden = names.filter((path) =>
    /private-serving.*(server|serve|listen)|server.*private-serving/i.test(path),
  );
  for (const path of forbidden) {
    pushFailure(failures, 'private_serving_server_file_present', path.replace(/\\/g, '/'));
  }
}

function validateReadiness(failures) {
  const readiness = buildReadinessReport();
  const expected = {
    privateServingDesignReady: true,
    privateServingImplemented: false,
    privateServingExposed: false,
    requestSigningDesigned: true,
    requestSigningImplemented: false,
    authBoundaryDesigned: true,
    authBoundaryImplemented: false,
    publicServerCreated: false,
    customGptExposureCreated: false,
    cloudReady: false,
    customGptReady: false,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (readiness[key] !== expectedValue) {
      pushFailure(failures, 'readiness_field_unexpected', `${key}=${readiness[key]}`);
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

export function runPrivateServingDesignValidation({
  schemaPath = PRIVATE_SERVING_SCHEMA,
  output = PRIVATE_SERVING_REPORT,
  write = true,
} = {}) {
  const failures = [];
  const schema = readJson(schemaPath, failures, 'private_serving_schema');
  if (schema) {
    schemaHasDefs(schema, failures);
  }
  validateDocs(failures);
  validatePackageScripts(failures);
  validateNoServerFiles(failures);
  const { readiness } = validateReadiness(failures);

  const report = {
    ok: failures.length === 0,
    privateServingDesignReady: readiness.privateServingDesignReady === true,
    privateServingImplemented: readiness.privateServingImplemented === true,
    privateServingExposed: readiness.privateServingExposed === true,
    cloudReady: false,
    customGptReady: false,
    publicServerCreated: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    noOpenAiOutputUsed: true,
    failures,
    docs: PRIVATE_SERVING_DOCS,
    schemas: [schemaPath],
    tests: ['tests/gptoss-private-serving-design.test.ts'],
    validation: {
      forbiddenEndpointsChecked: FORBIDDEN_ENDPOINT_MARKERS,
      allowedPrivateEndpointsChecked: ALLOWED_PRIVATE_ENDPOINTS,
      noServerFilesAdded: !failures.some((failure) =>
        failure.startsWith('private_serving_server_file_present'),
      ),
    },
  };

  if (write) {
    writeReport(output, report);
  }

  return report;
}

function main() {
  const report = runPrivateServingDesignValidation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
