#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { DEFAULT_REGISTRY } from './baseline-registry.mjs';
import {
  DEFAULT_SMOKE_DIR,
  DEFAULT_SPEC_FACTS_FILE,
  REQUIRED_RUNTIME_SUPPORTS,
  assertRuntimeReportPath,
} from './effective-router-runtime.mjs';

export const DEFAULT_RELEASE_GATE_CI_REPORT =
  'local_artifacts/gptoss-runtime/release-gate-ci-report.json';

export const REQUIRED_PACKAGE_SCRIPTS = [
  'gptoss:baseline:regress',
  'gptoss:adapter:eval:effective-router:regress',
  'gptoss:runtime:request:regress',
  'gptoss:runtime:readiness',
  'gptoss:runtime:release-manifest',
  'gptoss:runtime:cloud-gate',
  'gptoss:runtime:release-gate',
  'gptoss:runtime:release-gate:ci',
];

export const REQUIRED_DOCS = [
  'docs/GPTOSS_LOCAL_RUNTIME.md',
  'docs/GPTOSS_RUNTIME_ARCHITECTURE.md',
];

export const REQUIRED_RUNTIME_SUPPORT_DECLARATIONS = [
  {
    label: 'force-final-channel',
    key: 'forceFinalChannel',
    flag: '--force-final-channel',
  },
  {
    label: 'router-classifier-mode',
    key: 'routerClassifierMode',
    flag: '--router-classifier-mode',
    baselineRequired: true,
  },
  {
    label: 'JSON prefill',
    key: 'prefillJsonStart',
    flag: '--prefill-json-start',
    baselineRequired: true,
  },
  {
    label: 'hard-policy-overrides',
    key: 'hardPolicyOverrides',
    flag: '--apply-hard-policy-overrides',
    baselineRequired: true,
  },
  {
    label: 'local-spec-facts',
    key: 'localSpecFacts',
    flag: '--use-local-spec-facts',
    baselineRequired: true,
  },
  {
    label: 'router-postprocessor',
    key: 'routerPostprocessor',
  },
];

const REQUIRED_MANIFEST_SCHEMA_FIELDS = [
  'schemaVersion',
  'kind',
  'releaseScope',
  'modelScore',
  'effectiveScore',
  'localControlledRuntimeReady',
  'modelOnlyReady',
  'cloudReady',
  'customGptReady',
  'baselineRegistryPath',
  'requiredRuntimeSupports',
  'requiredRuntimeFlags',
  'paths',
  'requestStatus',
  'safetyConfirmations',
  'safety',
];

const CLEAN_FALSE_FLAGS = [
  'allowedForTraining',
  'openAiCalled',
  'trainingExecuted',
  'vllmUsed',
  'railwayCliUsed',
  'liveDbUsed',
];

const CLEAN_TRUE_FLAGS = ['noOpenAiOutputUsed'];
const CLOUD_EXPOSURE_FLAGS = [
  'cloudReady',
  'customGptReady',
  'customGptDirectLocalExposureAllowed',
  'customGptExposureEnabled',
  'publicServerCreated',
];

const CI_SCRIPT_FORBIDDEN_PATTERN =
  /api\.openai\.com|openai\s|railway\s+up|railway\s+(status|logs|link|whoami)|--allow-network|(^|\s)--execute(\s|$)|unsloth|train|vllm|db:schema:apply|DATABASE_URL|start-server|npm run (dev|start)\b/i;

const DEFAULT_REQUEST_SMOKE_DIR = 'examples/gptoss/runtime-request-smoke';
const DEFAULT_SCHEMA_PATH = 'schemas/gptoss-effective-router-runtime.schema.json';
const DEFAULT_PACKAGE_PATH = 'package.json';
const MODEL_READY_THRESHOLD_PASSED = 20;

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}:${detail}` : code);
}

function toDisplayPath(path) {
  return String(path ?? '').replace(/\\/g, '/');
}

function readJson(root, path, failures, label) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) {
    pushFailure(failures, 'missing_json_file', label ?? path);
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    pushFailure(
      failures,
      'invalid_json_file',
      `${label ?? path}:${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function listJsonFiles(root, dir, failures) {
  const fullDir = resolve(root, dir);
  if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) {
    pushFailure(failures, 'missing_fixture_dir', dir);
    return [];
  }

  const files = readdirSync(fullDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));

  if (files.length === 0) {
    pushFailure(failures, 'fixture_dir_empty', dir);
  }

  return files;
}

function collectObjects(value, visit) {
  if (!value || typeof value !== 'object') {
    return;
  }

  visit(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjects(item, visit);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectObjects(item, visit);
  }
}

function scoreString(score) {
  if (!score || typeof score !== 'object') {
    return null;
  }

  const passed = Number(score.passed);
  const records = Number(score.records);
  if (!Number.isFinite(passed) || !Number.isFinite(records)) {
    return null;
  }
  return `${passed}/${records}`;
}

function currentBaseline(registry, failures) {
  const current = registry?.current;
  const baselines = Array.isArray(registry?.baselines) ? registry.baselines : [];
  const baseline = baselines.find((entry) => entry?.id === current);
  if (!baseline) {
    pushFailure(failures, 'missing_current_baseline', String(current ?? 'undefined'));
  }
  return baseline;
}

function validatePackageScripts(packageJson, failures) {
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== 'object') {
    pushFailure(failures, 'package_scripts_missing');
    return false;
  }

  for (const script of REQUIRED_PACKAGE_SCRIPTS) {
    if (typeof scripts[script] !== 'string' || !scripts[script].trim()) {
      pushFailure(failures, 'package_script_missing', script);
    }
  }

  const ciScript = scripts['gptoss:runtime:release-gate:ci'];
  if (typeof ciScript === 'string') {
    if (!ciScript.includes('scripts/gptoss/runtime-release-gate-ci.mjs')) {
      pushFailure(failures, 'ci_package_script_wrong_target', ciScript);
    }
    if (CI_SCRIPT_FORBIDDEN_PATTERN.test(ciScript)) {
      pushFailure(failures, 'ci_package_script_unsafe', ciScript);
    }
  }

  return REQUIRED_PACKAGE_SCRIPTS.every((script) => typeof scripts[script] === 'string');
}

function validateRuntimeSupportsInSchema(schema, failures) {
  const runtimeSupports = schema?.$defs?.runtimeSupports;
  if (!runtimeSupports || typeof runtimeSupports !== 'object') {
    pushFailure(failures, 'runtime_support_schema_missing');
    return false;
  }

  const required = Array.isArray(runtimeSupports.required) ? runtimeSupports.required : [];
  const properties = runtimeSupports.properties ?? {};
  let ok = true;

  for (const support of REQUIRED_RUNTIME_SUPPORT_DECLARATIONS) {
    if (!required.includes(support.key)) {
      pushFailure(failures, 'runtime_support_schema_required_missing', support.label);
      ok = false;
    }
    if (properties?.[support.key]?.const !== true) {
      pushFailure(failures, 'runtime_support_schema_const_missing', support.label);
      ok = false;
    }
  }

  return ok;
}

function validateReleaseManifestSchema(schema, failures) {
  const releaseManifest = schema?.$defs?.releaseManifest;
  if (!releaseManifest || typeof releaseManifest !== 'object') {
    pushFailure(failures, 'release_manifest_schema_missing');
    return false;
  }

  const required = Array.isArray(releaseManifest.required) ? releaseManifest.required : [];
  const properties = releaseManifest.properties ?? {};
  let ok = true;

  for (const field of REQUIRED_MANIFEST_SCHEMA_FIELDS) {
    if (!required.includes(field)) {
      pushFailure(failures, 'release_manifest_schema_required_missing', field);
      ok = false;
    }
  }

  if (properties.kind?.const !== 'gptoss_effective_router_runtime_release_manifest') {
    pushFailure(failures, 'release_manifest_schema_kind_missing');
    ok = false;
  }
  if (properties.releaseScope?.const !== 'local_controlled_runtime_only') {
    pushFailure(failures, 'release_manifest_schema_scope_missing');
    ok = false;
  }
  if (properties.cloudReady?.const !== false) {
    pushFailure(failures, 'release_manifest_schema_cloud_ready_not_false');
    ok = false;
  }
  if (properties.customGptReady?.const !== false) {
    pushFailure(failures, 'release_manifest_schema_custom_gpt_ready_not_false');
    ok = false;
  }
  if (properties.requiredRuntimeSupports?.$ref !== '#/$defs/runtimeSupports') {
    pushFailure(failures, 'release_manifest_schema_runtime_support_ref_missing');
    ok = false;
  }

  return ok;
}

function validateRuntimeSupportsDeclaration(failures) {
  let ok = true;
  for (const support of REQUIRED_RUNTIME_SUPPORT_DECLARATIONS) {
    if (REQUIRED_RUNTIME_SUPPORTS[support.key] !== true) {
      pushFailure(failures, 'runtime_support_declaration_missing', support.label);
      ok = false;
    }
  }
  return ok;
}

function validateNoTrackedCloudExposure(value, failures, label) {
  collectObjects(value, (object) => {
    for (const flag of CLOUD_EXPOSURE_FLAGS) {
      if (object[flag] === true) {
        pushFailure(failures, 'tracked_cloud_or_custom_gpt_ready_true', `${label}.${flag}`);
      }
    }
  });
}

function validateBaselineRegistry(registry, failures) {
  if (!registry || typeof registry !== 'object') {
    pushFailure(failures, 'baseline_registry_missing');
    return undefined;
  }

  if (registry.kind !== 'gptoss_baseline_registry') {
    pushFailure(failures, 'baseline_registry_kind_unexpected', String(registry.kind));
  }

  const baseline = currentBaseline(registry, failures);
  if (!baseline) {
    return undefined;
  }

  const modelScore = scoreString(baseline.modelScore);
  const effectiveScore = scoreString(baseline.effectiveScore);
  if (modelScore !== '11/24') {
    pushFailure(failures, 'baseline_model_score_unexpected', modelScore ?? 'missing');
  }
  if (effectiveScore !== '24/24') {
    pushFailure(failures, 'baseline_effective_score_unexpected', effectiveScore ?? 'missing');
  }

  const requiredFlags = Array.isArray(baseline.requiredRuntimeFlags)
    ? baseline.requiredRuntimeFlags
    : [];
  for (const support of REQUIRED_RUNTIME_SUPPORT_DECLARATIONS) {
    if (support.baselineRequired && !requiredFlags.includes(support.flag)) {
      pushFailure(failures, 'baseline_required_runtime_flag_missing', support.label);
    }
  }

  const diagnosticModes = baseline.requiredDiagnosticModes ?? {};
  const diagnosticModeKeys = {
    '--router-classifier-mode': 'routerClassifierMode',
    '--prefill-json-start': 'prefillJsonStart',
    '--apply-hard-policy-overrides': 'applyHardPolicyOverrides',
    '--use-local-spec-facts': 'useLocalSpecFacts',
  };
  for (const support of REQUIRED_RUNTIME_SUPPORT_DECLARATIONS) {
    if (!support.baselineRequired) {
      continue;
    }
    const modeKey = diagnosticModeKeys[support.flag];
    if (diagnosticModes[modeKey] !== true) {
      pushFailure(failures, 'baseline_required_diagnostic_mode_missing', support.label);
    }
  }

  const safety = baseline.safetyFlags ?? {};
  for (const flag of CLEAN_FALSE_FLAGS) {
    if (safety[flag] !== false) {
      pushFailure(failures, 'baseline_safety_flag_not_false', flag);
    }
  }
  for (const flag of CLEAN_TRUE_FLAGS) {
    if (safety[flag] !== true) {
      pushFailure(failures, 'baseline_safety_flag_not_true', flag);
    }
  }

  return {
    baselineId: baseline.id,
    modelScore,
    effectiveScore,
    modelOnlyReady: Number(baseline.modelScore?.passed) >= MODEL_READY_THRESHOLD_PASSED,
    localControlledRuntimeReady: effectiveScore === '24/24',
  };
}

function validateRuntimeRequest(raw, failures, label) {
  const request = raw?.request && typeof raw.request === 'object' ? raw.request : raw;
  if (!request || typeof request !== 'object') {
    pushFailure(failures, 'runtime_fixture_request_missing', label);
    return;
  }
  if (!String(request.requestId ?? '').trim()) {
    pushFailure(failures, 'runtime_fixture_request_id_missing', label);
  }
  if (!String(request.userInput ?? '').trim()) {
    pushFailure(failures, 'runtime_fixture_user_input_missing', label);
  }
  if ((request.mode ?? 'router_classifier') !== 'router_classifier') {
    pushFailure(failures, 'runtime_fixture_mode_unexpected', label);
  }

  const supports = request.runtimeSupports ?? {};
  for (const support of REQUIRED_RUNTIME_SUPPORT_DECLARATIONS) {
    if (supports[support.key] !== true) {
      pushFailure(failures, 'runtime_fixture_support_missing', `${label}.${support.label}`);
    }
  }
}

function validateFixtureDir(root, dir, failures) {
  const files = listJsonFiles(root, dir, failures);
  for (const file of files) {
    const parsed = readJson(root, file, failures, file);
    if (parsed) {
      validateRuntimeRequest(parsed, failures, file);
      validateNoTrackedCloudExposure(parsed, failures, file);
    }
  }
  return files.length;
}

function validateLocalSpecFacts(specFacts, failures) {
  const facts = Array.isArray(specFacts?.facts) ? specFacts.facts : [];
  if (facts.length === 0) {
    pushFailure(failures, 'local_spec_facts_empty');
    return false;
  }

  for (const fact of facts) {
    if (!String(fact?.id ?? '').trim()) {
      pushFailure(failures, 'local_spec_fact_id_missing');
    }
    if (!Array.isArray(fact?.aliases) || fact.aliases.length === 0) {
      pushFailure(failures, 'local_spec_fact_aliases_missing', String(fact?.id ?? 'unknown'));
    }
    if (!String(fact?.value ?? '').trim()) {
      pushFailure(failures, 'local_spec_fact_value_missing', String(fact?.id ?? 'unknown'));
    }
    if (!String(fact?.source ?? '').trim()) {
      pushFailure(failures, 'local_spec_fact_source_missing', String(fact?.id ?? 'unknown'));
    }
  }

  validateNoTrackedCloudExposure(specFacts, failures, 'local_spec_facts');
  return facts.length > 0;
}

function validateDocs(root, failures) {
  let ok = true;
  for (const doc of REQUIRED_DOCS) {
    const fullPath = resolve(root, doc);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      pushFailure(failures, 'doc_missing', doc);
      ok = false;
    }
  }
  return ok;
}

function shouldWriteReport({ ci, write }) {
  if (write === false) {
    return false;
  }
  if (write === true) {
    return !ci;
  }
  return !ci;
}

function writeReport(root, outputPath, report) {
  assertRuntimeReportPath(outputPath);
  const fullPath = resolve(root, outputPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function runReleaseGateCi({
  repoRoot = process.cwd(),
  packagePath = DEFAULT_PACKAGE_PATH,
  schemaPath = DEFAULT_SCHEMA_PATH,
  registryPath = DEFAULT_REGISTRY,
  specFactsPath = DEFAULT_SPEC_FACTS_FILE,
  smokeDir = DEFAULT_SMOKE_DIR,
  requestSmokeDir = DEFAULT_REQUEST_SMOKE_DIR,
  outputPath = DEFAULT_RELEASE_GATE_CI_REPORT,
  ci = Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
  write,
} = {}) {
  const root = resolve(repoRoot);
  const failures = [];

  const packageJson = readJson(root, packagePath, failures, 'package_json');
  const schema = readJson(root, schemaPath, failures, 'runtime_schema');
  const registry = readJson(root, registryPath, failures, 'baseline_registry');
  const specFacts = readJson(root, specFactsPath, failures, 'local_spec_facts');

  const checks = {
    packageScriptsExist: packageJson ? validatePackageScripts(packageJson, failures) : false,
    runtimeSchemaParses: Boolean(schema),
    runtimeSupportsDeclared: schema ? validateRuntimeSupportsInSchema(schema, failures) : false,
    runtimeSupportCodeDeclared: validateRuntimeSupportsDeclaration(failures),
    releaseManifestSchemaExpectationsExist: schema
      ? validateReleaseManifestSchema(schema, failures)
      : false,
    baselineRegistryParses: Boolean(registry),
    baselineMetadataStable: false,
    runtimeSmokeFixturesParse: false,
    runtimeRequestSmokeFixturesParse: false,
    localSpecFactsParse: specFacts ? validateLocalSpecFacts(specFacts, failures) : false,
    docsExist: validateDocs(root, failures),
    cloudAndCustomGptReadinessFalse: true,
    noExternalOperationsRequired: true,
    adapterFilesRequired: false,
  };

  const baseline = registry ? validateBaselineRegistry(registry, failures) : undefined;
  checks.baselineMetadataStable = Boolean(
    baseline &&
      baseline.modelScore === '11/24' &&
      baseline.effectiveScore === '24/24',
  );

  checks.runtimeSmokeFixturesParse = validateFixtureDir(root, smokeDir, failures) > 0;
  checks.runtimeRequestSmokeFixturesParse = validateFixtureDir(root, requestSmokeDir, failures) > 0;

  if (schema) {
    validateNoTrackedCloudExposure(schema, failures, 'runtime_schema');
  }
  if (registry) {
    validateNoTrackedCloudExposure(registry, failures, 'baseline_registry');
  }

  checks.cloudAndCustomGptReadinessFalse = !failures.some((failure) =>
    failure.startsWith('tracked_cloud_or_custom_gpt_ready_true') ||
    failure.startsWith('release_manifest_schema_cloud_ready_not_false') ||
    failure.startsWith('release_manifest_schema_custom_gpt_ready_not_false')
  );

  const ok = failures.length === 0;
  const report = {
    schemaVersion: 1,
    kind: 'gptoss_runtime_release_gate_ci_report',
    ok,
    mode: 'ci_safe_static_release_gate',
    generatedAt: new Date().toISOString(),
    modelScore: baseline?.modelScore ?? null,
    effectiveScore: baseline?.effectiveScore ?? null,
    localControlledRuntimeReady: baseline?.localControlledRuntimeReady === true,
    modelOnlyReady: baseline?.modelOnlyReady === true,
    cloudReady: false,
    customGptReady: false,
    customGptDirectLocalExposureAllowed: false,
    failures,
    checks,
    requiredPackageScripts: REQUIRED_PACKAGE_SCRIPTS,
    requiredRuntimeSupports: Object.fromEntries(
      REQUIRED_RUNTIME_SUPPORT_DECLARATIONS.map((support) => [support.label, true]),
    ),
    checkedPaths: {
      packageJson: toDisplayPath(packagePath),
      runtimeSchema: toDisplayPath(schemaPath),
      baselineRegistry: toDisplayPath(registryPath),
      runtimeSmokeFixtures: toDisplayPath(smokeDir),
      runtimeRequestSmokeFixtures: toDisplayPath(requestSmokeDir),
      localSpecFacts: toDisplayPath(specFactsPath),
      docs: REQUIRED_DOCS.map(toDisplayPath),
    },
    localOnlyChecksSkipped: [
      'local_artifacts directory presence',
      'adapter files',
      'model weights',
      'CUDA',
      'WSL',
      'OpenAI key',
      'Railway auth',
      'DATABASE_URL',
      'vLLM serving',
      'live DB connection',
      'local server startup',
      'Custom GPT exposure',
    ],
    safetyConfirmations: {
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
      adapterFilesRequired: false,
      modelWeightsRequired: false,
      localArtifactsRequired: false,
      cudaRequired: false,
      wslRequired: false,
      openAiKeyRequired: false,
      railwayAuthRequired: false,
      databaseUrlRequired: false,
      serverCreated: false,
      publicServerCreated: false,
      customGptExposureEnabled: false,
    },
    ciMode: ci,
    reportWritten: false,
    reportPath: null,
  };

  if (shouldWriteReport({ ci, write })) {
    report.reportWritten = true;
    report.reportPath = outputPath;
    writeReport(root, outputPath, report);
  }

  return report;
}

function parseArgs(argv = []) {
  const options = {
    ci: undefined,
    write: undefined,
    outputPath: DEFAULT_RELEASE_GATE_CI_REPORT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--ci') {
      options.ci = true;
    } else if (flag === '--no-write') {
      options.write = false;
    } else if (flag === '--output' && next) {
      options.outputPath = next;
      index += 1;
    } else if (flag === '--package' && next) {
      options.packagePath = next;
      index += 1;
    } else if (flag === '--schema' && next) {
      options.schemaPath = next;
      index += 1;
    } else if (flag === '--registry' && next) {
      options.registryPath = next;
      index += 1;
    } else if (flag === '--spec-facts' && next) {
      options.specFactsPath = next;
      index += 1;
    } else if (flag === '--smoke-dir' && next) {
      options.smokeDir = next;
      index += 1;
    } else if (flag === '--request-smoke-dir' && next) {
      options.requestSmokeDir = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  return options;
}

function main() {
  try {
    const report = runReleaseGateCi(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const report = {
      schemaVersion: 1,
      kind: 'gptoss_runtime_release_gate_ci_report',
      ok: false,
      mode: 'ci_safe_static_release_gate',
      cloudReady: false,
      customGptReady: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
      failures: [`release_gate_ci_exception:${error instanceof Error ? error.message : String(error)}`],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
