#!/usr/bin/env node
/**
 * Purpose: Submit one synthetic async GPT job against a live Railway app and verify it reaches a terminal completed state.
 * Inputs/Outputs: Reads CLI args, POSTs one async request, polls the returned job endpoint, prints one PASS/FAIL line, and exits non-zero on failure.
 * Edge cases: Supports inline 200 completions, 202 pending responses, transient polling delays, and explicit terminal failure statuses.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PROBE_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL'
});

export const DEFAULTS = Object.freeze({
  baseUrl: 'https://acranos-production.up.railway.app',
  gptId: 'arcanos-core',
  prompt: 'Reply with the single word PONG.',
  timeoutMs: 30_000,
  pollIntervalMs: 750,
  requestTimeoutMs: 15_000
});

function readPositiveInteger(rawValue, fallbackValue) {
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

/**
 * Purpose: Parse CLI flags into one normalized probe configuration.
 * Inputs/Outputs: argv string array -> config object.
 * Edge cases: Invalid numeric flags fall back to defaults so operator typos do not silently disable the probe.
 *
 * @param {string[]} argv - Raw process arguments after the script path.
 * @returns {typeof DEFAULTS}
 */
export function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const argFlag = argv[index];
    const next = argv[index + 1];

    if (argFlag === '--base-url' && typeof next === 'string' && next.trim().length > 0) {
      config.baseUrl = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--gpt-id' && typeof next === 'string' && next.trim().length > 0) {
      config.gptId = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--prompt' && typeof next === 'string' && next.trim().length > 0) {
      config.prompt = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.timeoutMs = readPositiveInteger(next, DEFAULTS.timeoutMs);
      index += 1;
      continue;
    }

    if (argFlag === '--poll-interval-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.pollIntervalMs = readPositiveInteger(next, DEFAULTS.pollIntervalMs);
      index += 1;
      continue;
    }

    if (argFlag === '--request-timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.requestTimeoutMs = readPositiveInteger(next, DEFAULTS.requestTimeoutMs);
      index += 1;
    }
  }

  return config;
}

function normalizeBaseUrl(baseUrl) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(normalizedBaseUrl)
    ? normalizedBaseUrl
    : `https://${normalizedBaseUrl}`;
}

function buildFailure(detail) {
  return {
    status: PROBE_STATUS.FAIL,
    detail
  };
}

function buildSuccess(detail) {
  return {
    status: PROBE_STATUS.PASS,
    detail
  };
}

function buildResultUrl(baseUrl, pollPath) {
  const normalizedPollPath = String(pollPath ?? '').trim();
  if (!normalizedPollPath) {
    throw new Error('Async probe response did not include a poll path.');
  }

  const absolutePollUrl = normalizedPollPath.startsWith('http://') || normalizedPollPath.startsWith('https://')
    ? normalizedPollPath
    : `${baseUrl}${normalizedPollPath.startsWith('/') ? normalizedPollPath : `/${normalizedPollPath}`}`;

  return absolutePollUrl.endsWith('/result')
    ? absolutePollUrl
    : `${absolutePollUrl.replace(/\/+$/, '')}/result`;
}

function createRequestTimeoutSignal(timeoutMs) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  return {
    signal: abortController.signal,
    dispose() {
      clearTimeout(timeoutHandle);
    }
  };
}

async function readJsonResponse(response) {
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    return {
      ok: false,
      bodyText,
      parsedBody: null
    };
  }

  try {
    return {
      ok: true,
      bodyText,
      parsedBody: JSON.parse(bodyText)
    };
  } catch {
    return {
      ok: false,
      bodyText,
      parsedBody: null
    };
  }
}

function extractTerminalStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const status = typeof payload.status === 'string'
    ? payload.status.trim().toLowerCase()
    : '';

  return status.length > 0 ? status : null;
}

/**
 * Purpose: Submit one synthetic async GPT request and either return the inline result or the queued job coordinates.
 * Inputs/Outputs: Probe config + injected fetch -> normalized enqueue response.
 * Edge cases: Accepts 200 inline completion or 202 queue acceptance; all other responses fail closed with body context.
 *
 * @param {typeof DEFAULTS} config - Normalized probe configuration.
 * @param {{ fetchFn?: typeof fetch }} dependencies - Injectable dependencies for tests.
 * @returns {Promise<{ mode: 'inline'; body: Record<string, unknown> } | { mode: 'queued'; jobId: string; resultUrl: string }>}
 */
export async function enqueueAsyncProbe(config, dependencies = {}) {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);
  const requestUrl = `${normalizedBaseUrl}/gpt/${encodeURIComponent(config.gptId)}`;
  const timeout = createRequestTimeoutSignal(config.requestTimeoutMs);

  try {
    const response = await fetchFn(requestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'arcanos-railway-async-job-probe/1.0'
      },
      body: JSON.stringify({
        message: config.prompt,
        async: true
      }),
      signal: timeout.signal
    });
    const parsedResponse = await readJsonResponse(response);

    if (!parsedResponse.ok || !parsedResponse.parsedBody || typeof parsedResponse.parsedBody !== 'object' || Array.isArray(parsedResponse.parsedBody)) {
      throw new Error(`Probe request returned non-JSON body (status=${response.status}).`);
    }

    if (response.status === 200) {
      return {
        mode: 'inline',
        body: parsedResponse.parsedBody
      };
    }

    if (response.status !== 202) {
      throw new Error(`Probe request failed with status=${response.status}, body=${parsedResponse.bodyText}`);
    }

    const jobId = typeof parsedResponse.parsedBody.jobId === 'string'
      ? parsedResponse.parsedBody.jobId.trim()
      : '';
    const pollPath = typeof parsedResponse.parsedBody.poll === 'string'
      ? parsedResponse.parsedBody.poll.trim()
      : '';

    if (!jobId || !pollPath) {
      throw new Error(`Probe request returned incomplete async metadata: ${parsedResponse.bodyText}`);
    }

    return {
      mode: 'queued',
      jobId,
      resultUrl: buildResultUrl(normalizedBaseUrl, pollPath)
    };
  } finally {
    timeout.dispose();
  }
}

/**
 * Purpose: Poll the queued async GPT job until completion or timeout.
 * Inputs/Outputs: Probe config + job coordinates + injected fetch/sleep/time deps -> one PASS/FAIL result.
 * Edge cases: Missing jobs, failed jobs, cancelled jobs, expired jobs, and timeout windows all fail with explicit detail.
 *
 * @param {typeof DEFAULTS} config - Normalized probe configuration.
 * @param {{ jobId: string; resultUrl: string }} queuedProbe - Queued job coordinates.
 * @param {{ fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void>; nowFn?: () => number }} dependencies - Injectable dependencies for tests.
 * @returns {Promise<{ status: 'PASS'|'FAIL'; detail: string }>}
 */
export async function pollAsyncProbe(config, queuedProbe, dependencies = {}) {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const sleepFn = dependencies.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowFn = dependencies.nowFn ?? Date.now;
  const deadlineMs = nowFn() + config.timeoutMs;

  while (nowFn() <= deadlineMs) {
    const timeout = createRequestTimeoutSignal(config.requestTimeoutMs);

    try {
      const response = await fetchFn(queuedProbe.resultUrl, {
        method: 'GET',
        headers: {
          'user-agent': 'arcanos-railway-async-job-probe/1.0'
        },
        signal: timeout.signal
      });
      const parsedResponse = await readJsonResponse(response);

      if (!response.ok) {
        return buildFailure(`Queued probe job ${queuedProbe.jobId} lookup failed with status=${response.status}.`);
      }

      if (!parsedResponse.ok || !parsedResponse.parsedBody || typeof parsedResponse.parsedBody !== 'object' || Array.isArray(parsedResponse.parsedBody)) {
        return buildFailure(`Queued probe job ${queuedProbe.jobId} lookup returned a non-JSON body.`);
      }

      const terminalStatus = extractTerminalStatus(parsedResponse.parsedBody);

      if (terminalStatus === 'completed') {
        return buildSuccess(`Async probe job ${queuedProbe.jobId} completed successfully via ${queuedProbe.resultUrl}.`);
      }

      if (
        terminalStatus === 'failed'
        || terminalStatus === 'cancelled'
        || terminalStatus === 'expired'
        || terminalStatus === 'not_found'
      ) {
        const errorMessage =
          typeof parsedResponse.parsedBody?.error?.message === 'string'
            ? parsedResponse.parsedBody.error.message
            : 'terminal failure';
        return buildFailure(`Async probe job ${queuedProbe.jobId} ended in status=${terminalStatus}: ${errorMessage}`);
      }
    } finally {
      timeout.dispose();
    }

    const remainingMs = deadlineMs - nowFn();
    if (remainingMs <= 0) {
      break;
    }

    await sleepFn(Math.min(config.pollIntervalMs, remainingMs));
  }

  return buildFailure(`Async probe job ${queuedProbe.jobId} did not complete within ${config.timeoutMs}ms.`);
}

/**
 * Purpose: Run one end-to-end async-job probe against the configured Railway app.
 * Inputs/Outputs: Config + injected deps -> PASS/FAIL result object.
 * Edge cases: Inline completion short-circuits immediately while queued completion falls through to polling.
 *
 * @param {typeof DEFAULTS} config - Normalized probe configuration.
 * @param {{ fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void>; nowFn?: () => number }} dependencies - Injectable dependencies for tests.
 * @returns {Promise<{ status: 'PASS'|'FAIL'; detail: string }>}
 */
export async function runAsyncProbe(config, dependencies = {}) {
  const enqueueResult = await enqueueAsyncProbe(config, dependencies);

  if (enqueueResult.mode === 'inline') {
    return buildSuccess(`Async probe completed inline from /gpt/${config.gptId}.`);
  }

  return pollAsyncProbe(config, enqueueResult, dependencies);
}

export function printProbeResult(result) {
  process.stdout.write(`[${result.status}] ${result.detail}\n`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const result = await runAsyncProbe(config);
  printProbeResult(result);
  process.exitCode = result.status === PROBE_STATUS.PASS ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    printProbeResult(buildFailure(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
