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
import { pathToFileURL } from 'node:url';

import { RAILWAY_PRODUCTION_BASE_URL } from './railway-fast-path-probe.js';

const DEFAULTS = Object.freeze({
  baseUrl: '',
  baseUrlExplicit: false,
  target: '',
  targetExplicit: false,
  execute: false,
  allowNetwork: false,
  allowProduction: false,
  healthPath: '/gpt-access/health',
  gptId: 'arcanos-core',
  gatewayCredential: '',
  environment: '',
  environmentExplicit: false,
  service: '',
  workerService: '',
  logSince: '10m',
  logLines: 80,
  requestTimeoutMs: 30000,
  pollAttempts: 45,
  pollIntervalMs: 2000
});

const VALUE_FLAGS = Object.freeze({
  '--base-url': 'baseUrl',
  '--target': 'target',
  '--health-path': 'healthPath',
  '--gpt-id': 'gptId',
  '--environment': 'environment',
  '--service': 'service',
  '--worker-service': 'workerService',
  '--log-since': 'logSince',
  '--log-lines': 'logLines',
  '--request-timeout-ms': 'requestTimeoutMs',
  '--poll-attempts': 'pollAttempts',
  '--poll-interval-ms': 'pollIntervalMs'
});

const BOOLEAN_FLAGS = Object.freeze({
  '--execute': 'execute',
  '--allow-network': 'allowNetwork',
  '--allow-production': 'allowProduction'
});

const POSITIVE_INTEGER_FLAGS = new Set([
  '--log-lines',
  '--request-timeout-ms',
  '--poll-attempts',
  '--poll-interval-ms'
]);

export function parseArgs(argv, env = process.env) {
  const config = {
    ...DEFAULTS,
    gatewayCredential: env.ARCANOS_GPT_ACCESS_TOKEN || env.GPT_ACCESS_TOKEN || ''
  };
  const seenFlags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === '--access-token') {
      throw new Error('Do not pass GPT Access tokens as CLI arguments. Set ARCANOS_GPT_ACCESS_TOKEN in the local environment or Railway secret store.');
    }

    if (!Object.prototype.hasOwnProperty.call(VALUE_FLAGS, flag)
      && !Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, flag)) {
      throw new Error('Unknown argument.');
    }

    if (seenFlags.has(flag)) {
      throw new Error(`Duplicate argument: ${flag}`);
    }
    seenFlags.add(flag);

    if (Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, flag)) {
      config[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }

    const next = argv[index + 1];
    if (typeof next !== 'string' || next.trim().length === 0 || next.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.`);
    }

    if (POSITIVE_INTEGER_FLAGS.has(flag)) {
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer.`);
      }
      config[VALUE_FLAGS[flag]] = parsed;
    } else {
      config[VALUE_FLAGS[flag]] = next.trim();
    }

    if (flag === '--base-url') {
      config.baseUrlExplicit = true;
    } else if (flag === '--target') {
      config.targetExplicit = true;
    } else if (flag === '--environment') {
      config.environmentExplicit = true;
    }
    index += 1;
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

export function normalizeBaseUrl(rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (trimmed.length === 0) {
    throw new Error('Live validation requires an explicit --base-url. Ambient URL environment variables are ignored.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error('--base-url must be an absolute HTTP or HTTPS URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('--base-url must use HTTP or HTTPS.');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('--base-url must not contain credentials.');
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error('--base-url must not contain a query string or fragment.');
  }
  if (parsedUrl.pathname !== '/') {
    throw new Error('--base-url must not contain a path.');
  }

  return parsedUrl.origin;
}

function validateHealthPath(rawPath) {
  if (typeof rawPath !== 'string'
    || !rawPath.startsWith('/')
    || rawPath.startsWith('//')
    || rawPath.includes('?')
    || rawPath.includes('#')) {
    throw new Error('--health-path must be an absolute path without a host, query string, or fragment.');
  }
}

export function resolveExecutionPolicy(config) {
  if (Boolean(config.execute) !== Boolean(config.allowNetwork)) {
    throw new Error('Live validation requires both --execute and --allow-network. Neither flag enables network access by itself.');
  }

  const hasAnyTargetArgument = Boolean(
    config.baseUrlExplicit || config.targetExplicit || config.environmentExplicit
  );
  if (hasAnyTargetArgument
    && !(config.baseUrlExplicit && config.targetExplicit && config.environmentExplicit)) {
    throw new Error('Target selection requires explicit --base-url, --target, and --environment arguments together.');
  }

  if (!config.execute && !hasAnyTargetArgument) {
    if (config.allowProduction) {
      throw new Error('--allow-production requires an explicit production target.');
    }
    return {
      mode: 'DRY_RUN',
      executed: false,
      networkAttempted: false,
      baseUrl: '',
      target: '',
      environment: ''
    };
  }

  if (config.execute && !hasAnyTargetArgument) {
    throw new Error('Live validation requires explicit --base-url, --target, and --environment arguments.');
  }

  if (!['preview', 'local', 'production'].includes(config.target)) {
    throw new Error('--target must be exactly preview, local, or production.');
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const parsedUrl = new URL(baseUrl);
  validateHealthPath(config.healthPath);

  if (config.target === 'preview') {
    const environmentMatch = /^Arcanos-pr-(\d+)$/.exec(config.environment);
    if (!environmentMatch) {
      throw new Error('Preview validation requires --environment Arcanos-pr-N.');
    }
    const prNumber = environmentMatch[1];
    const expectedPreviewHostname = `arcanos-v2-arcanos-pr-${prNumber}.up.railway.app`;
    if (parsedUrl.protocol !== 'https:'
      || parsedUrl.port
      || parsedUrl.hostname !== expectedPreviewHostname) {
      throw new Error('Preview validation requires the canonical HTTPS Railway PR hostname matching --environment.');
    }
    if (config.allowProduction) {
      throw new Error('--allow-production conflicts with --target preview.');
    }
  } else if (config.target === 'local') {
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (config.environment !== 'local' || !loopbackHosts.has(parsedUrl.hostname)) {
      throw new Error('Local validation requires --environment local and an exact loopback hostname.');
    }
    if (config.service || config.workerService) {
      throw new Error('Local validation cannot request Railway service logs.');
    }
    if (config.allowProduction) {
      throw new Error('--allow-production conflicts with --target local.');
    }
  } else {
    const productionBaseUrl = new URL(RAILWAY_PRODUCTION_BASE_URL).origin;
    if (config.environment !== 'production'
      || !config.allowProduction
      || baseUrl !== productionBaseUrl) {
      throw new Error('Production validation requires the repository-known production URL, --environment production, and --allow-production.');
    }
  }

  return {
    mode: config.execute ? 'EXECUTE' : 'DRY_RUN',
    executed: Boolean(config.execute),
    networkAttempted: false,
    baseUrl,
    target: config.target,
    environment: config.environment
  };
}

export async function requestJson(url, options = {}, timeoutMs = DEFAULTS.requestTimeoutMs, fetchFn = fetch) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirect responses are not allowed during GPT job hardening validation.');
    }
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

const OUTPUT_REDACTIONS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(?:railway|rwy)[_-]?[A-Za-z0-9]{16,}\b/gi, '[REDACTED_RAILWAY_TOKEN]'],
  [/\b(?:postgres|postgresql|mysql|mongodb|redis|rediss):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]'],
  [/\b([a-z0-9_.-]*redis[a-z0-9_.-]*|redis(?:\s+[a-z][a-z0-9]*)*)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi, '$1=[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:authorization|cookie|set-cookie|api[_-]?key|openai[_-]?api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|openai[_-]?token|railway[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|session(?:id)?|database[_-]?url)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]']
]);

function sanitizeOutputString(value, knownSecrets = []) {
  let output = String(value);
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      output = output.split(secret).join('[REDACTED_SECRET_VALUE]');
    }
  }
  for (const [pattern, replacement] of OUTPUT_REDACTIONS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function sanitizeReportValue(value, knownSecrets = [], seen = new WeakSet()) {
  if (typeof value === 'string') {
    return sanitizeOutputString(value, knownSecrets);
  }
  if (typeof value === 'function') {
    return '[REDACTED_FUNCTION]';
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[REDACTED_CIRCULAR_REFERENCE]';
    }
    seen.add(value);
    try {
      if (value instanceof Error) {
        return sanitizeReportValue({
          ...Object.fromEntries(Object.entries(value)),
          name: value.name,
          message: value.message,
          ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
          ...('cause' in value ? { cause: value.cause } : {})
        }, knownSecrets, seen);
      }
      if (Array.isArray(value)) {
        return value.map((item) => sanitizeReportValue(item, knownSecrets, seen));
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          sanitizeOutputString(key, knownSecrets) === key ? key : '[REDACTED_KEY]',
          /(authorization|cookie|token|secret|password|database[_-]?url|api[_-]?key|redis)/i.test(key)
            ? '[REDACTED]'
            : sanitizeReportValue(entry, knownSecrets, seen)
        ])
      );
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

export function buildFailureReport(error, options = {}) {
  const gatewayCredential = typeof options.gatewayCredential === 'string'
    ? options.gatewayCredential
    : '';
  const executionStarted = Boolean(options.executionPolicy?.executed);
  const rawErrorMessage = error instanceof Error ? error.message : String(error);
  const credentialRedactedMessage = gatewayCredential
    ? rawErrorMessage.split(gatewayCredential).join('[REDACTED_SECRET_VALUE]')
    : rawErrorMessage;
  const report = {
    mode: executionStarted ? 'EXECUTION_ERROR' : 'CONFIGURATION_ERROR',
    executed: executionStarted,
    networkAttempted: executionStarted,
    summary: {
      overall: 'FAIL',
      failedChecks: 1
    },
    error: sanitizeOutputString(credentialRedactedMessage, [gatewayCredential])
  };

  return sanitizeReportValue(report, [gatewayCredential]);
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

async function pollGptAccessJobResult(baseUrl, jobId, traceId, config, gatewayCredential, dependencies = {}) {
  const resultUrl = `${baseUrl}/gpt-access/jobs/result`;
  let lastResponse = null;
  const fetchFn = dependencies.fetchFn ?? fetch;
  const sleepFn = dependencies.sleepFn ?? sleep;

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
      config.requestTimeoutMs,
      fetchFn
    );

    if (lastResponse.ok && isTerminalStatus(extractStatus(lastResponse.json))) {
      return {
        completed: true,
        attempts: attempt + 1,
        response: lastResponse
      };
    }

    await sleepFn(config.pollIntervalMs);
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

function searchLogs(serviceName, environmentName, filter, since, lines, knownSecrets = [], railwayExecutor = executeRailwayCommand) {
  if (!serviceName || !environmentName) {
    return {
      skipped: true,
      filterHash: hashValue(filter),
      matches: false,
      output: ''
    };
  }

  const rawOutput = railwayExecutor([
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
  const sanitizedOutput = sanitizeOutputString(
    normalized.split(filter).join('[REDACTED_MARKER]'),
    knownSecrets
  );

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

function finalizeReport(report) {
  const failedChecks = report.checks.filter((check) => check.status === 'FAIL').length;
  report.summary = {
    overall: failedChecks > 0 ? 'FAIL' : 'PASS',
    failedChecks
  };
  return report;
}

function createDryRunReport(config, policy) {
  return {
    mode: 'DRY_RUN',
    executed: false,
    networkAttempted: false,
    target: {
      baseUrl: policy.baseUrl || null,
      target: policy.target || null,
      environment: policy.environment || null,
      service: config.service || null,
      workerService: config.workerService || null,
      authConfigured: typeof config.gatewayCredential === 'string' && config.gatewayCredential.trim().length > 0
    },
    checks: [
      createCheck('execution_policy', true, {
        mode: 'DRY_RUN',
        message: 'No HTTP requests or Railway CLI commands were attempted.'
      })
    ],
    summary: {
      overall: 'DRY_RUN',
      failedChecks: 0
    }
  };
}

export async function runValidation(config, dependencies = {}) {
  const policy = resolveExecutionPolicy(config);
  if (!policy.executed) {
    return createDryRunReport(config, policy);
  }

  const baseUrl = policy.baseUrl;
  const fetchFn = dependencies.fetchFn ?? fetch;
  const railwayExecutor = dependencies.railwayExecutor ?? executeRailwayCommand;
  const now = dependencies.now ?? Date.now;
  const timestamp = now();
  const promptMarker = `QA-GPT-ACCESS-CREATE-${timestamp}`;
  const fakeSecretMarker = `sk-test-gpt-access-hardening-${timestamp}`;
  const idemKey = `qa-gpt-access-create-${timestamp}`;
  const createEndpoint = `${baseUrl}/gpt-access/jobs/create`;
  const resultEndpoint = '/gpt-access/jobs/result';
  const openApiEndpoint = `${baseUrl}/gpt-access/openapi.json`;
  const gatewayCredential = typeof config.gatewayCredential === 'string' ? config.gatewayCredential.trim() : '';

  const report = {
    mode: 'EXECUTE',
    executed: true,
    networkAttempted: false,
    target: {
      baseUrl,
      target: policy.target,
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

  report.networkAttempted = true;
  const healthResponse = await requestJson(
    `${baseUrl}${config.healthPath}`,
    {
      method: 'GET',
      headers: buildAuthorizedHeaders(gatewayCredential)
    },
    config.requestTimeoutMs,
    fetchFn
  );
  const healthPassed = healthResponse.status === 200;
  report.checks.push(
    createCheck('health', healthPassed, {
      status: healthResponse.status
    })
  );
  if (!healthPassed) {
    return finalizeReport(report);
  }

  const openApiResponse = await requestJson(
    openApiEndpoint,
    {
      method: 'GET',
      headers: buildAuthorizedHeaders(gatewayCredential)
    },
    config.requestTimeoutMs,
    fetchFn
  );
  const createOperation = openApiResponse.json?.paths?.['/gpt-access/jobs/create']?.post;
  const createRequestSchemaRef = createOperation?.requestBody?.content?.['application/json']?.schema?.$ref;
  const createRequestSchemaName = typeof createRequestSchemaRef === 'string'
    ? createRequestSchemaRef.replace('#/components/schemas/', '')
    : '';
  const createRequestSchema = createRequestSchemaName
    ? openApiResponse.json?.components?.schemas?.[createRequestSchemaName]
    : null;
  const advertisedServerUrl = openApiResponse.json?.servers?.[0]?.url ?? null;
  const unsafeSchemaFields = ['sql', 'target', 'endpoint', 'headers', 'auth', 'cookies', 'proxy', 'url']
    .filter((field) => Object.prototype.hasOwnProperty.call(createRequestSchema?.properties ?? {}, field));
  const openApiServerMatches = openApiResponse.status === 200
    && advertisedServerUrl === baseUrl;
  const openApiContractMatches = openApiResponse.status === 200
    && createOperation?.operationId === 'createAiJob'
    && JSON.stringify(createOperation?.security ?? openApiResponse.json?.security ?? []).includes('bearerAuth')
    && createRequestSchema?.additionalProperties === false
    && unsafeSchemaFields.length === 0;
  report.checks.push(
    createCheck('openapi_server_url_matches_target',
      openApiServerMatches,
      {
        status: openApiResponse.status,
        serverUrlMatchesTarget: openApiServerMatches
      }
    )
  );
  report.checks.push(
    createCheck('openapi_createAiJob_contract', openApiContractMatches,
      {
        status: openApiResponse.status,
        operationId: createOperation?.operationId ?? null,
        requestAdditionalProperties: createRequestSchema?.additionalProperties ?? null,
        unsafeSchemaFields
      }
    )
  );
  if (!openApiServerMatches || !openApiContractMatches) {
    return finalizeReport(report);
  }

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
    config.requestTimeoutMs,
    fetchFn
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
    ? await pollGptAccessJobResult(baseUrl, createdJobId, traceId, config, gatewayCredential, {
        fetchFn,
        sleepFn: dependencies.sleepFn
      })
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

  const knownSecrets = [gatewayCredential, fakeSecretMarker, promptMarker].filter(Boolean);
  const webPromptLogs = searchLogs(config.service, config.environment, promptMarker, config.logSince, config.logLines, knownSecrets, railwayExecutor);
  const workerPromptLogs = searchLogs(config.workerService, config.environment, promptMarker, config.logSince, config.logLines, knownSecrets, railwayExecutor);
  const webSecretLogs = searchLogs(config.service, config.environment, fakeSecretMarker, config.logSince, config.logLines, knownSecrets, railwayExecutor);
  const workerSecretLogs = searchLogs(config.workerService, config.environment, fakeSecretMarker, config.logSince, config.logLines, knownSecrets, railwayExecutor);
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

  return finalizeReport(report);
}

let mainExecutionPolicy = null;
let mainGatewayCredential = '';

async function main() {
  mainGatewayCredential = process.env.ARCANOS_GPT_ACCESS_TOKEN || process.env.GPT_ACCESS_TOKEN || '';
  const config = parseArgs(process.argv.slice(2));
  mainGatewayCredential = config.gatewayCredential;
  mainExecutionPolicy = resolveExecutionPolicy(config);
  const report = await runValidation(config);
  process.stdout.write(`${JSON.stringify(sanitizeReportValue(report, [config.gatewayCredential]), null, 2)}\n`);
  process.exitCode = ['PASS', 'DRY_RUN'].includes(report.summary.overall) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const report = buildFailureReport(error, {
      gatewayCredential: mainGatewayCredential,
      executionPolicy: mainExecutionPolicy
    });

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  });
}
