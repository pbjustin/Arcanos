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

/**
 * Preserve the probes' legacy Number coercion and truncation for CLI values.
 * Non-finite or non-positive inputs use the supplied default; positive fractions
 * below one become zero. This is compatibility parsing, not a minimum bound.
 */
export function readPositiveInteger(rawValue, fallbackValue) {
  const parsedValue = Number(rawValue);
  // Preserve the probes' existing truncation, including positive fractions below one.
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

/**
 * Return a fresh config using the shared string flags and caller-owned numeric
 * flags. Unknown flags and blank/missing values are ignored; invalid numbers
 * reset that setting to its original default, even after an earlier override.
 * Values that look like flags remain values, preserving the existing CLI grammar.
 */
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

/**
 * Trim the target and trailing slashes, adding HTTPS when no HTTP(S) prefix exists.
 * This preserves operator-supplied targets; it does not validate or allowlist them.
 */
export function normalizeBaseUrl(baseUrl) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(normalizedBaseUrl)
    ? normalizedBaseUrl
    : `https://${normalizedBaseUrl}`;
}

/**
 * Create a request-scoped abort signal. Call dispose in finally after both fetch
 * and body consumption; disposal clears the timer without aborting completed work.
 * The signal relies on the consumer honoring abort and is not a total probe deadline.
 */
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

/**
 * Consume text once and retain it alongside the parsed JSON for probe-specific
 * validation. Empty or malformed JSON returns ok=false; body-read errors propagate.
 * Any JSON value may parse successfully. Retained raw text is not redacted.
 */
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

/**
 * Write the existing stdout diagnostic format without setting the process exit
 * code. Callers own outcome classification and any required detail redaction.
 */
export function printProbeResult(result) {
  process.stdout.write(`[${result.status}] ${result.detail}\n`);
}

/**
 * Compare a module URL with Node's entrypoint path so importing a probe does not
 * invoke its CLI. This preserves exact file-URL comparison, without realpath lookup.
 */
export function isDirectExecution(moduleUrl, argv = process.argv) {
  return Boolean(argv[1] && moduleUrl === pathToFileURL(argv[1]).href);
}
