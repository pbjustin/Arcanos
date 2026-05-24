#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { redactCommand, redactString, redactValue } from './railway-redaction.mjs';
import { resolveRailwayPolicy } from './railway-policy.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_CHARS = 4_000;

function safetyFields() {
  return {
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
  };
}

function trainingCandidateSummary() {
  return {
    allowedForTraining: false,
    requiresHumanReview: true,
    source: 'railway_cli_observation',
  };
}

function truncatePreview(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_PREVIEW_CHARS)}...[truncated]`;
}

export function parseArgs(argv = []) {
  const options = {
    dryRun: true,
    execute: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--action' && next) {
      options.action = next;
      index += 1;
    } else if (flag === '--service' && next) {
      options.service = next;
      index += 1;
    } else if (flag === '--environment' && next) {
      options.environment = next;
      index += 1;
    } else if (flag === '--limit' && next) {
      options.limit = next;
      index += 1;
    } else if (flag === '--confirm-token' && next) {
      options.confirmToken = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--dry-run') {
      options.dryRun = true;
      options.execute = false;
    } else if (flag === '--execute') {
      options.execute = true;
      options.dryRun = false;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

function buildReport({
  ok,
  policy,
  executed,
  result,
  errors = [],
}) {
  const report = {
    ok,
    action: policy?.action || null,
    risk: policy?.risk || 'unknown',
    executed,
    commandPreview: redactCommand(policy?.command || []),
    redacted: true,
    trainingCandidate: trainingCandidateSummary(),
    result: {
      stdoutPreview: truncatePreview(redactString(result?.stdout || '')),
      stderrPreview: truncatePreview(redactString(result?.stderr || '')),
      exitCode: result?.exitCode ?? null,
    },
    ...safetyFields(),
    ...(errors.length > 0 ? { errors } : {}),
  };

  return redactValue(report);
}

function execFilePromise(command, { execFileImpl = execFile, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolveResult) => {
    const railwayEntrypoint = process.platform === 'win32' && command[0] === 'railway' && process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@railway', 'cli', 'bin', 'railway.js')
      : null;
    const executable = railwayEntrypoint && existsSync(railwayEntrypoint)
      ? process.execPath
      : command[0];
    const args = railwayEntrypoint && existsSync(railwayEntrypoint)
      ? [railwayEntrypoint, ...command.slice(1)]
      : command.slice(1);

    execFileImpl(executable, args, {
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      const exitCode = error
        ? (typeof error.code === 'number' ? error.code : 1)
        : 0;

      resolveResult({
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : ''),
        exitCode,
      });
    });
  });
}

function resolveOutputPath(output) {
  if (!output) {
    return null;
  }

  const artifactRoot = resolve(process.cwd(), 'local_artifacts');
  const resolvedOutput = resolve(process.cwd(), output);
  if (resolvedOutput !== artifactRoot && !resolvedOutput.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error('--output must stay under local_artifacts/');
  }

  return resolvedOutput;
}

export async function runRailwayBridge(options = {}, dependencies = {}) {
  const policyResult = resolveRailwayPolicy(options);
  if (!policyResult.ok) {
    return buildReport({
      ok: false,
      policy: policyResult.policy,
      executed: false,
      result: null,
      errors: policyResult.errors,
    });
  }

  const policy = policyResult.policy;
  if (!options.execute) {
    return buildReport({
      ok: true,
      policy,
      executed: false,
      result: null,
    });
  }

  const result = await execFilePromise(policy.command, dependencies);
  return buildReport({
    ok: result.exitCode === 0,
    policy,
    executed: true,
    result,
    errors: result.exitCode === 0 ? [] : [{ code: 'railway_cli_exit_nonzero', exitCode: result.exitCode }],
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await runRailwayBridge(options);
  const outputPath = resolveOutputPath(options.output);

  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const report = {
      ok: false,
      action: null,
      risk: 'unknown',
      executed: false,
      commandPreview: [],
      redacted: true,
      trainingCandidate: trainingCandidateSummary(),
      result: {
        stdoutPreview: '',
        stderrPreview: redactString(error instanceof Error ? error.message : String(error)),
        exitCode: null,
      },
      ...safetyFields(),
      errors: [{ code: 'bridge_failed' }],
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 2;
  });
}
