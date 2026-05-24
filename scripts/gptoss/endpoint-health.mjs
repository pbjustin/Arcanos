#!/usr/bin/env node
/**
 * Purpose: Check a local OpenAI-compatible GPT-OSS endpoint without touching Arcanos runtime paths.
 * Inputs/Outputs: Reads GPTOSS_API_BASE_URL, GPTOSS_LOCAL_API_BASE_URL, or --base-url, prints deterministic JSON.
 * Edge cases: Refuses non-loopback URLs by default so Railway/Trinity traffic cannot be redirected locally.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function parsePositiveInteger(rawValue, label) {
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return Math.trunc(parsedValue);
}

export function parseArgs(argv) {
  const config = {
    baseUrl: process.env.GPTOSS_API_BASE_URL || process.env.GPTOSS_LOCAL_API_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.GPTOSS_MODEL || process.env.GPTOSS_LOCAL_MODEL || DEFAULT_MODEL,
    timeoutMs: process.env.GPTOSS_LOCAL_HEALTH_TIMEOUT_MS
      ? parsePositiveInteger(process.env.GPTOSS_LOCAL_HEALTH_TIMEOUT_MS, 'GPTOSS_LOCAL_HEALTH_TIMEOUT_MS')
      : DEFAULT_TIMEOUT_MS,
    allowNonLocal: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--base-url' && next) {
      config.baseUrl = next;
      index += 1;
      continue;
    }

    if (flag === '--model' && next) {
      config.model = next;
      index += 1;
      continue;
    }

    if (flag === '--timeout-ms' && next) {
      config.timeoutMs = parsePositiveInteger(next, '--timeout-ms');
      index += 1;
      continue;
    }

    if (flag === '--allow-non-local') {
      config.allowNonLocal = true;
      continue;
    }

    if (flag === '--dry-run') {
      config.dryRun = true;
      continue;
    }

    throw new Error(`Unknown or incomplete flag: ${flag}`);
  }

  return config;
}

export function normalizeBaseUrl(rawBaseUrl) {
  if (!rawBaseUrl) {
    throw new Error('Missing GPTOSS_API_BASE_URL, GPTOSS_LOCAL_API_BASE_URL, or --base-url');
  }

  const url = new URL(rawBaseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('GPT-OSS endpoint must use http or https');
  }

  return url;
}

export function assertLocalEndpoint(url, allowNonLocal) {
  if (!allowNonLocal && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Refusing non-loopback GPT-OSS endpoint without --allow-non-local');
  }
}

export function buildModelsUrl(baseUrl) {
  const normalizedPath = baseUrl.pathname.replace(/\/$/, '');
  const modelsPath = normalizedPath.endsWith('/v1') ? `${normalizedPath}/models` : `${normalizedPath}/v1/models`;
  return new URL(modelsPath, baseUrl.origin);
}

export async function probeEndpoint(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  assertLocalEndpoint(baseUrl, config.allowNonLocal);
  const modelsUrl = buildModelsUrl(baseUrl);

  const resultBase = {
    ok: false,
    dryRun: config.dryRun,
    baseUrl: baseUrl.toString(),
    modelsUrl: modelsUrl.toString(),
    model: config.model,
    localOnly: !config.allowNonLocal,
    timeoutMs: config.timeoutMs,
    boundary: 'local_gptoss_only_no_railway_no_trinity',
  };

  if (config.dryRun) {
    return {
      ...resultBase,
      ok: true,
      status: 'not_requested',
      modelAvailable: null,
      message: 'Dry-run only; endpoint was not contacted.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    const models = Array.isArray(body?.data) ? body.data : [];
    const modelAvailable = models.some((entry) => entry?.id === config.model);

    return {
      ...resultBase,
      ok: response.ok,
      status: response.status,
      modelAvailable,
      modelCount: models.length,
      message: response.ok ? 'GPT-OSS endpoint responded.' : 'GPT-OSS endpoint returned a non-2xx status.',
    };
  } catch (error) {
    return {
      ...resultBase,
      status: 'error',
      errorClass: error?.name === 'AbortError' ? 'timeout' : 'endpoint_unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const result = await probeEndpoint(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'gptoss_endpoint_health_failed',
      message: error instanceof Error ? error.message : String(error),
      boundary: 'local_gptoss_only_no_railway_no_trinity',
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
