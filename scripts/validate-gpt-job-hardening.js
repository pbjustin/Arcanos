#!/usr/bin/env node
/**
 * Purpose: Validate GPT async hardening behavior against a live ARCANOS deployment and optional Railway logs.
 * Inputs/Outputs: Calls the public GPT/job endpoints plus Railway CLI log filters and prints one deterministic JSON report.
 * Edge cases: Handles missing job ids, slow jobs, Railway CLI unavailability, and non-JSON HTTP error bodies without silent success.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULTS = Object.freeze({
  baseUrl: process.env.ARCANOS_GPT_ACCESS_BASE_URL ||
    process.env.ARCANOS_BASE_URL ||
    process.env.ARCANOS_BACKEND_URL ||
    process.env.SERVER_URL ||
    process.env.BACKEND_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.RAILWAY_PUBLIC_URL ||
    process.env.RAILWAY_STATIC_URL ||
    '',
  healthPath: '/gpt-access/health',
  gptId: 'arcanos-core',
  gatewayCredential: process.env.ARCANOS_GPT_ACCESS_TOKEN || process.env.GPT_ACCESS_TOKEN || '',
  environment: '',
  service: '',
  workerService: '',
  logSince: '10m',
  logLines: 80,
  requestTimeoutMs: 30000,
  pollAttempts: 45,
  pollIntervalMs: 2000
});

function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--base-url' && typeof next === 'string' && next.trim().length > 0) {
      config.baseUrl = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--health-path' && typeof next === 'string' && next.trim().length > 0) {
      config.healthPath = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--gpt-id' && typeof next === 'string' && next.trim().length > 0) {
      config.gptId = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--access-token' && typeof next === 'string' && next.trim().length > 0) {
      config.gatewayCredential = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--environment' && typeof next === 'string' && next.trim().length > 0) {
      config.environment = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--service' && typeof next === 'string' && next.trim().length > 0) {
      config.service = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--worker-service' && typeof next === 'string' && next.trim().length > 0) {
      config.workerService = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--log-since' && typeof next === 'string' && next.trim().length > 0) {
      config.logSince = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--log-lines' && typeof next === 'string' && next.trim().length > 0) {
      const parsed = Number(next);
      config.logLines = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULTS.logLines;
      index += 1;
      continue;
    }

    if (flag === '--request-timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      const parsed = Number(next);
      config.requestTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULTS.requestTimeoutMs;
      index += 1;
      continue;
    }

    if (flag === '--poll-attempts' && typeof next === 'string' && next.trim().length > 0) {
      const parsed = Number(next);
      config.pollAttempts = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULTS.pollAttempts;
      index += 1;
      continue;
    }

    if (flag === '--poll-interval-ms' && typeof next === 'string' && next.trim().length > 0) {
      const parsed = Number(next);
      config.pollIntervalMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULTS.pollIntervalMs;
      index += 1;
      continue;
    }

  }

  return config;
}

function createCheck(name, passed, details = {}) {
  return {
    name,
    status: passed ? 'PASS' : 'FAIL',
    details
  };
}

function normalizeBaseUrl(rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (trimmed.length === 0) {
    throw new Error('Missing --base-url and no backend URL env var was set.');
  }

  return trimmed.replace(/\/+$/, '');
}

async function requestJson(url, options = {}, timeoutMs = DEFAULTS.requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;

    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildJsonHeaders(extraHeaders = {}) {
  return {
    'content-type': 'application/json',
    ...extraHeaders
  };
}

function buildAuthorizedJsonHeaders(gatewayCredential, extraHeaders = {}) {
  const headers = buildJsonHeaders(extraHeaders);
  if (gatewayCredential) {
    headers.authorization = `Bearer ${gatewayCredential}`;
  }
  return headers;
}

function buildAuthorizedHeaders(gatewayCredential, extraHeaders = {}) {
  return gatewayCredential
    ? { authorization: `Bearer ${gatewayCredential}`, ...extraHeaders }
    : { ...extraHeaders };
}

function hashValue(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

function extractJobId(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  return String(payload.jobId || payload.job?.id || '').trim();
}

function extractStatus(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  return String(payload.status || payload.jobStatus || payload.lifecycleStatus || '').trim();
}

async function pollGptAccessJobResult(baseUrl, jobId, traceId, config, gatewayCredential) {
  const resultUrl = `${baseUrl}/gpt-access/jobs/result`;
  let lastResponse = null;

  for (let attempt = 0; attempt < config.pollAttempts; attempt += 1) {
    lastResponse = await requestJson(
      resultUrl,
      {
        method: 'POST',
        headers: buildAuthorizedJsonHeaders(gatewayCredential),
        body: JSON.stringify({
          jobId,
          ...(traceId ? { traceId } : {})
        })
      },
      config.requestTimeoutMs
    );

    if (lastResponse.ok && isTerminalStatus(extractStatus(lastResponse.json))) {
      return {
        completed: true,
        attempts: attempt + 1,
        response: lastResponse
      };
    }

    await sleep(config.pollIntervalMs);
  }

  return {
    completed: false,
    attempts: config.pollAttempts,
    response: lastResponse
  };
}

function isTerminalStatus(status) {
  return ['completed', 'failed', 'cancelled', 'expired'].includes(status);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function executeRailwayCommand(args) {
  const execOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  };

  const candidates = process.platform === 'win32'
    ? [
        { file: 'railway', args, options: execOptions },
        { file: 'railway.exe', args, options: execOptions }
      ]
    : [{ file: 'railway', args, options: execOptions }];

  let lastError = null;

  for (const candidate of candidates) {
    try {
      return execFileSync(candidate.file, candidate.args, candidate.options);
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const railwayShimPath = join(appData, 'npm', 'railway.ps1');

    if (existsSync(railwayShimPath)) {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', railwayShimPath, ...args],
        execOptions
      );
    }
  }

  throw lastError || new Error('Failed to execute Railway CLI.');
}

function searchLogs(serviceName, environmentName, filter, since, lines) {
  if (!serviceName || !environmentName) {
    return {
      skipped: true,
      filterHash: hashValue(filter),
      matches: false,
      output: ''
    };
  }

  const rawOutput = executeRailwayCommand([
    'logs',
    '--service',
    serviceName,
    '--environment',
    environmentName,
    '--since',
    since,
    '--filter',
    filter,
    '--lines',
    String(lines)
  ]);

  const normalized = rawOutput.trim();
  const sanitizedOutput = normalized.split(filter).join('[REDACTED_MARKER]');

  return {
    skipped: false,
    filterHash: hashValue(filter),
    matches: normalized.length > 0,
    output: truncate(sanitizedOutput, 1200)
  };
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

async function runValidation(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timestamp = Date.now();
  const promptMarker = `QA-GPT-ACCESS-CREATE-${timestamp}`;
  const fakeSecretMarker = `sk-test-gpt-access-hardening-${timestamp}`;
  const idemKey = `qa-gpt-access-create-${timestamp}`;
  const createEndpoint = `${baseUrl}/gpt-access/jobs/create`;
  const resultEndpoint = '/gpt-access/jobs/result';
  const openApiEndpoint = `${baseUrl}/gpt-access/openapi.json`;
  const gatewayCredential = typeof config.gatewayCredential === 'string' ? config.gatewayCredential.trim() : '';

  const report = {
    target: {
      baseUrl,
      gptId: config.gptId,
      environment: config.environment,
      service: config.service,
      workerService: config.workerService,
      authConfigured: gatewayCredential.length > 0
    },
    markers: {
      promptMarkerHash: hashValue(promptMarker),
      fakeSecretMarkerHash: hashValue(fakeSecretMarker),
      idemKeyHash: hashValue(idemKey)
    },
    checks: []
  };

  if (!gatewayCredential) {
    report.checks.push(createCheck('access_token_configured', false, {
      env: 'ARCANOS_GPT_ACCESS_TOKEN'
    }));
    report.summary = {
      overall: 'FAIL',
      failedChecks: 1
    };
    return report;
  }

  report.checks.push(createCheck('access_token_configured', true));

  const healthResponse = await requestJson(
    `${baseUrl}${config.healthPath}`,
    {
      method: 'GET',
      headers: buildAuthorizedHeaders(gatewayCredential)
    },
    config.requestTimeoutMs
  );
  report.checks.push(
    createCheck('health', healthResponse.status === 200, {
      status: healthResponse.status,
      body: healthResponse.json || healthResponse.text
    })
  );

  const openApiResponse = await requestJson(
    openApiEndpoint,
    {
      method: 'GET',
      headers: buildAuthorizedHeaders(gatewayCredential)
    },
    config.requestTimeoutMs
  );
  const createOperation = openApiResponse.json?.paths?.['/gpt-access/jobs/create']?.post;
  const createRequestSchemaRef = createOperation?.requestBody?.content?.['application/json']?.schema?.$ref;
  const createRequestSchemaName = typeof createRequestSchemaRef === 'string'
    ? createRequestSchemaRef.replace('#/components/schemas/', '')
    : '';
  const createRequestSchema = createRequestSchemaName
    ? openApiResponse.json?.components?.schemas?.[createRequestSchemaName]
    : null;
  const unsafeSchemaFields = ['sql', 'target', 'endpoint', 'headers', 'auth', 'cookies', 'proxy', 'url']
    .filter((field) => Object.prototype.hasOwnProperty.call(createRequestSchema?.properties ?? {}, field));
  report.checks.push(
    createCheck('openapi_createAiJob_contract', openApiResponse.status === 200
      && createOperation?.operationId === 'createAiJob'
      && JSON.stringify(createOperation?.security ?? openApiResponse.json?.security ?? []).includes('bearerAuth')
      && createRequestSchema?.additionalProperties === false
      && unsafeSchemaFields.length === 0,
      {
        status: openApiResponse.status,
        operationId: createOperation?.operationId ?? null,
        requestAdditionalProperties: createRequestSchema?.additionalProperties ?? null,
        unsafeSchemaFields
      }
    )
  );

  const createResponse = await requestJson(
    createEndpoint,
    {
      method: 'POST',
      headers: buildAuthorizedJsonHeaders(gatewayCredential, {
        'Idempotency-Key': idemKey
      }),
      body: JSON.stringify({
        gptId: config.gptId,
        task: `${promptMarker} Generate a concise Codex IDE validation prompt. Do not expose ${fakeSecretMarker}.`,
        input: {
          purpose: 'gpt access createAiJob hardening validation',
          promptMarkerHash: hashValue(promptMarker)
        }
      })
    },
    config.requestTimeoutMs
  );
  const createPayload = createResponse.json;
  const createdJobId = extractJobId(createPayload);
  const traceId = typeof createPayload?.traceId === 'string' ? createPayload.traceId : '';
  report.checks.push(
    createCheck('createAiJob_submit', createResponse.status === 202
      && createdJobId.length > 0
      && typeof createPayload?.traceId === 'string'
      && ['queued', 'running', 'completed', 'failed'].includes(String(createPayload?.status ?? '')),
      {
        status: createResponse.status,
        jobId: createdJobId,
        traceIdPresent: typeof createPayload?.traceId === 'string',
        createStatus: createPayload?.status ?? null,
        resultEndpoint
      }
    )
  );

  const resultPoll = createdJobId
    ? await pollGptAccessJobResult(baseUrl, createdJobId, traceId, config, gatewayCredential)
    : null;
  const resultPayload = resultPoll?.response?.json ?? null;

  report.checks.push(
    createCheck('job_result_endpoint_read',
      Boolean(resultPoll?.response?.ok)
        && extractJobId(resultPayload) === createdJobId,
      {
        status: resultPoll?.response?.status ?? null,
        attempts: resultPoll?.attempts ?? null,
        terminal: Boolean(resultPoll?.completed),
        jobId: extractJobId(resultPayload),
        resultStatus: extractStatus(resultPayload)
      }
    )
  );

  const webPromptLogs = searchLogs(config.service, config.environment, promptMarker, config.logSince, config.logLines);
  const workerPromptLogs = searchLogs(config.workerService, config.environment, promptMarker, config.logSince, config.logLines);
  const webSecretLogs = searchLogs(config.service, config.environment, fakeSecretMarker, config.logSince, config.logLines);
  const workerSecretLogs = searchLogs(config.workerService, config.environment, fakeSecretMarker, config.logSince, config.logLines);
  report.checks.push(
    createCheck('prompt_marker_absent_from_logs',
      !webPromptLogs.matches && !workerPromptLogs.matches,
      {
        web: webPromptLogs,
        worker: workerPromptLogs
      }
    )
  );
  report.checks.push(
    createCheck('fake_secret_marker_absent_from_logs',
      !webSecretLogs.matches && !workerSecretLogs.matches,
      {
        web: webSecretLogs,
        worker: workerSecretLogs
      }
    )
  );

  const failedChecks = report.checks.filter((check) => check.status === 'FAIL').length;
  report.summary = {
    overall: failedChecks > 0 ? 'FAIL' : 'PASS',
    failedChecks
  };

  return report;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const report = await runValidation(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.summary.overall === 'PASS' ? 0 : 1;
}

main().catch((error) => {
  const report = {
    summary: {
      overall: 'FAIL',
      failedChecks: 1
    },
    error: error instanceof Error ? error.message : String(error)
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
});
