#!/usr/bin/env node
/**
 * Purpose: Submit one synthetic GPT fast-path request against a live Railway app and verify it returns inline.
 * Inputs/Outputs: Reads CLI args, POSTs one fast prompt-generation request, prints one PASS/FAIL line, exits non-zero on failure.
 * Edge cases: Fails if the response is queued, if route metadata is missing, or if the backend returns non-JSON.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PROBE_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
});

export const DEFAULTS = Object.freeze({
  baseUrl:
    process.env.ARCANOS_BACKEND_URL ||
    process.env.RAILWAY_SERVICE_ARCANOS_V2_URL ||
    process.env.RAILWAY_STATIC_URL ||
    'https://acranos-production.up.railway.app',
  gptId: 'arcanos-core',
  prompt: 'Generate a concise prompt for a deployment smoke test.',
  requestTimeoutMs: 15_000,
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

function createRequestTimeoutSignal(timeoutMs) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  return {
    signal: abortController.signal,
    dispose() {
      clearTimeout(timeoutHandle);
    },
  };
}

async function readJsonResponse(response) {
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    return {
      ok: false,
      bodyText,
      parsedBody: null,
    };
  }

  try {
    return {
      ok: true,
      bodyText,
      parsedBody: JSON.parse(bodyText),
    };
  } catch {
    return {
      ok: false,
      bodyText,
      parsedBody: null,
    };
  }
}

function buildFailure(detail) {
  return {
    status: PROBE_STATUS.FAIL,
    detail,
  };
}

function buildSuccess(detail) {
  return {
    status: PROBE_STATUS.PASS,
    detail,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRouteDecision(payload, headers) {
  const bodyDecision = isRecord(payload.routeDecision) ? payload.routeDecision : {};
  const route = isRecord(payload._route) ? payload._route : {};
  return {
    path:
      typeof bodyDecision.path === 'string'
        ? bodyDecision.path
        : typeof route.route === 'string'
        ? route.route
        : headers.get?.('x-gpt-route-decision') ?? null,
    queueBypassed:
      typeof bodyDecision.queueBypassed === 'boolean'
        ? bodyDecision.queueBypassed
        : headers.get?.('x-gpt-queue-bypassed') === 'true',
    reason:
      typeof bodyDecision.reason === 'string'
        ? bodyDecision.reason
        : headers.get?.('x-gpt-route-decision-reason') ?? null,
  };
}

export async function runFastPathProbe(config, dependencies = {}) {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);
  const requestUrl = `${normalizedBaseUrl}/gpt/${encodeURIComponent(config.gptId)}`;
  const timeout = createRequestTimeoutSignal(config.requestTimeoutMs);

  try {
    const response = await fetchFn(requestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'arcanos-railway-fast-path-probe/1.0',
      },
      body: JSON.stringify({
        prompt: config.prompt,
        executionMode: 'fast',
      }),
      signal: timeout.signal,
    });
    const parsedResponse = await readJsonResponse(response);

    if (!parsedResponse.ok || !isRecord(parsedResponse.parsedBody)) {
      return buildFailure(`Fast-path probe returned non-JSON body (status=${response.status}).`);
    }

    if (response.status !== 200) {
      return buildFailure(`Fast-path probe expected HTTP 200 but received status=${response.status}.`);
    }

    if (typeof parsedResponse.parsedBody.jobId === 'string') {
      return buildFailure(`Fast-path probe unexpectedly queued job ${parsedResponse.parsedBody.jobId}.`);
    }

    const routeDecision = readRouteDecision(parsedResponse.parsedBody, response.headers);
    if (routeDecision.path !== 'fast_path' || routeDecision.queueBypassed !== true) {
      return buildFailure(
        `Fast-path probe did not return inline route metadata: path=${routeDecision.path ?? 'missing'}, queueBypassed=${routeDecision.queueBypassed}.`
      );
    }

    return buildSuccess(
      `Fast-path probe completed inline for /gpt/${config.gptId} (${routeDecision.reason ?? 'no-reason'}).`
    );
  } finally {
    timeout.dispose();
  }
}

export function printProbeResult(result) {
  process.stdout.write(`[${result.status}] ${result.detail}\n`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const result = await runFastPathProbe(config);
  printProbeResult(result);
  process.exitCode = result.status === PROBE_STATUS.PASS ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    printProbeResult(buildFailure(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
