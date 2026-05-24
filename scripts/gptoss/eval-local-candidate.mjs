#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_EVAL_FILE = 'examples/gptoss/arcanos-eval-smoke.jsonl';
const DEFAULT_BASE_URL = process.env.GPTOSS_API_BASE_URL || 'http://127.0.0.1:8000/v1';
const DEFAULT_MODEL = process.env.GPTOSS_MODEL || 'openai/gpt-oss-20b';
const SAFE_SOURCES = new Set(['arcanos_owned_spec', 'repo_schema', 'human_authored']);
const FORBIDDEN_PATTERNS = [
  /OPENAI_API_KEY/i,
  /RAILWAY_API_TOKEN/i,
  /DATABASE_URL/i,
  /Bearer\s+/i,
  /hidden reasoning/i,
  /chain of thought/i,
];

export function parseArgs(argv = []) {
  const options = {
    evalFile: DEFAULT_EVAL_FILE,
    outputFile: '',
    dryRun: true,
    callLocalEndpoint: false,
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--eval-file' && next) {
      options.evalFile = next;
      index += 1;
    } else if (flag === '--output-file' && next) {
      options.outputFile = next;
      index += 1;
    } else if (flag === '--execute') {
      options.dryRun = false;
      options.callLocalEndpoint = true;
    } else if (flag === '--dry-run') {
      options.dryRun = true;
      options.callLocalEndpoint = false;
    } else if (flag === '--base-url' && next) {
      options.baseUrl = next;
      index += 1;
    } else if (flag === '--model' && next) {
      options.model = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }

  return options;
}

export function readJsonl(filePath) {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : 'parse failed'}`);
      }
    });
}

export function validateEvalRecord(record, index) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [`line ${index + 1}: record must be an object`];
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') errors.push('id_required');
  if (!SAFE_SOURCES.has(record.source)) errors.push('unsafe_source');
  if (record.allowed_for_eval !== true) errors.push('eval_not_allowed');
  if (typeof record.prompt !== 'string' || record.prompt.trim() === '') errors.push('prompt_required');
  if (!record.expected || typeof record.expected !== 'object' || Array.isArray(record.expected)) errors.push('expected_required');
  const unsafeAssertionText = [
    record.prompt,
    ...(Array.isArray(record.expected?.must_include) ? record.expected.must_include : []),
  ].join(' ');
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(unsafeAssertionText))) errors.push('forbidden_marker');
  return errors.map((error) => `line ${index + 1}: ${error}`);
}

export function loadEvalRecords(filePath) {
  const records = readJsonl(filePath);
  const errors = records.flatMap((record, index) => validateEvalRecord(record, index));
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return records;
}

export function loadOutputs(filePath) {
  if (!filePath) return new Map();
  const outputs = new Map();
  for (const record of readJsonl(filePath)) {
    if (typeof record.id === 'string' && typeof record.output === 'string') {
      outputs.set(record.id, record.output);
    }
  }
  return outputs;
}

export function dryRunOutputFor(record) {
  const expected = record.expected || {};
  const includes = Array.isArray(expected.must_include) ? expected.must_include.join(' ') : '';
  const plane = typeof expected.plane === 'string' ? expected.plane : '';
  if (expected.json_object === true) {
    return JSON.stringify({
      allowed: false,
      action: includes.includes('validate_dataset') ? 'validate_dataset' : 'local_eval',
      allowedForTraining: false,
      plane: plane || undefined,
    });
  }
  return [plane, includes, 'allowedForTraining false'].filter(Boolean).join(' ');
}

export function evaluateOutput(record, output) {
  const expected = record.expected || {};
  const failures = [];
  const text = String(output || '');
  const lower = text.toLowerCase();

  if (expected.json_object === true) {
    try {
      JSON.parse(text);
    } catch {
      failures.push('invalid_json');
    }
  }
  if (typeof expected.plane === 'string' && !lower.includes(expected.plane.toLowerCase())) {
    failures.push('plane_mismatch');
  }
  for (const item of expected.must_include || []) {
    if (!lower.includes(String(item).toLowerCase())) failures.push(`missing:${item}`);
  }
  for (const item of expected.must_not_include || []) {
    if (lower.includes(String(item).toLowerCase())) failures.push(`forbidden:${item}`);
  }
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(text))) failures.push('forbidden_capability_or_secret');

  return {
    id: record.id,
    passed: failures.length === 0,
    failures,
  };
}

async function callLocalEndpoint(record, options, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer local-gptoss',
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: 'system', content: 'Answer the local Arcanos eval prompt. Do not reveal hidden reasoning or secrets.' },
        { role: 'user', content: record.prompt },
      ],
      temperature: 0,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`local_endpoint_http_${response.status}`);
  return body?.choices?.[0]?.message?.content || '';
}

export async function runEval(options, { fetchImpl = globalThis.fetch } = {}) {
  const records = loadEvalRecords(options.evalFile);
  const outputById = loadOutputs(options.outputFile);
  const results = [];

  for (const record of records) {
    let output = outputById.get(record.id);
    if (output === undefined && options.callLocalEndpoint) {
      output = await callLocalEndpoint(record, options, fetchImpl);
    }
    if (output === undefined) output = dryRunOutputFor(record);
    results.push(evaluateOutput(record, output));
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    id: randomUUID(),
    kind: 'gptoss_local_eval',
    mode: options.callLocalEndpoint ? 'local-endpoint' : 'dry-run',
    evalFile: options.evalFile,
    total: records.length,
    passed,
    failed: records.length - passed,
    allowedForTraining: false,
    openAiCalled: false,
    results,
  };
}

async function main() {
  const report = await runEval(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
