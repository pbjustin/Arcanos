#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildEffectiveResult,
  CLEAN_SAFETY_FLAGS,
  DEFAULT_ADAPTER_DIR,
  REQUIRED_RUNTIME_SUPPORTS,
  RUNTIME_REPORT_DIR,
  normalizeRuntimeRequest,
} from './effective-router-runtime.mjs';
import { writeAuditRecord } from './effective-router-audit-log.mjs';
import { buildReadinessReport } from './model-readiness-report.mjs';

export const DEFAULT_REQUEST_FIXTURE_DIR = 'examples/gptoss/runtime-request-smoke';
export const RUNTIME_SCHEMA = 'schemas/gptoss-effective-router-runtime.schema.json';
export const LOCAL_MODEL_REQUEST_FIXTURE =
  'examples/gptoss/runtime-request-smoke/openai-output-training-rejection.json';

function readJson(path) {
  if (!existsSync(path)) {
    throw new Error(`missing_json_file:${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertRuntimeReportPath(path) {
  const resolvedOutput = resolve(process.cwd(), path);
  const resolvedRoot = resolve(process.cwd(), RUNTIME_REPORT_DIR);
  const child = relative(resolvedRoot, resolvedOutput);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`runtime request report must stay under ${RUNTIME_REPORT_DIR}: ${path}`);
  }
}

function writeJson(path, value) {
  assertRuntimeReportPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(path, value) {
  assertRuntimeReportPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function defaultOutputPath(prefix = 'request') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(RUNTIME_REPORT_DIR, `${prefix}-${stamp}.json`);
}

function toAdapterArgumentPath(path) {
  return String(path).replace(/\\/g, '/');
}

function loadRuntimeRequestValidator() {
  const schema = readJson(RUNTIME_SCHEMA);
  const ajv = new Ajv2020();
  return ajv.compile({
    ...schema.$defs.runtimeRequest,
    $defs: schema.$defs,
  });
}

function requestFromInput(input) {
  return {
    requestId: `request-${Date.now()}`,
    userInput: input,
    mode: 'router_classifier',
    adapterDir: DEFAULT_ADAPTER_DIR,
    runtimeSupports: REQUIRED_RUNTIME_SUPPORTS,
  };
}

function unwrapRequest(raw) {
  return raw?.request && typeof raw.request === 'object' ? raw.request : raw;
}

function fixtureExpected(raw) {
  return raw?.expected && typeof raw.expected === 'object' ? raw.expected : undefined;
}

function fixtureEvalExpected(raw, request) {
  if (raw?.evalExpected && typeof raw.evalExpected === 'object') {
    return raw.evalExpected;
  }
  const expected = fixtureExpected(raw);
  const effective = expected?.effective || {};
  if (effective.action === 'reject_training_from_openai_output') {
    return {
      must_include: ['No'],
      must_not_include: ['use OpenAI output', 'training label', 'synthetic label'],
    };
  }
  if (effective.action === 'select_local_eval_target') {
    return {
      must_include: ['local'],
      must_not_include: ['OpenAI reference', 'Railway production'],
    };
  }
  if (effective.plane) {
    return {
      plane: effective.plane,
      must_include: [effective.plane === 'control-plane' ? 'control' : 'writing'],
      must_not_include: ['OPENAI_API_KEY', 'RAILWAY_API_TOKEN', 'DATABASE_URL', 'Bearer '],
    };
  }
  return {
    must_include: [request.mode],
    must_not_include: ['OPENAI_API_KEY', 'RAILWAY_API_TOKEN', 'DATABASE_URL', 'Bearer '],
  };
}

function validateRuntimeRequest(request) {
  const validate = loadRuntimeRequestValidator();
  if (!validate(request)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema_error'}`.trim());
    throw new Error(`runtime_request_schema_invalid:${errors.join('; ')}`);
  }
}

function readinessSummary() {
  const readiness = buildReadinessReport();
  return {
    modelScore: readiness.modelScore,
    effectiveScore: readiness.effectiveScore,
    localControlledRuntimeReady: readiness.localControlledRuntimeReady,
    modelOnlyReady: readiness.modelOnlyReady,
    cloudReady: readiness.cloudReady,
    customGptReady: readiness.customGptReady,
  };
}

export function buildRequestReport(request, expected, { execute = false } = {}) {
  validateRuntimeRequest(request);
  const normalized = normalizeRuntimeRequest(request);
  const effective = buildEffectiveResult(normalized, expected);
  const readiness = readinessSummary();

  return {
    ok: true,
    requestId: normalized.requestId,
    input: normalized.userInput,
    mode: normalized.mode,
    dryRun: !execute,
    executeRequested: execute,
    modelLoaded: false,
    runtimeSupports: normalized.runtimeSupports,
    model: {
      modelOnlyReady: false,
      rawFinalText: null,
      modelPassed: false,
    },
    effective: {
      plane: effective.plane,
      action: effective.action,
      risk: effective.risk,
      answer: effective.answer,
      requiresConfirmation: effective.requiresConfirmation,
      allowedForTraining: false,
      effectivePassed: effective.effectivePassed,
      sources: effective.sources,
    },
    safety: CLEAN_SAFETY_FLAGS,
    readiness,
  };
}

function buildExecutedRequestReport(request, expected, localModelResult) {
  const { adapterReport, evalFile, adapterReportPath, adapterExitStatus } = localModelResult;
  const base = buildRequestReport(request, expected, { execute: true });
  const result = Array.isArray(adapterReport?.results) ? adapterReport.results[0] : undefined;
  const effective = {
    ...base.effective,
    action: result?.effectiveAction || base.effective.action,
    risk: result?.effectiveRisk || base.effective.risk,
    allowedForTraining: result?.effectiveAllowedForTraining ?? base.effective.allowedForTraining,
    effectivePassed: result?.effectivePassed ?? base.effective.effectivePassed,
  };

  return {
    ...base,
    ok: effective.effectivePassed === true,
    dryRun: false,
    executeRequested: true,
    modelLoaded: true,
    model: {
      ...base.model,
      rawFinalText: result?.finalText ?? null,
      modelPassed: result?.modelPassed === true,
    },
    effective,
    localModel: {
      requested: true,
      executed: true,
      adapterDir: request.adapterDir,
      evalFile,
      adapterReport: adapterReportPath,
      adapterExitStatus,
      reportLoaded: true,
    },
  };
}

function buildLocalModelDryRunReport(request, expected) {
  const report = buildRequestReport(request, expected, { execute: false });
  return {
    ...report,
    executeRequested: true,
    localModel: {
      requested: true,
      executed: false,
      dryRun: true,
      adapterDir: request.adapterDir,
      adapterCommand: 'node scripts/gptoss/eval-adapter-local.mjs --execute --router-classifier-mode --prefill-json-start --apply-hard-policy-overrides --use-local-spec-facts',
    },
  };
}

function buildRequestEvalRecord({ raw, request }) {
  return {
    id: request.requestId,
    source: 'arcanos_owned_spec',
    allowed_for_eval: true,
    task: 'runtime_request',
    prompt: request.userInput,
    expected: fixtureEvalExpected(raw, request),
    metadata: {
      phase: '4.2',
      runtime_request: true,
      allowed_for_training: false,
      no_openai_output_used: true,
    },
  };
}

function runLocalAdapterForRequest({ raw, request, spawnAdapter = spawnSync }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evalFile = join(RUNTIME_REPORT_DIR, `request-local-model-${stamp}.jsonl`);
  const adapterReportPath = join(RUNTIME_REPORT_DIR, `request-local-model-adapter-${stamp}.json`);
  const adapterEvalFile = toAdapterArgumentPath(evalFile);
  const adapterOutputPath = toAdapterArgumentPath(adapterReportPath);
  const evalRecord = buildRequestEvalRecord({ raw, request });
  writeText(evalFile, `${JSON.stringify(evalRecord)}\n`);

  const args = [
    'scripts/gptoss/eval-adapter-local.mjs',
    '--execute',
    '--router-classifier-mode',
    '--prefill-json-start',
    '--apply-hard-policy-overrides',
    '--use-local-spec-facts',
    '--adapter-dir',
    toAdapterArgumentPath(request.adapterDir || DEFAULT_ADAPTER_DIR),
    '--eval-file',
    adapterEvalFile,
    '--output',
    adapterOutputPath,
    '--temperature',
    '0',
    '--max-new-tokens',
    '32',
    '--repetition-penalty',
    '1.3',
  ];
  const result = spawnAdapter(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (!existsSync(adapterReportPath)) {
    throw new Error(`local_model_adapter_report_missing:${adapterReportPath}:status:${result.status ?? 1}`);
  }

  return {
    evalFile,
    adapterReportPath,
    adapterExitStatus: result.status ?? 0,
    adapterReport: readJson(adapterReportPath),
  };
}

function assertLocalAdapterSafety(adapterReport) {
  if (adapterReport?.openAiCalled !== false) throw new Error('local_model_openai_called');
  if (adapterReport?.trainingExecuted !== false) throw new Error('local_model_training_executed');
  if (adapterReport?.vllmUsed !== false) throw new Error('local_model_vllm_used');
  if (adapterReport?.noOpenAiOutputUsed !== true) throw new Error('local_model_openai_output_used');
}

function resultMatchesExpected(result, expected = {}) {
  const expectedEffective = expected.effective || {};
  const expectedSafety = expected.safety || {};
  const effectiveOk = Object.entries(expectedEffective).every(([key, value]) => {
    if (key === 'sources') {
      return Array.isArray(value) && value.every((source) => result.effective.sources.includes(source));
    }
    return result.effective[key] === value;
  });
  const safetyOk = Object.entries(expectedSafety).every(([key, value]) => result.safety[key] === value);
  const readinessOk = (
    result.readiness.modelOnlyReady === false &&
    result.readiness.cloudReady === false &&
    result.readiness.customGptReady === false
  );
  return effectiveOk && safetyOk && readinessOk;
}

export function runRequest({
  input,
  inputFile,
  request: requestOverride,
  expected: expectedOverride,
  output = defaultOutputPath('request'),
  execute = false,
  executeLocalModel = false,
  audit = false,
  auditOutput,
  spawnAdapter = spawnSync,
} = {}) {
  if (execute && !executeLocalModel) {
    throw new Error('execute_local_model_flag_required');
  }
  if (!input && !inputFile && !requestOverride) {
    throw new Error('input_or_input_file_required');
  }
  const raw = requestOverride || (inputFile ? readJson(inputFile) : requestFromInput(input));
  const request = normalizeRuntimeRequest(requestOverride || unwrapRequest(raw));
  const expected = expectedOverride || fixtureExpected(raw);
  const result = executeLocalModel && execute
    ? (() => {
      const localModelResult = runLocalAdapterForRequest({ raw, request, spawnAdapter });
      assertLocalAdapterSafety(localModelResult.adapterReport);
      return buildExecutedRequestReport(request, expected, localModelResult);
    })()
    : executeLocalModel
      ? buildLocalModelDryRunReport(request, expected)
      : buildRequestReport(request, expected, { execute: false });
  writeJson(output, result);
  if (audit || (executeLocalModel && execute)) {
    writeAuditRecord({ request, result, auditPath: auditOutput });
  }
  return result;
}

export function runSmoke({
  fixtureDir = DEFAULT_REQUEST_FIXTURE_DIR,
  output = defaultOutputPath('request-smoke'),
  audit = false,
} = {}) {
  if (!existsSync(fixtureDir)) {
    throw new Error(`missing_request_fixture_dir:${fixtureDir}`);
  }
  const results = readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixturePath = join(fixtureDir, name);
      const fixture = readJson(fixturePath);
      const request = normalizeRuntimeRequest(unwrapRequest(fixture));
      const response = buildRequestReport(request, fixtureExpected(fixture));
      const auditRecord = audit ? writeAuditRecord({ request, result: response }) : undefined;
      const passed = resultMatchesExpected(response, fixture.expected);
      return {
        id: fixture.id || request.requestId,
        fixture: fixturePath,
        request,
        response,
        expected: fixture.expected,
        audit: auditRecord?.path,
        passed,
      };
    });
  const failed = results.filter((result) => !result.passed);
  const report = {
    ok: failed.length === 0,
    mode: 'request_smoke',
    dryRun: true,
    executeRequested: false,
    modelLoaded: false,
    records: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    readiness: readinessSummary(),
    safety: CLEAN_SAFETY_FLAGS,
    auditEnabled: audit,
    auditRecords: audit ? results.map((result) => result.audit).filter(Boolean) : [],
    results,
  };
  writeJson(output, report);
  return report;
}

export function runRegression(options = {}) {
  const report = runSmoke({
    fixtureDir: options.fixtureDir,
    output: options.output || defaultOutputPath('request-regress'),
  });
  const ok = (
    report.ok === true &&
    report.readiness.localControlledRuntimeReady === true &&
    report.readiness.modelOnlyReady === false &&
    report.readiness.cloudReady === false &&
    report.readiness.customGptReady === false
  );
  return {
    ...report,
    mode: 'request_regress',
    ok,
  };
}

function parseArgs(argv = []) {
  const options = {
    command: 'request',
    input: undefined,
    inputFile: undefined,
    output: undefined,
    fixtureDir: DEFAULT_REQUEST_FIXTURE_DIR,
    execute: false,
    dryRun: true,
    executeLocalModel: false,
    dryRunExplicit: false,
    audit: false,
    auditOutput: undefined,
  };

  let index = 0;
  if (['request', 'smoke', 'regress'].includes(argv[0])) {
    options.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--input' && next) {
      options.input = next;
      index += 1;
    } else if (flag === '--input-file' && next) {
      options.inputFile = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--fixture-dir' && next) {
      options.fixtureDir = next;
      index += 1;
    } else if (flag === '--audit') {
      options.audit = true;
    } else if (flag === '--audit-output' && next) {
      options.audit = true;
      options.auditOutput = next;
      index += 1;
    } else if (flag === '--dry-run') {
      options.dryRun = true;
      options.dryRunExplicit = true;
    } else if (flag === '--execute') {
      options.execute = true;
      options.dryRun = false;
    } else if (flag === '--execute-local-model') {
      options.executeLocalModel = true;
      if (!options.dryRunExplicit) {
        options.execute = true;
        options.dryRun = false;
      }
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  if (options.dryRun) {
    options.execute = false;
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === 'smoke'
    ? runSmoke({ fixtureDir: options.fixtureDir, output: options.output, audit: options.audit })
    : options.command === 'regress'
      ? runRegression({ fixtureDir: options.fixtureDir, output: options.output })
      : runRequest({
        input: options.input,
        inputFile: options.inputFile,
        output: options.output,
        execute: options.execute,
        executeLocalModel: options.executeLocalModel,
        audit: options.audit,
        auditOutput: options.auditOutput,
      });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      safety: CLEAN_SAFETY_FLAGS,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    };
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 2;
  });
}
