#!/usr/bin/env node
/**
 * Purpose: Generate documentation updates through narrow ARCANOS async jobs.
 * Inputs/Outputs: reads CLI flags and auth env vars, polls ARCANOS jobs, writes a deterministic doc_analysis.json payload.
 * Edge cases: degraded ARCANOS pipeline fallback is treated as a failed section, not usable documentation.
 */

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { DocsGenerationError, generateDocsUpdate } from '@arcanos/cli/client';

export const DEFAULTS = Object.freeze({
  baseUrl: 'http://localhost:8080',
  gptId: 'arcanos-core',
  output: 'doc_analysis.json',
  directTimeoutMs: 25_000,
  totalTimeoutMs: 120_000,
  pollIntervalMs: 1_000,
  concurrency: 2,
  strict: true
});

function readPositiveInteger(rawValue, fallbackValue) {
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

export function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--base-url' && typeof next === 'string' && next.trim().length > 0) {
      config.baseUrl = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--gpt-id' && typeof next === 'string' && next.trim().length > 0) {
      config.gptId = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--output' && typeof next === 'string' && next.trim().length > 0) {
      config.output = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--direct-timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.directTimeoutMs = readPositiveInteger(next, DEFAULTS.directTimeoutMs);
      index += 1;
      continue;
    }

    if (flag === '--timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.totalTimeoutMs = readPositiveInteger(next, DEFAULTS.totalTimeoutMs);
      index += 1;
      continue;
    }

    if (flag === '--poll-interval-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.pollIntervalMs = readPositiveInteger(next, DEFAULTS.pollIntervalMs);
      index += 1;
      continue;
    }

    if (flag === '--concurrency' && typeof next === 'string' && next.trim().length > 0) {
      config.concurrency = readPositiveInteger(next, DEFAULTS.concurrency);
      index += 1;
      continue;
    }

    if (flag === '--allow-partial') {
      config.strict = false;
      continue;
    }

    if (flag === '--strict') {
      config.strict = true;
    }
  }

  return config;
}

function buildAuthHeaders() {
  const token =
    process.env.ARCANOS_API_KEY?.trim() ||
    process.env.BACKEND_API_KEY?.trim() ||
    process.env.CI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();

  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function runDocsUpdate(config) {
  return generateDocsUpdate({
    baseUrl: config.baseUrl,
    gptId: config.gptId,
    directTimeoutMs: config.directTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    maxConcurrency: config.concurrency,
    strict: config.strict,
    headers: buildAuthHeaders(),
    context: {
      source: 'auto-update-documentation',
      useRAG: false,
      scope: 'async-gpt-docs'
    }
  });
}

function writeResult(outputPath, result) {
  const payload = JSON.stringify(result, null, 2);
  writeFileSync(outputPath, `${payload}\n`, 'utf8');
  process.stdout.write(`Wrote documentation analysis to ${outputPath}\n`);
  process.stdout.write(`${result.summary}\n`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  try {
    const result = await runDocsUpdate(config);
    writeResult(config.output, result);
    process.exitCode = result.ok || !config.strict ? 0 : 1;
  } catch (error) {
    if (error instanceof DocsGenerationError) {
      writeResult(config.output, error.result);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
