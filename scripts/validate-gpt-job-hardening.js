#!/usr/bin/env node
/**
 * Purpose: Validate GPT async hardening behavior against a live ARCANOS deployment and optional Railway logs.
 * Inputs/Outputs: Calls the public GPT/job endpoints plus Railway CLI log filters and prints one deterministic JSON report.
 * Edge cases: Handles missing job ids, slow jobs, Railway CLI unavailability, and non-JSON HTTP error bodies without silent success.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULTS = Object.freeze({
  baseUrl: process.env.ARCANOS_BACKEND_URL || process.env.SERVER_URL || process.env.BACKEND_URL || '',
  healthPath: '/health',
  gptId: 'arcanos-core',
  environment: '',
  service: '',
  workerService: '',
  logSince: '10m',
  logLines: 80,
  requestTimeoutMs: 30000,
  pollAttempts: 45,
  pollIntervalMs: 2000,
  heavyWordCount: 500
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

    if (flag === '--heavy-word-count' && typeof next === 'string' && next.trim().length > 0) {
      const parsed = Number(next);
      config.heavyWordCount = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULTS.heavyWordCount;
      index += 1;
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

function buildHeavyPrompt(marker, heavyWordCount) {
  return `${marker} ${new Array(heavyWordCount).fill('Long workload').join(' ')}`.trim();
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

function extractOutput(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.output && typeof payload.output === 'object' && payload.output.result && typeof payload.output.result === 'object') {
    return payload.output.result;
  }

  if (payload.result && typeof payload.result === 'object' && payload.result.result && typeof payload.result.result === 'object') {
    return payload.result.result;
  }

  if (payload.result && typeof payload.result === 'object') {
    return payload.result;
  }

  if (payload.output && typeof payload.output === 'object') {
    return payload.output;
  }

  return payload;
}

function extractErrorCode(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (payload.error && typeof payload.error === 'object' && typeof payload.error.code === 'string') {
    return payload.error.code;
  }

  return typeof payload.code === 'string' ? payload.code : '';
}

async function pollJob(baseUrl, jobId, config) {
  const jobUrl = `${baseUrl}/jobs/${encodeURIComponent(jobId)}`;
  let lastResponse = null;

  for (let attempt = 0; attempt < config.pollAttempts; attempt += 1) {
    lastResponse = await requestJson(jobUrl, { method: 'GET' }, config.requestTimeoutMs);

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
      filter,
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

  return {
    skipped: false,
    filter,
    matches: normalized.length > 0,
    output: truncate(normalized, 1200)
  };
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

async function runValidation(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timestamp = Date.now();
  const heavyMarker = `QA-LIVE-HEAVY-${timestamp}`;
  const leakMarker = `QA-LIVE-LEAK-${timestamp}`;
  const idemKey = `qa-live-idem-${timestamp}`;
  const idemPrompt = `QA IDEM CHECK ${timestamp}`;
  const conflictPrompt = `DIFFERENT PAYLOAD ${timestamp}`;
  const endpoint = `${baseUrl}/gpt/${encodeURIComponent(config.gptId)}`;

  const report = {
    target: {
      baseUrl,
      gptId: config.gptId,
      environment: config.environment,
      service: config.service,
      workerService: config.workerService
    },
    markers: {
      heavyMarker,
      leakMarker,
      idemKey
    },
    checks: []
  };

  const healthResponse = await requestJson(`${baseUrl}${config.healthPath}`, { method: 'GET' }, config.requestTimeoutMs);
  report.checks.push(
    createCheck('health', healthResponse.status === 200, {
      status: healthResponse.status,
      body: healthResponse.json || healthResponse.text
    })
  );

  const heavySubmitResponse = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: buildJsonHeaders(),
      body: JSON.stringify({
        prompt: buildHeavyPrompt(heavyMarker, config.heavyWordCount),
        action: 'query'
      })
    },
    config.requestTimeoutMs
  );
  const heavySubmitPayload = heavySubmitResponse.json;
  const heavyJobId = extractJobId(heavySubmitPayload);
  const heavyPoll = heavyJobId ? await pollJob(baseUrl, heavyJobId, config) : null;
  const heavyJobPayload = heavyPoll?.response?.json ?? null;
  const heavyOutput = extractOutput(heavyJobPayload);

  report.checks.push(
    createCheck(
      'heavy_async_no_fallback',
      heavySubmitResponse.status === 202
        && heavyJobId.length > 0
        && Boolean(heavyPoll?.completed)
        && extractStatus(heavyJobPayload) === 'completed'
        && heavyOutput?.fallbackFlag === false
        && !heavyOutput?.timeoutKind,
      {
        submitStatus: heavySubmitResponse.status,
        jobId: heavyJobId,
        polled: Boolean(heavyPoll?.completed),
        terminalStatus: extractStatus(heavyJobPayload),
        fallbackFlag: heavyOutput?.fallbackFlag ?? null,
        timeoutKind: heavyOutput?.timeoutKind ?? null,
        activeModel: heavyOutput?.activeModel ?? null
      }
    )
  );

  const cancelResponse = heavyJobId
    ? await requestJson(
        `${baseUrl}/jobs/${encodeURIComponent(heavyJobId)}/cancel`,
        {
          method: 'POST',
          headers: buildJsonHeaders({
            'x-confirmed': 'yes'
          }),
          body: JSON.stringify({})
        },
        config.requestTimeoutMs
      )
    : null;

  report.checks.push(
    createCheck(
      'cancel_requires_auth',
      Boolean(cancelResponse) && [401, 403].includes(cancelResponse.status),
      {
        status: cancelResponse?.status ?? null,
        body: cancelResponse?.json || cancelResponse?.text || null
      }
    )
  );

  const leakSubmitResponse = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: buildJsonHeaders(),
      body: JSON.stringify({
        prompt: leakMarker,
        action: 'query'
      })
    },
    config.requestTimeoutMs
  );

  const firstIdemResponse = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: buildJsonHeaders({
        'Idempotency-Key': idemKey
      }),
      body: JSON.stringify({
        prompt: idemPrompt,
        action: 'query'
      })
    },
    config.requestTimeoutMs
  );
  const secondIdemResponse = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: buildJsonHeaders({
        'Idempotency-Key': idemKey
      }),
      body: JSON.stringify({
        prompt: idemPrompt,
        action: 'query'
      })
    },
    config.requestTimeoutMs
  );

  const firstIdemPayload = firstIdemResponse.json;
  const secondIdemPayload = secondIdemResponse.json;

  report.checks.push(
    createCheck(
      'explicit_idempotency_dedupes',
      [200, 202].includes(firstIdemResponse.status)
        && [200, 202].includes(secondIdemResponse.status)
        && extractJobId(firstIdemPayload).length > 0
        && extractJobId(firstIdemPayload) === extractJobId(secondIdemPayload)
        && secondIdemPayload?.deduped === true,
      {
        firstStatus: firstIdemResponse.status,
        secondStatus: secondIdemResponse.status,
        firstJobId: extractJobId(firstIdemPayload),
        secondJobId: extractJobId(secondIdemPayload),
        secondDeduped: secondIdemPayload?.deduped ?? null
      }
    )
  );

  const conflictResponse = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: buildJsonHeaders({
        'Idempotency-Key': idemKey
      }),
      body: JSON.stringify({
        prompt: conflictPrompt,
        action: 'query'
      })
    },
    config.requestTimeoutMs
  );

  report.checks.push(
    createCheck(
      'idempotency_conflict_409',
      conflictResponse.status === 409 && extractErrorCode(conflictResponse.json).includes('IDEMPOTENCY_KEY_CONFLICT'),
      {
        status: conflictResponse.status,
        body: conflictResponse.json || conflictResponse.text
      }
    )
  );

  const webLeakLogs = searchLogs(config.service, config.environment, leakMarker, config.logSince, config.logLines);
  const workerLeakLogs = searchLogs(config.workerService, config.environment, leakMarker, config.logSince, config.logLines);
  report.checks.push(
    createCheck(
      'prompt_marker_absent_from_logs',
      !webLeakLogs.matches && !workerLeakLogs.matches,
      {
        web: webLeakLogs,
        worker: workerLeakLogs,
        leakSubmitStatus: leakSubmitResponse.status,
        leakJobId: extractJobId(leakSubmitResponse.json)
      }
    )
  );

  const heavyJobLogSearch = heavyJobId
    ? searchLogs(config.workerService, config.environment, heavyJobId, config.logSince, config.logLines)
    : { skipped: true, matches: false, output: '' };
  report.checks.push(
    createCheck(
      'heavy_job_logs_show_no_timeout_fallback',
      heavyJobLogSearch.skipped
        || !/timeout_fallback|pipeline_timeout|openai_call_aborted_due_to_budget/i.test(heavyJobLogSearch.output),
      {
        worker: heavyJobLogSearch
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
