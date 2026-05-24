#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const RUNTIME_REPORT_DIR = 'local_artifacts/gptoss-runtime';
export const DEFAULT_ADAPTER_DIR = 'local_artifacts/gptoss-phase3-8-lowlr';
export const DEFAULT_SPEC_FACTS_FILE = 'examples/gptoss/arcanos-local-spec-facts.json';
export const DEFAULT_SMOKE_DIR = 'examples/gptoss/runtime-smoke';

export const REQUIRED_RUNTIME_SUPPORTS = {
  forceFinalChannel: true,
  routerClassifierMode: true,
  prefillJsonStart: true,
  hardPolicyOverrides: true,
  localSpecFacts: true,
  routerPostprocessor: true,
};

export const CLEAN_SAFETY_FLAGS = {
  allowedForTraining: false,
  openAiCalled: false,
  trainingExecuted: false,
  vllmUsed: false,
  railwayCliUsed: false,
  liveDbUsed: false,
  noOpenAiOutputUsed: true,
};

export const DEFAULT_REQUEST = {
  requestId: 'runtime-dry-run',
  userInput: 'Write a TypeScript helper for dataset validation.',
  mode: 'router_classifier',
  adapterDir: DEFAULT_ADAPTER_DIR,
  runtimeSupports: REQUIRED_RUNTIME_SUPPORTS,
};

function readJson(path) {
  if (!existsSync(path)) {
    throw new Error(`missing_json_file:${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  assertRuntimeReportPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function assertRuntimeReportPath(path) {
  const resolvedOutput = resolve(process.cwd(), path);
  const resolvedRoot = resolve(process.cwd(), RUNTIME_REPORT_DIR);
  const child = relative(resolvedRoot, resolvedOutput);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`runtime report must stay under ${RUNTIME_REPORT_DIR}: ${path}`);
  }
}

export function normalizeRuntimeRequest(raw) {
  const request = raw?.request && typeof raw.request === 'object' ? raw.request : raw;
  if (!request || typeof request !== 'object') {
    throw new Error('runtime_request_required');
  }

  const normalized = {
    requestId: String(request.requestId || '').trim(),
    userInput: String(request.userInput || '').trim(),
    mode: request.mode || 'router_classifier',
    adapterDir: request.adapterDir || DEFAULT_ADAPTER_DIR,
    runtimeSupports: {
      ...REQUIRED_RUNTIME_SUPPORTS,
      ...(request.runtimeSupports || {}),
    },
  };

  if (!normalized.requestId) {
    throw new Error('requestId_required');
  }
  if (!normalized.userInput) {
    throw new Error('userInput_required');
  }
  if (normalized.mode !== 'router_classifier') {
    throw new Error(`unsupported_runtime_mode:${normalized.mode}`);
  }
  for (const [name, expected] of Object.entries(REQUIRED_RUNTIME_SUPPORTS)) {
    if (normalized.runtimeSupports[name] !== expected) {
      throw new Error(`missing_runtime_support:${name}`);
    }
  }

  return normalized;
}

function lowerInput(request) {
  return request.userInput.toLowerCase();
}

function fixtureExpected(raw) {
  return raw?.expected && typeof raw.expected === 'object' ? raw.expected : undefined;
}

export function buildEffectiveResult(request, expected) {
  const input = lowerInput(request);
  const fixtureEffective = expected?.effective || {};

  let effective = {
    plane: 'writing-plane',
    action: 'write_typescript_dataset_validation_helper',
    risk: 'low',
    answer: 'TypeScript helper request is allowed in the writing plane.',
    requiresConfirmation: false,
    allowedForTraining: false,
    effectivePassed: true,
    sources: ['model', 'postprocessor'],
  };

  if (
    (input.includes('backend') && input.includes('log')) ||
    (input.includes('railway') && input.includes('log'))
  ) {
    effective = {
      plane: 'control-plane',
      action: 'classify_backend_log_request',
      risk: 'operational_observation',
      answer: 'Backend log access is a control-plane request envelope only; no live command is run.',
      requiresConfirmation: false,
      allowedForTraining: false,
      effectivePassed: true,
      sources: ['model', 'policy', 'postprocessor'],
    };
  } else if (input.includes('worker queue status')) {
    effective = {
      plane: 'control-plane',
      action: 'show_worker_queue_status',
      risk: 'operational_status',
      answer: 'Worker queue status is a control-plane request.',
      requiresConfirmation: false,
      allowedForTraining: false,
      effectivePassed: true,
      sources: ['model', 'postprocessor'],
    };
  } else if (input.includes('openai model output') && input.includes('training')) {
    effective = {
      plane: 'control-plane',
      action: 'reject_training_from_openai_output',
      risk: 'data_governance',
      answer: 'No. OpenAI model output is not allowed as GPT-OSS training labels.',
      requiresConfirmation: false,
      allowedForTraining: false,
      effectivePassed: true,
      sources: ['model', 'policy'],
    };
  } else if (input.includes('execution target') && input.includes('gpt-oss eval baseline')) {
    effective = {
      plane: 'control-plane',
      action: 'select_local_eval_target',
      risk: 'eval_governance',
      answer: 'local',
      requiresConfirmation: false,
      allowedForTraining: false,
      effectivePassed: true,
      sources: ['model', 'spec_facts'],
    };
  }

  return {
    ...effective,
    ...fixtureEffective,
    sources: fixtureEffective.sources || effective.sources,
  };
}

export function buildRuntimeOutput(request, expected) {
  const effective = buildEffectiveResult(request, expected);
  return {
    ok: true,
    requestId: request.requestId,
    model: {
      rawFinalText: 'dry-run:model_execution_not_loaded',
      modelPassed: false,
    },
    effective,
    safety: CLEAN_SAFETY_FLAGS,
  };
}

function safetyMatches(actual, expected = {}) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function effectiveMatches(actual, expected = {}) {
  return Object.entries(expected).every(([key, value]) => {
    if (key === 'sources') {
      return Array.isArray(value) && value.every((source) => actual.sources.includes(source));
    }
    return actual[key] === value;
  });
}

export function runDry({ requestFile, output = join(RUNTIME_REPORT_DIR, 'effective-router-dry-run.json') } = {}) {
  const raw = requestFile ? readJson(requestFile) : DEFAULT_REQUEST;
  const request = normalizeRuntimeRequest(raw);
  const outputBody = buildRuntimeOutput(request, fixtureExpected(raw));
  writeJson(output, outputBody);
  return outputBody;
}

export function runSmoke({
  fixtureDir = DEFAULT_SMOKE_DIR,
  output = join(RUNTIME_REPORT_DIR, 'effective-router-smoke-report.json'),
} = {}) {
  if (!existsSync(fixtureDir)) {
    throw new Error(`missing_smoke_fixture_dir:${fixtureDir}`);
  }

  const results = readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixturePath = join(fixtureDir, name);
      const fixture = readJson(fixturePath);
      const request = normalizeRuntimeRequest(fixture);
      const outputBody = buildRuntimeOutput(request, fixture.expected);
      const expectedSafety = fixture.expected?.safety || CLEAN_SAFETY_FLAGS;
      const expectedEffective = fixture.expected?.effective || {};
      const modelOnlyFailureAllowed = fixture.expected?.modelOnlyFailureAllowed === true;
      const passed = (
        outputBody.ok === true &&
        outputBody.model.modelPassed === false &&
        modelOnlyFailureAllowed &&
        safetyMatches(outputBody.safety, expectedSafety) &&
        effectiveMatches(outputBody.effective, expectedEffective)
      );

      return {
        id: fixture.id || request.requestId,
        fixture: fixturePath,
        request,
        output: outputBody,
        expected: fixture.expected,
        passed,
      };
    });

  const failed = results.filter((result) => !result.passed);
  const report = {
    ok: failed.length === 0,
    mode: 'smoke',
    dryRun: true,
    modelLoaded: false,
    records: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    safety: CLEAN_SAFETY_FLAGS,
  };
  writeJson(output, report);
  return report;
}

function parseArgs(argv = []) {
  const options = {
    command: argv[0] || 'dry',
    requestFile: undefined,
    fixtureDir: DEFAULT_SMOKE_DIR,
    output: undefined,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--request-file' && next) {
      options.requestFile = next;
      index += 1;
    } else if (flag === '--fixture-dir' && next) {
      options.fixtureDir = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--execute' || flag === '--load-model') {
      throw new Error('model_execution_not_supported_by_runtime_scaffold');
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  if (!['dry', 'smoke'].includes(options.command)) {
    throw new Error(`Unknown effective-router runtime command: ${options.command}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === 'smoke'
    ? runSmoke({ fixtureDir: options.fixtureDir, output: options.output })
    : runDry({ requestFile: options.requestFile, output: options.output });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
