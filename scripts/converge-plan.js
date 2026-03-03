#!/usr/bin/env node
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';

export const EXIT_CODES = {
  OK: 0,
  CONFIG_INVALID: 2,
  ENV_FAILURE: 3,
  EXECUTION_FAILURE: 4
};

export function sha256(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

export function parseDuration(raw) {
  const value = String(raw).trim();
  const match = value.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${raw}`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();

  switch (unit) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60_000;
    case 'h':
      return amount * 3_600_000;
    default:
      throw new Error(`Invalid duration: ${raw}`);
  }
}

export function parseArgs(argv = []) {
  const options = {
    maxIterations: 10,
    iterationTimeoutMs: 120_000,
    criteriaFile: 'scripts/schemas/converge.criteria.json',
    allowListFile: 'scripts/schemas/converge.fix-allow-list.json',
    artifactDir: 'converge-artifacts',
    preview: false
  };

  const takeValue = (arg, next, indexRef) => {
    const [, valueFromEq] = arg.split('=');
    if (valueFromEq !== undefined) {
      return valueFromEq;
    }
    const valueFromNext = next;
    if (valueFromNext === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }
    indexRef.value += 1;
    return valueFromNext;
  };

  const indexRef = { value: 0 };
  while (indexRef.value < argv.length) {
    const arg = argv[indexRef.value];
    const next = argv[indexRef.value + 1];

    if (arg === '--preview') {
      options.preview = true;
    } else if (arg.startsWith('--max-iterations')) {
      options.maxIterations = Number(takeValue(arg, next, indexRef));
    } else if (arg.startsWith('--iteration-timeout')) {
      options.iterationTimeoutMs = parseDuration(takeValue(arg, next, indexRef));
    } else if (arg.startsWith('--criteria-file')) {
      options.criteriaFile = takeValue(arg, next, indexRef);
    } else if (arg.startsWith('--allow-list-file')) {
      options.allowListFile = takeValue(arg, next, indexRef);
    } else if (arg.startsWith('--artifact-dir')) {
      options.artifactDir = takeValue(arg, next, indexRef);
    }

    indexRef.value += 1;
  }

  return options;
}

export function validateCriteriaConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('criteria config must be an object');
  }
  if (!Array.isArray(config.criteria) || config.criteria.length === 0) {
    throw new Error('criteria must be a non-empty array');
  }
  return config;
}

export function validateFixAllowList(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('allow-list config must be an object');
  }
  if (!Array.isArray(config.approvedFixers) || config.approvedFixers.length === 0) {
    throw new Error('approvedFixers cannot be empty');
  }
  return config;
}

function parseSemverLike(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(actualVersion, minVersion) {
  const actual = parseSemverLike(actualVersion);
  const required = parseSemverLike(minVersion);
  if (!actual || !required) {
    return true;
  }

  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > required[i]) return true;
    if (actual[i] < required[i]) return false;
  }
  return true;
}

function probeCommand(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return null;
  }

  const output = `${result.stdout || ''} ${result.stderr || ''}`.trim();
  return {
    command,
    version: output
  };
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeLatestArtifact(artifactDir, payload) {
  await mkdir(artifactDir, { recursive: true });
  const latestPath = path.join(artifactDir, 'latest.json');
  await writeFile(latestPath, JSON.stringify(payload, null, 2), 'utf8');
}

function resolveResult(exitCode, summary, details = {}) {
  return {
    exitCode,
    summary,
    details,
    timestamp: new Date().toISOString()
  };
}

export async function executeConvergence(options = {}) {
  const merged = {
    criteriaFile: options.criteriaFile || 'scripts/schemas/converge.criteria.json',
    allowListFile: options.allowListFile || 'scripts/schemas/converge.fix-allow-list.json',
    artifactDir: options.artifactDir || 'converge-artifacts',
    preview: Boolean(options.preview)
  };

  let criteriaConfig;
  let allowListConfig;

  try {
    if (!existsSync(merged.criteriaFile)) {
      throw new Error(`Criteria file not found: ${merged.criteriaFile}`);
    }
    if (!existsSync(merged.allowListFile)) {
      throw new Error(`Allow-list file not found: ${merged.allowListFile}`);
    }

    criteriaConfig = validateCriteriaConfig(await readJson(merged.criteriaFile));
    allowListConfig = validateFixAllowList(await readJson(merged.allowListFile));
  } catch (error) {
    const result = resolveResult(EXIT_CODES.CONFIG_INVALID, 'Invalid convergence configuration', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeLatestArtifact(merged.artifactDir, result);
    return result;
  }

  const requiredTools = criteriaConfig.requiredTools || {};
  const missingTools = [];

  for (const [toolName, toolSpec] of Object.entries(requiredTools)) {
    const commands = Array.isArray(toolSpec.commands)
      ? toolSpec.commands
      : toolSpec.command
      ? [toolSpec.command]
      : [];

    let matched = null;
    for (const cmd of commands) {
      matched = probeCommand(cmd);
      if (matched) break;
    }

    if (!matched) {
      missingTools.push({ tool: toolName, commands });
      continue;
    }

    if (toolSpec.minVersion && !isVersionAtLeast(matched.version, toolSpec.minVersion)) {
      missingTools.push({ tool: toolName, commands, reason: `version below ${toolSpec.minVersion}` });
    }
  }

  if (missingTools.length > 0) {
    const result = resolveResult(EXIT_CODES.ENV_FAILURE, 'Required tools are missing or incompatible', {
      missingTools
    });
    await writeLatestArtifact(merged.artifactDir, result);
    return result;
  }

  const result = resolveResult(EXIT_CODES.OK, merged.preview ? 'Preview successful' : 'Convergence checks passed', {
    criteriaCount: criteriaConfig.criteria.length,
    approvedFixers: allowListConfig.approvedFixers.length,
    preview: merged.preview
  });

  await writeLatestArtifact(merged.artifactDir, result);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await executeConvergence(options);
  process.exitCode = result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[converge-plan] fatal:', error);
    process.exitCode = EXIT_CODES.EXECUTION_FAILURE;
  });
}
