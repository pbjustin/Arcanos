/**
 * Shared, execution-free infrastructure for the standalone Railway GPT probes.
 * Keep response validation and polling policy in each probe.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PROBE_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
});

const STRING_FLAGS = new Map([
  ['--base-url', 'baseUrl'],
  ['--gpt-id', 'gptId'],
  ['--prompt', 'prompt'],
]);

export function readPositiveInteger(rawValue, fallbackValue) {
  const parsedValue = Number(rawValue);
  // Preserve the probes' existing truncation, including positive fractions below one.
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

export function parseProbeArgs(argv, defaults, additionalIntegerFlags = {}) {
  const config = { ...defaults };
  const integerFlags = new Map([
    ['--request-timeout-ms', 'requestTimeoutMs'],
    ...Object.entries(additionalIntegerFlags),
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argFlag = argv[index];
    const next = argv[index + 1];
    if (typeof next !== 'string' || next.trim().length === 0) {
      continue;
    }

    const stringKey = STRING_FLAGS.get(argFlag);
    const integerKey = integerFlags.get(argFlag);
    if (stringKey) {
      config[stringKey] = next.trim();
      index += 1;
    } else if (integerKey) {
      config[integerKey] = readPositiveInteger(next, defaults[integerKey]);
      index += 1;
    }
  }

  return config;
}

export function normalizeBaseUrl(baseUrl) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(normalizedBaseUrl)
    ? normalizedBaseUrl
    : `https://${normalizedBaseUrl}`;
}

export function createRequestTimeoutSignal(timeoutMs) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  return {
    signal: abortController.signal,
    dispose() {
      clearTimeout(timeoutHandle);
    },
  };
}

export async function readJsonResponse(response) {
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    return { ok: false, bodyText, parsedBody: null };
  }

  try {
    return { ok: true, bodyText, parsedBody: JSON.parse(bodyText) };
  } catch {
    return { ok: false, bodyText, parsedBody: null };
  }
}

export function buildFailure(detail) {
  return { status: PROBE_STATUS.FAIL, detail };
}

export function buildSuccess(detail) {
  return { status: PROBE_STATUS.PASS, detail };
}

export function printProbeResult(result) {
  process.stdout.write(`[${result.status}] ${result.detail}\n`);
}

export function isDirectExecution(moduleUrl, argv = process.argv) {
  return Boolean(argv[1] && moduleUrl === pathToFileURL(argv[1]).href);
}
