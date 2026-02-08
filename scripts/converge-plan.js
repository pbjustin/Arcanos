#!/usr/bin/env node

/**
 * Convergence loop orchestrator for ARCANOS quality gates.
 * Runs configured criteria recursively with bounded retries and hard-stop classes.
 */

import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export const EXIT_CODES = {
  SUCCESS: 0,
  ENV_FAILURE: 10,
  CONFIG_INVALID: 11,
  EXECUTION_ERROR: 12,
  CRITERIA_DRIFT: 13,
  STAGNATION: 14,
  MAX_ITERATIONS_REACHED: 15
};

const EXIT_LABELS = Object.fromEntries(
  Object.entries(EXIT_CODES).map(([label, code]) => [code, label])
);

const DEFAULT_OPTIONS = {
  maxIterations: 10,
  stagnationThreshold: 2,
  iterationTimeoutMs: 20 * 60 * 1000,
  criteriaFile: path.join('config', 'converge.criteria.json'),
  allowListFile: path.join('config', 'fix.approved.json'),
  artifactDir: 'converge-artifacts',
  preview: false,
  webhookUrl: process.env.CONVERGE_WEBHOOK_URL || ''
};

class ConvergeError extends Error {
  constructor(label, message, details = {}) {
    super(message);
    this.name = 'ConvergeError';
    this.label = label;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function parseDuration(input) {
  const raw = String(input).trim();
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new ConvergeError('CONFIG_INVALID', `Invalid duration: "${input}"`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] || 'ms').toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000
  };

  return value * multipliers[unit];
}

function parseNumber(input, name) {
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ConvergeError('CONFIG_INVALID', `Invalid ${name}: "${input}"`);
  }
  return parsed;
}

function parseArgValue(args, index, prefix) {
  const arg = args[index];
  if (arg.startsWith(`${prefix}=`)) {
    return arg.slice(prefix.length + 1);
  }
  if (index + 1 < args.length && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  throw new ConvergeError('CONFIG_INVALID', `Missing value for ${prefix}`);
}

export function parseArgs(rawArgs) {
  const options = { ...DEFAULT_OPTIONS };
  const args = [...rawArgs];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--preview') {
      options.preview = true;
      continue;
    }

    if (arg.startsWith('--max-iterations')) {
      options.maxIterations = parseNumber(parseArgValue(args, i, '--max-iterations'), 'max-iterations');
      if (!arg.includes('=')) i += 1;
      continue;
    }

    if (arg.startsWith('--iteration-timeout')) {
      options.iterationTimeoutMs = parseDuration(parseArgValue(args, i, '--iteration-timeout'));
      if (!arg.includes('=')) i += 1;
      continue;
    }

    if (arg.startsWith('--criteria-file')) {
      options.criteriaFile = parseArgValue(args, i, '--criteria-file');
      if (!arg.includes('=')) i += 1;
      continue;
    }

    if (arg.startsWith('--artifact-dir')) {
      options.artifactDir = parseArgValue(args, i, '--artifact-dir');
      if (!arg.includes('=')) i += 1;
      continue;
    }

    if (arg.startsWith('--allow-list-file')) {
      options.allowListFile = parseArgValue(args, i, '--allow-list-file');
      if (!arg.includes('=')) i += 1;
      continue;
    }

    if (arg.startsWith('--webhook-url')) {
      options.webhookUrl = parseArgValue(args, i, '--webhook-url');
      if (!arg.includes('=')) i += 1;
      continue;
    }

    throw new ConvergeError('CONFIG_INVALID', `Unknown argument: ${arg}`);
  }

  return options;
}

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function parseVersion(versionOutput) {
  const match =
    String(versionOutput).match(/(\d+)\.(\d+)\.(\d+)/) ||
    String(versionOutput).match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3] || '0', 10)
  };
}

function compareVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function escapeAnnotation(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function emitAnnotation(level, message) {
  const escaped = escapeAnnotation(message);
  if (level === 'error') {
    console.error(message);
    console.log(`::error::${escaped}`);
    return;
  }
  console.warn(message);
  console.log(`::warning::${escaped}`);
}

function truncateOutput(output, maxLength = 20000) {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n...[truncated ${output.length - maxLength} chars]`;
}

function validateToolConfig(name, config) {
  if (!config || typeof config !== 'object') {
    throw new ConvergeError('CONFIG_INVALID', `requiredTools.${name} must be an object`);
  }
  if (!config.minVersion || typeof config.minVersion !== 'string') {
    throw new ConvergeError('CONFIG_INVALID', `requiredTools.${name}.minVersion must be a string`);
  }
}

export function validateCriteriaConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ConvergeError('CONFIG_INVALID', 'Criteria config must be a JSON object');
  }

  const requiredTools = raw.requiredTools || {};
  const defaults = {
    node: { command: 'node', minVersion: '18.0.0' },
    npm: { command: 'npm', minVersion: '8.0.0' },
    python: { commands: ['python', 'python3'], minVersion: '3.10.0' }
  };

  const normalizedTools = {
    node: { ...defaults.node, ...(requiredTools.node || {}) },
    npm: { ...defaults.npm, ...(requiredTools.npm || {}) },
    python: { ...defaults.python, ...(requiredTools.python || {}) }
  };

  validateToolConfig('node', normalizedTools.node);
  validateToolConfig('npm', normalizedTools.npm);
  validateToolConfig('python', normalizedTools.python);

  if (!normalizedTools.node.command || typeof normalizedTools.node.command !== 'string') {
    throw new ConvergeError('CONFIG_INVALID', 'requiredTools.node.command must be a string');
  }
  if (!normalizedTools.npm.command || typeof normalizedTools.npm.command !== 'string') {
    throw new ConvergeError('CONFIG_INVALID', 'requiredTools.npm.command must be a string');
  }
  if (!Array.isArray(normalizedTools.python.commands) || normalizedTools.python.commands.length === 0) {
    throw new ConvergeError('CONFIG_INVALID', 'requiredTools.python.commands must be a non-empty array');
  }

  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    throw new ConvergeError('CONFIG_INVALID', 'criteria must be a non-empty array');
  }

  const seenIds = new Set();
  const criteria = raw.criteria.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ConvergeError('CONFIG_INVALID', `criteria[${index}] must be an object`);
    }
    if (!item.id || typeof item.id !== 'string') {
      throw new ConvergeError('CONFIG_INVALID', `criteria[${index}].id must be a string`);
    }
    if (seenIds.has(item.id)) {
      throw new ConvergeError('CONFIG_INVALID', `Duplicate criteria id: ${item.id}`);
    }
    seenIds.add(item.id);
    if (!item.command || typeof item.command !== 'string') {
      throw new ConvergeError('CONFIG_INVALID', `criteria[${index}].command must be a string`);
    }
    return {
      id: item.id,
      command: item.command,
      description: typeof item.description === 'string' ? item.description : item.id,
      estimatedMinutes: Number.isFinite(item.estimatedMinutes) ? Math.max(0, Number(item.estimatedMinutes)) : 0
    };
  });

  const autoFixers = Array.isArray(raw.autoFixers)
    ? raw.autoFixers.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new ConvergeError('CONFIG_INVALID', `autoFixers[${index}] must be an object`);
        }
        if (!item.id || typeof item.id !== 'string') {
          throw new ConvergeError('CONFIG_INVALID', `autoFixers[${index}].id must be a string`);
        }
        if (!item.command || typeof item.command !== 'string') {
          throw new ConvergeError('CONFIG_INVALID', `autoFixers[${index}].command must be a string`);
        }
        return { id: item.id, command: item.command };
      })
    : [];

  return {
    version: Number.isFinite(raw.version) ? Number(raw.version) : 1,
    requiredTools: normalizedTools,
    stagnationThreshold: Number.isFinite(raw.stagnationThreshold)
      ? Math.max(2, Number(raw.stagnationThreshold))
      : DEFAULT_OPTIONS.stagnationThreshold,
    criteria,
    autoFixers
  };
}

export function validateFixAllowList(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ConvergeError('CONFIG_INVALID', 'Fix allow-list must be a JSON object');
  }
  if (!Array.isArray(raw.approvedFixers)) {
    throw new ConvergeError('CONFIG_INVALID', 'approvedFixers must be an array');
  }
  const approvedFixers = raw.approvedFixers
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);

  if (approvedFixers.length === 0) {
    throw new ConvergeError('CONFIG_INVALID', 'approvedFixers cannot be empty');
  }

  return {
    version: Number.isFinite(raw.version) ? Number(raw.version) : 1,
    approvedFixers: Array.from(new Set(approvedFixers))
  };
}

async function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new ConvergeError('CONFIG_INVALID', `Unable to read ${label} file: ${filePath}`, {
      filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConvergeError('CONFIG_INVALID', `${label} JSON is malformed: ${filePath}`, {
      filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  return { raw, parsed };
}

function killProcessTree(pid) {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // no-op
    }
  }
}

async function runShellCommand(command, timeoutMs) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd: process.cwd(),
      shell: true,
      detached: process.platform !== 'win32',
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let completed = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', error => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutHandle);
      resolve({
        command,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(`${stderr}\n${error.message}`),
        signal: null
      });
    });

    child.on('close', (code, signal) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutHandle);
      resolve({
        command,
        exitCode: typeof code === 'number' ? code : 1,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        signal: signal || null
      });
    });
  });
}

function buildFailureSignature(iterationIndex, criteriaResults, timeoutStep = null) {
  const failedIds = criteriaResults
    .filter(result => !result.ok)
    .map(result => result.id)
    .sort();

  const signatureParts = [];
  if (timeoutStep) {
    signatureParts.push(`TIMEOUT::${iterationIndex}::${timeoutStep}`);
  }
  for (const id of failedIds) {
    signatureParts.push(`FAIL::${id}`);
  }
  return signatureParts.join('|');
}

function formatMilliseconds(value) {
  if (value < 1000) return `${value}ms`;
  if (value < 60 * 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / (60 * 1000)).toFixed(1)}m`;
}

function runVersionCommand(command) {
  const result =
    process.platform === 'win32'
      ? spawnSync(`${command} --version`, {
          encoding: 'utf8',
          shell: true
        })
      : spawnSync(command, ['--version'], {
          encoding: 'utf8',
          shell: false
        });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const parsed = parseVersion(output);
  if (!parsed) return null;
  return { command, output, parsed };
}

function validateToolVersion(label, commandConfig) {
  const minVersion = parseVersion(commandConfig.minVersion);
  if (!minVersion) {
    throw new ConvergeError('CONFIG_INVALID', `Invalid minVersion for ${label}: ${commandConfig.minVersion}`);
  }

  const commands = Array.isArray(commandConfig.commands)
    ? commandConfig.commands
    : [commandConfig.command];

  for (const command of commands) {
    const info = runVersionCommand(command);
    if (!info) continue;
    if (compareVersions(info.parsed, minVersion) < 0) {
      throw new ConvergeError(
        'ENV_FAILURE',
        `${label} version too old for "${command}". Found ${info.output}, expected >= ${commandConfig.minVersion}`
      );
    }
    return info;
  }

  throw new ConvergeError('ENV_FAILURE', `${label} is not available in PATH`);
}

function validateEnvironmentTools(requiredTools) {
  return {
    node: validateToolVersion('node', requiredTools.node),
    npm: validateToolVersion('npm', requiredTools.npm),
    python: validateToolVersion('python', requiredTools.python)
  };
}

async function ensureArtifactsDir(artifactDir) {
  await fs.mkdir(artifactDir, { recursive: true });
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function buildMarkdownSummary(run) {
  const iterations = Array.isArray(run.iterations) ? run.iterations : [];
  const failedCriteria = Array.isArray(run.failedCriteria) ? run.failedCriteria : [];

  const lines = [];
  lines.push('# Convergence Summary');
  lines.push('');
  lines.push(`- Run ID: \`${run.runId}\``);
  lines.push(`- Status: \`${run.exitLabel}\``);
  lines.push(`- Exit code: \`${run.exitCode}\``);
  lines.push(`- Criteria checksum: \`${run.criteriaChecksum}\``);
  lines.push(`- Iterations: \`${iterations.length}\``);
  lines.push(`- Started: \`${run.startedAt}\``);
  lines.push(`- Finished: \`${run.finishedAt}\``);
  lines.push('');

  if (run.failureReason) {
    lines.push('## Failure Reason');
    lines.push('');
    lines.push(run.failureReason);
    lines.push('');
  }

  lines.push('## Iterations');
  lines.push('');
  if (iterations.length === 0) {
    lines.push('- No iterations were executed.');
  } else {
    for (const item of iterations) {
      lines.push(
        `- Iteration ${item.iteration}: ${item.ok ? 'PASS' : 'FAIL'} (${formatMilliseconds(item.durationMs)})`
      );
      if (!item.ok) {
        lines.push(`- Signature: \`${item.failureSignature}\``);
      }
    }
  }
  lines.push('');

  if (failedCriteria.length > 0) {
    lines.push('## Unresolved Criteria');
    lines.push('');
    for (const criterion of failedCriteria) {
      lines.push(`- ${criterion}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writeArtifacts(artifactDir, payload) {
  await ensureArtifactsDir(artifactDir);
  await writeJson(path.join(artifactDir, 'latest.json'), payload);
  const markdown = buildMarkdownSummary(payload);
  await fs.writeFile(path.join(artifactDir, 'summary.md'), `${markdown}\n`, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`, 'utf8');
  }
}

async function emitWebhookIfNeeded(url, payload) {
  if (!url) return;

  if (typeof fetch !== 'function') {
    emitAnnotation('warning', 'Webhook skipped: fetch API is unavailable in this Node runtime.');
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      emitAnnotation('warning', `Webhook delivery failed with status ${response.status}`);
    }
  } catch (error) {
    emitAnnotation('warning', `Webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizePaths(options) {
  const cwd = process.cwd();
  return {
    ...options,
    criteriaFile: path.resolve(cwd, options.criteriaFile),
    allowListFile: path.resolve(cwd, options.allowListFile),
    artifactDir: path.resolve(cwd, options.artifactDir)
  };
}

function createRunMetadata() {
  return {
    runId: `converge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: nowIso()
  };
}

async function runPreview(runContext) {
  const { runId, startedAt, options, criteriaConfig, allowList, criteriaChecksum, toolInfo } = runContext;
  const approvedFixers = criteriaConfig.autoFixers.filter(fixer =>
    allowList.approvedFixers.includes(fixer.command)
  );
  const skippedFixers = criteriaConfig.autoFixers.filter(
    fixer => !allowList.approvedFixers.includes(fixer.command)
  );

  const estimatedMinutes = criteriaConfig.criteria.reduce((sum, criterion) => sum + criterion.estimatedMinutes, 0);
  const payload = {
    runId,
    startedAt,
    finishedAt: nowIso(),
    exitCode: EXIT_CODES.SUCCESS,
    exitLabel: EXIT_LABELS[EXIT_CODES.SUCCESS],
    preview: true,
    criteriaChecksum,
    options: {
      maxIterations: options.maxIterations,
      iterationTimeoutMs: options.iterationTimeoutMs,
      artifactDir: options.artifactDir
    },
    tools: {
      node: toolInfo.node.output,
      npm: toolInfo.npm.output,
      python: toolInfo.python.output
    },
    criteriaOrder: criteriaConfig.criteria.map(item => ({
      id: item.id,
      command: item.command,
      estimatedMinutes: item.estimatedMinutes
    })),
    estimatedMinutes,
    approvedFixers,
    skippedFixers,
    iterations: [],
    failedCriteria: []
  };

  await writeArtifacts(options.artifactDir, payload);
  console.log(`Preview complete. Estimated runtime per iteration: ${estimatedMinutes.toFixed(1)}m`);
  return payload;
}

export async function executeConvergence(rawOptions = {}) {
  const run = createRunMetadata();
  const options = normalizePaths({ ...DEFAULT_OPTIONS, ...rawOptions });

  const unresolvedCriteria = new Set();
  const iterationRecords = [];
  let failureReason = null;
  let baselineChecksum = null;
  let observedChecksum = null;

  try {
    const criteriaFile = await readJsonFile(options.criteriaFile, 'criteria');
    const allowListFile = await readJsonFile(options.allowListFile, 'fix allow-list');
    const criteriaChecksum = sha256(criteriaFile.raw);
    baselineChecksum = criteriaChecksum;
    observedChecksum = criteriaChecksum;

    const criteriaConfig = validateCriteriaConfig(criteriaFile.parsed);
    const allowList = validateFixAllowList(allowListFile.parsed);
    const toolInfo = validateEnvironmentTools(criteriaConfig.requiredTools);
    await ensureArtifactsDir(options.artifactDir);

    if (options.preview) {
      const previewPayload = await runPreview({
        runId: run.runId,
        startedAt: run.startedAt,
        options,
        criteriaConfig,
        allowList,
        criteriaChecksum,
        toolInfo
      });
      return previewPayload;
    }

    let previousSignature = null;
    let stagnationCount = 0;

    for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
      const refreshedCriteria = await fs.readFile(options.criteriaFile, 'utf8');
      const checksum = sha256(refreshedCriteria);
      observedChecksum = checksum;

      if (checksum !== criteriaChecksum) {
        failureReason = `Criteria checksum drift detected. Baseline=${criteriaChecksum}, observed=${checksum}`;
        throw new ConvergeError('CRITERIA_DRIFT', failureReason, {
          baselineChecksum: criteriaChecksum,
          observedChecksum: checksum
        });
      }

      const iterationStart = Date.now();
      const criteriaResults = [];
      const fixerResults = [];
      let timeoutStep = null;

      console.log(`\n[converge] Iteration ${iteration}/${options.maxIterations}`);

      for (const criterion of criteriaConfig.criteria) {
        const elapsed = Date.now() - iterationStart;
        const remaining = options.iterationTimeoutMs - elapsed;
        if (remaining <= 0) {
          timeoutStep = criterion.id;
          unresolvedCriteria.add(criterion.id);
          emitAnnotation('warning', `Iteration timeout reached before criterion "${criterion.id}"`);
          break;
        }

        console.log(`[converge] Running: ${criterion.id} -> ${criterion.command}`);
        const commandResult = await runShellCommand(criterion.command, remaining);
        const ok = commandResult.exitCode === 0 && !commandResult.timedOut;
        criteriaResults.push({
          id: criterion.id,
          command: criterion.command,
          ok,
          timedOut: commandResult.timedOut,
          exitCode: commandResult.exitCode,
          durationMs: commandResult.durationMs,
          signal: commandResult.signal,
          stdout: commandResult.stdout,
          stderr: commandResult.stderr
        });

        if (!ok) {
          unresolvedCriteria.add(criterion.id);
          emitAnnotation(
            'warning',
            `Criterion failed: ${criterion.id} (exit=${commandResult.exitCode}, timeout=${commandResult.timedOut})`
          );
          if (commandResult.timedOut) {
            timeoutStep = criterion.id;
            break;
          }
        }
      }

      const failedCriteria = criteriaResults.filter(item => !item.ok).map(item => item.id);
      const iterationOk = failedCriteria.length === 0 && !timeoutStep;
      let failureSignature = iterationOk
        ? 'PASS'
        : buildFailureSignature(iteration, criteriaResults, timeoutStep);

      if (iterationOk) {
        const iterationRecord = {
          iteration,
          startedAt: new Date(iterationStart).toISOString(),
          finishedAt: nowIso(),
          durationMs: Date.now() - iterationStart,
          ok: true,
          failureSignature,
          criteriaChecksum,
          observedChecksum: checksum,
          criteriaResults,
          fixerResults
        };
        iterationRecords.push(iterationRecord);
        await writeJson(path.join(options.artifactDir, `iteration-${iteration}.json`), iterationRecord);

        const payload = {
          runId: run.runId,
          startedAt: run.startedAt,
          finishedAt: nowIso(),
          exitCode: EXIT_CODES.SUCCESS,
          exitLabel: EXIT_LABELS[EXIT_CODES.SUCCESS],
          criteriaChecksum,
          observedChecksum: checksum,
          iterations: iterationRecords,
          failedCriteria: []
        };
        await writeArtifacts(options.artifactDir, payload);
        console.log(
          `[converge] Completed ${payload.exitLabel} (checksum=${payload.criteriaChecksum}, iterations=${payload.iterations.length})`
        );
        return payload;
      }

      if (failureSignature === previousSignature) {
        stagnationCount += 1;
      } else {
        stagnationCount = 1;
        previousSignature = failureSignature;
      }

      if (stagnationCount >= criteriaConfig.stagnationThreshold) {
        failureReason = `Stagnation detected after ${stagnationCount} matching failure signatures (${failureSignature}).`;
        throw new ConvergeError('STAGNATION', failureReason, {
          failureSignature,
          stagnationCount
        });
      }

      const approvedFixers = criteriaConfig.autoFixers.filter(fixer =>
        allowList.approvedFixers.includes(fixer.command)
      );
      const skippedFixers = criteriaConfig.autoFixers.filter(
        fixer => !allowList.approvedFixers.includes(fixer.command)
      );

      for (const fixer of skippedFixers) {
        emitAnnotation(
          'warning',
          `Skipping fixer not in allow-list: ${fixer.id} (${fixer.command})`
        );
      }

      for (const fixer of approvedFixers) {
        const elapsed = Date.now() - iterationStart;
        const remaining = options.iterationTimeoutMs - elapsed;
        if (remaining <= 0) {
          timeoutStep = `fixer:${fixer.id}`;
          emitAnnotation('warning', `Iteration timeout reached before fixer "${fixer.id}"`);
          break;
        }

        console.log(`[converge] Auto-fix: ${fixer.id} -> ${fixer.command}`);
        const fixerResult = await runShellCommand(fixer.command, remaining);
        fixerResults.push({
          id: fixer.id,
          command: fixer.command,
          ok: fixerResult.exitCode === 0 && !fixerResult.timedOut,
          timedOut: fixerResult.timedOut,
          exitCode: fixerResult.exitCode,
          durationMs: fixerResult.durationMs,
          signal: fixerResult.signal,
          stdout: fixerResult.stdout,
          stderr: fixerResult.stderr
        });
        if (fixerResult.exitCode !== 0 || fixerResult.timedOut) {
          emitAnnotation(
            'warning',
            `Auto-fix command failed: ${fixer.id} (exit=${fixerResult.exitCode}, timeout=${fixerResult.timedOut})`
          );
        }
      }

      if (timeoutStep && timeoutStep.startsWith('fixer:')) {
        const timeoutSignature = `TIMEOUT::${iteration}::${timeoutStep}`;
        failureSignature = failureSignature ? `${failureSignature}|${timeoutSignature}` : timeoutSignature;
      }

      const iterationRecord = {
        iteration,
        startedAt: new Date(iterationStart).toISOString(),
        finishedAt: nowIso(),
        durationMs: Date.now() - iterationStart,
        ok: false,
        failureSignature,
        criteriaChecksum,
        observedChecksum: checksum,
        criteriaResults,
        fixerResults
      };
      iterationRecords.push(iterationRecord);
      await writeJson(path.join(options.artifactDir, `iteration-${iteration}.json`), iterationRecord);
    }

    failureReason = `Maximum iterations reached (${options.maxIterations}) without satisfying all criteria.`;
    throw new ConvergeError('MAX_ITERATIONS_REACHED', failureReason);
  } catch (error) {
    let label = 'EXECUTION_ERROR';
    let message = 'Unhandled execution error';
    if (error instanceof ConvergeError) {
      label = error.label;
      message = error.message;
    } else if (error instanceof Error) {
      message = error.message;
    } else {
      message = String(error);
    }

    const exitCode = EXIT_CODES[label] ?? EXIT_CODES.EXECUTION_ERROR;
    const payload = {
      runId: run.runId,
      startedAt: run.startedAt,
      finishedAt: nowIso(),
      exitCode,
      exitLabel: EXIT_LABELS[exitCode],
      failureReason: failureReason || message,
      criteriaChecksum: baselineChecksum || observedChecksum,
      observedChecksum,
      iterations: iterationRecords,
      failedCriteria: Array.from(unresolvedCriteria).sort()
    };

    await writeArtifacts(options.artifactDir, payload);
    emitAnnotation('error', `[converge:${payload.exitLabel}] ${payload.failureReason}`);
    console.log(
      `[converge] Completed ${payload.exitLabel} (checksum=${payload.criteriaChecksum}, observed=${payload.observedChecksum}, iterations=${payload.iterations.length})`
    );

    if (exitCode !== EXIT_CODES.SUCCESS && options.webhookUrl) {
      await emitWebhookIfNeeded(options.webhookUrl, {
        runId: payload.runId,
        exitCode: payload.exitCode,
        exitLabel: payload.exitLabel,
        failedCriteria: payload.failedCriteria,
        criteriaChecksum: payload.criteriaChecksum,
        observedChecksum: payload.observedChecksum,
        iterations: payload.iterations.length,
        artifactDir: options.artifactDir,
        failureReason: payload.failureReason
      });
    }

    return payload;
  }
}

export async function main(rawArgs = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(rawArgs);
  } catch (error) {
    const exitCode = error instanceof ConvergeError ? EXIT_CODES[error.label] : EXIT_CODES.CONFIG_INVALID;
    emitAnnotation('error', error instanceof Error ? error.message : String(error));
    return exitCode || EXIT_CODES.CONFIG_INVALID;
  }

  const result = await executeConvergence(options);
  return result.exitCode;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (invokedFile && path.resolve(currentFile) === invokedFile) {
  main()
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      emitAnnotation('error', `Unexpected converge-plan failure: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT_CODES.EXECUTION_ERROR;
    });
}
