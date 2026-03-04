#!/usr/bin/env node
/**
 * Purpose: Detect /ask timeout regressions from Railway logs.
 * Inputs/Outputs: Reads Railway logs via CLI and prints findings to stdout; exits non-zero on detected regressions.
 * Edge cases: Handles empty log output, malformed JSON lines, and Railway CLI failures without silent success.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULTS = {
  since: '30m',
  lines: 400,
  service: '',
  environment: '',
  timeoutLatencyMs: 90000
};

/**
 * Purpose: Parse CLI arguments for configurable alert checks.
 * Inputs/Outputs: argv string array -> normalized config object.
 * Edge cases: Unknown flags are ignored to keep the checker forward-compatible.
 */
function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const argFlag = argv[index];
    const next = argv[index + 1];

    //audit assumption: only known flags should mutate checker behavior; failure risk: malformed args skew detection; expected invariant: config remains valid defaults on unknown flags; handling strategy: ignore unknown tokens.
    if (argFlag === '--since' && typeof next === 'string' && next.length > 0) {
      config.since = next;
      index += 1;
      continue;
    }

    //audit assumption: lines must be a positive integer; failure risk: invalid limit hides findings; expected invariant: lines > 0; handling strategy: parse and fallback to default on invalid input.
    if (argFlag === '--lines' && typeof next === 'string' && next.length > 0) {
      const parsed = Number(next);
      config.lines = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULTS.lines;
      index += 1;
      continue;
    }

    //audit assumption: service/env names are passed verbatim to Railway CLI; failure risk: wrong target service; expected invariant: non-empty strings only; handling strategy: ignore empty values.
    if (argFlag === '--service' && typeof next === 'string' && next.trim().length > 0) {
      config.service = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--environment' && typeof next === 'string' && next.trim().length > 0) {
      config.environment = next.trim();
      index += 1;
      continue;
    }

    //audit assumption: timeout threshold is milliseconds and must be positive; failure risk: false alerts or missed regressions; expected invariant: threshold > 0; handling strategy: parse-or-default.
    if (argFlag === '--timeout-latency-ms' && typeof next === 'string' && next.length > 0) {
      const parsed = Number(next);
      config.timeoutLatencyMs = Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : DEFAULTS.timeoutLatencyMs;
      index += 1;
    }
  }

  return config;
}

/**
 * Purpose: Build a stable Railway CLI query for /ask error events.
 * Inputs/Outputs: Normalized config -> Railway CLI argument vector.
 * Edge cases: Uses a broad filter to avoid missing structured error events with empty `message` fields.
 */
function buildRailwayArgs(config) {
  const args = [
    'service',
    'logs',
    '--latest',
    '--since',
    config.since,
    '--lines',
    String(config.lines),
    '--filter',
    '@level:error',
    '--json'
  ];

  //audit assumption: linked Railway context is valid in project workspace; failure risk: querying wrong service when context is stale; expected invariant: explicit flags override linked context; handling strategy: include --service/--environment only when provided.
  if (config.service.trim().length > 0) {
    args.push('--service', config.service);
  }

  if (config.environment.trim().length > 0) {
    args.push('--environment', config.environment);
  }

  return args;
}

/**
 * Purpose: Execute Railway logs query and return raw output.
 * Inputs/Outputs: config -> raw newline-delimited JSON logs string.
 * Edge cases: Throws on Railway CLI failures so alert jobs fail loudly.
 */
function queryRailwayLogs(config) {
  const args = buildRailwayArgs(config);
  const execOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  };

  const candidates = process.platform === 'win32'
    ? [
        { file: 'railway', args, options: execOptions },
        { file: 'railway.exe', args, options: execOptions },
        { file: 'railway', args, options: { ...execOptions, shell: true } }
      ]
    : [{ file: 'railway', args, options: execOptions }];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return execFileSync(candidate.file, candidate.args, candidate.options);
    } catch (error) {
      lastError = error;
      //audit assumption: missing executable can be retried with alternate launch strategy; failure risk: false failure on Windows PATH aliasing; expected invariant: non-ENOENT errors should surface immediately; handling strategy: continue only on ENOENT.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }

  //audit assumption: npm-installed Railway CLI often resolves to a PowerShell shim on Windows; failure risk: command not found from Node spawn; expected invariant: shim path exists under %APPDATA%\\npm; handling strategy: invoke shim with -File and positional args.
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const railwayPs1 = join(appData, 'npm', 'railway.ps1');
    if (existsSync(railwayPs1)) {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', railwayPs1, ...args],
        execOptions
      );
    }
  }

  throw lastError || new Error('Failed to execute railway CLI.');
}

/**
 * Purpose: Parse newline-delimited Railway JSON logs.
 * Inputs/Outputs: raw string -> parsed log entry array.
 * Edge cases: Skips malformed lines instead of crashing to preserve signal from valid lines.
 */
function parseLogLines(rawOutput) {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  /** @type {Array<Record<string, unknown>>} */
  const entries = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      //audit assumption: Railway --json returns object-per-line entries; failure risk: parser drift; expected invariant: object payloads only; handling strategy: retain only object entries.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed);
      }
    } catch {
      //audit assumption: malformed line should not terminate alert check; failure risk: partial data loss; expected invariant: checker continues on parse errors; handling strategy: drop malformed line.
    }
  }

  return entries;
}

/**
 * Purpose: Detect timeout regression signals from /ask error logs.
 * Inputs/Outputs: parsed entries + config -> normalized findings.
 * Edge cases: Handles string/numeric status codes and missing latency fields.
 */
function detectFindings(entries, config) {
  const timeoutTextPattern = /(ask processing error|request timed out|openai timeout|budget abort|watchdog threshold)/i;
  /** @type {Array<{kind: string; timestamp: string; message: string; path: string; statusCode: number | null; latencyMs: number | null; requestId: string | null}>} */
  const findings = [];

  for (const entry of entries) {
    const message = typeof entry.message === 'string' ? entry.message : '';
    const path = typeof entry.path === 'string' ? entry.path : '';
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : null;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : 'unknown-time';

    const rawData = (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data))
      ? entry.data
      : {};
    const statusCodeCandidate = rawData.statusCode;
    const statusCode = typeof statusCodeCandidate === 'number'
      ? statusCodeCandidate
      : Number.isFinite(Number(statusCodeCandidate))
        ? Number(statusCodeCandidate)
        : null;

    const latencyCandidate = typeof entry.latencyMs === 'number'
      ? entry.latencyMs
      : Number.isFinite(Number(entry.latencyMs))
        ? Number(entry.latencyMs)
        : null;

    //audit assumption: explicit timeout markers are highest-confidence regression indicators; failure risk: false positives from unrelated paths; expected invariant: /ask-only matching; handling strategy: require /ask path match.
    if ((path.includes('/ask') || message.includes('/ask')) && timeoutTextPattern.test(message)) {
      findings.push({
        kind: 'explicit_timeout_marker',
        timestamp,
        message,
        path,
        statusCode,
        latencyMs: latencyCandidate,
        requestId
      });
    }

    //audit assumption: /ask HTTP 5xx in error logs indicates possible user-facing regression; failure risk: non-timeout errors included; expected invariant: statusCode extracted when present; handling strategy: tag separately for triage.
    if (path.includes('/ask') && statusCode !== null && statusCode >= 500) {
      findings.push({
        kind: 'ask_5xx',
        timestamp,
        message,
        path,
        statusCode,
        latencyMs: latencyCandidate,
        requestId
      });
    }

    //audit assumption: high-latency /ask failures approximate timeout regressions; failure risk: slow non-timeout errors; expected invariant: latency threshold configurable; handling strategy: emit separate high-latency signal.
    if (
      path.includes('/ask') &&
      statusCode !== null &&
      statusCode >= 500 &&
      latencyCandidate !== null &&
      latencyCandidate >= config.timeoutLatencyMs
    ) {
      findings.push({
        kind: 'ask_high_latency_5xx',
        timestamp,
        message,
        path,
        statusCode,
        latencyMs: latencyCandidate,
        requestId
      });
    }
  }

  return findings;
}

/**
 * Purpose: Render one finding as a single-line summary.
 * Inputs/Outputs: finding object -> summary string.
 * Edge cases: Missing fields render deterministic placeholders.
 */
function formatFinding(finding) {
  return [
    `kind=${finding.kind}`,
    `time=${finding.timestamp}`,
    `path=${finding.path || 'n/a'}`,
    `status=${finding.statusCode ?? 'n/a'}`,
    `latencyMs=${finding.latencyMs ?? 'n/a'}`,
    `requestId=${finding.requestId ?? 'n/a'}`,
    `message=${finding.message || 'n/a'}`
  ].join(' | ');
}

/**
 * Purpose: Main entrypoint for timeout regression detection.
 * Inputs/Outputs: process args -> process exit code and console output.
 * Edge cases: Railway CLI errors exit with code 1; detected regressions exit with code 2.
 */
function main() {
  const config = parseArgs(process.argv.slice(2));

  let rawLogs = '';
  try {
    rawLogs = queryRailwayLogs(config);
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr || '')
      : '';
    //audit assumption: monitoring failures must fail closed; failure risk: false green state; expected invariant: alert check non-zero on query failure; handling strategy: print diagnostic and exit 1.
    console.error('railway-timeout-alert: failed to query Railway logs.');
    if (stderr.trim().length > 0) {
      console.error(stderr.trim());
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }

  const entries = parseLogLines(rawLogs);
  const findings = detectFindings(entries, config);

  //audit assumption: zero findings indicates no current timeout regression in scanned window; failure risk: missed signals outside window; expected invariant: explicit window reported; handling strategy: print checked scope.
  if (findings.length === 0) {
    console.log(
      `railway-timeout-alert: no /ask timeout regressions detected (window=${config.since}, lines=${config.lines}, service="${config.service || '(linked)'}", env="${config.environment || '(linked)'}").`
    );
    process.exit(0);
  }

  const deduped = [...new Map(findings.map((finding) => [`${finding.kind}|${finding.timestamp}|${finding.requestId}|${finding.message}`, finding])).values()];
  console.error(`railway-timeout-alert: detected ${deduped.length} regression signal(s).`);
  for (const finding of deduped) {
    console.error(formatFinding(finding));
  }
  process.exit(2);
}

main();
