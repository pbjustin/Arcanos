#!/usr/bin/env node
/**
 * Purpose: Submit one synthetic GPT fast-path request against a live Railway app and verify it returns inline.
 * Inputs/Outputs: Reads CLI args, POSTs one fast prompt-generation request, prints one PASS/FAIL line, exits non-zero on failure.
 * Edge cases: Fails if the response is queued, if route metadata is missing, or if the backend returns non-JSON.
 */

import process from 'node:process';
import {
  PROBE_STATUS,
  buildFailure,
  buildSuccess,
  createRequestTimeoutSignal,
  isDirectExecution,
  normalizeBaseUrl,
  parseProbeArgs,
  printProbeResult,
  readJsonResponse,
} from './lib/railway-probe.mjs';

export { PROBE_STATUS, printProbeResult };

export const RAILWAY_PRODUCTION_BASE_URL = 'https://acranos-production.up.railway.app';

export const DEFAULTS = Object.freeze({
  baseUrl:
    process.env.ARCANOS_BACKEND_URL ||
    process.env.RAILWAY_SERVICE_ARCANOS_V2_URL ||
    process.env.RAILWAY_STATIC_URL ||
    // Railway assigned this service the "acranos" production domain; keep it aligned with the async and smoke probes.
    RAILWAY_PRODUCTION_BASE_URL,
  gptId: 'arcanos-core',
  prompt: 'Generate a concise prompt for a deployment smoke test.',
  requestTimeoutMs: 15_000,
});

export function parseArgs(argv) {
  return parseProbeArgs(argv, DEFAULTS);
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

/**
 * Submit one configured request and require HTTP 200, an object body, no queued
 * job ID, and explicit inline fast-path metadata. Validation returns PASS/FAIL;
 * transport/body-read failures propagate, with the request timer always disposed.
 * Tests inject fetchFn; the default fetch performs a real network request.
 */
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

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const result = await runFastPathProbe(config);
  printProbeResult(result);
  process.exitCode = result.status === PROBE_STATUS.PASS ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    printProbeResult(buildFailure(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
