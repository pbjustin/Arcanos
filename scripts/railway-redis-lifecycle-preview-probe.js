#!/usr/bin/env node
/**
 * Purpose: Capture deterministic, sanitized liveness/readiness evidence from an isolated Railway preview.
 * Inputs/Outputs: Reads explicit CLI target identity, performs GET-only health probes when doubly authorized, prints one JSON report.
 * Edge cases: Dry-runs by default, rejects production/ambient targets, bounds every request and sample loop, and never invokes Railway CLI.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PROBE_SCHEMA_VERSION = 1;
export const PROBE_KIND = 'redis_lifecycle_preview_evidence';
export const PRODUCTION_BASE_URL = 'https://acranos-production.up.railway.app';
export const PROBE_LIMITS = Object.freeze({
  maxSamples: 100,
  intervalMs: 5000,
  requestTimeoutMs: 2000
});

export const DEFAULTS = Object.freeze({
  execute: false,
  allowNetwork: false,
  target: '',
  baseUrl: '',
  environment: '',
  environmentId: '',
  webServiceId: '',
  webDeploymentId: '',
  phase: '',
  maxSamples: 0,
  intervalMs: 1000,
  requestTimeoutMs: 2000
});

const VALUE_FLAGS = Object.freeze({
  '--target': 'target',
  '--base-url': 'baseUrl',
  '--environment': 'environment',
  '--environment-id': 'environmentId',
  '--web-service-id': 'webServiceId',
  '--web-deployment-id': 'webDeploymentId',
  '--phase': 'phase',
  '--max-samples': 'maxSamples',
  '--interval-ms': 'intervalMs',
  '--request-timeout-ms': 'requestTimeoutMs'
});

const BOOLEAN_FLAGS = Object.freeze({
  '--execute': 'execute',
  '--allow-network': 'allowNetwork'
});

const POSITIVE_INTEGER_FLAGS = new Set([
  '--max-samples',
  '--interval-ms',
  '--request-timeout-ms'
]);

const TARGET_FIELDS = Object.freeze([
  'target',
  'baseUrl',
  'environment',
  'environmentId',
  'webServiceId',
  'webDeploymentId',
  'phase'
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENVIRONMENT_PATTERN = /^arcanos-redis-lifecycle-preview-[0-9]{8}-[1-9][0-9]*$/u;
const PRODUCTION_HOSTNAME_PATTERN = /(^|[.-])production([.-]|$)/iu;
const SENSITIVE_OR_LOW_LEVEL_PATTERN = /(?:redis|rediss):\/\/|\.railway\.internal|authorization|bearer\s|"(?:accessToken|token|secret|password)"\s*:|wrongpass|econnrefused|econnreset|etimedout|enotfound|enetunreach|ehostunreach|eai_again|getaddrinfo|"stack"\s*:|\bat\s+[^\r\n]+:\d+:\d+|(?:\b\d{1,3}\.){3}\d{1,3}\b/iu;
const MAX_RESPONSE_CHARACTERS = 65_536;
const PROCESS_START_TOLERANCE_MS = 100;

export class ProbeConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProbeConfigurationError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProbeConfigurationError(code);
}

export function parseArgs(argv) {
  const config = {
    ...DEFAULTS,
    explicitFields: []
  };
  const seenFlags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const valueField = VALUE_FLAGS[flag];
    const booleanField = BOOLEAN_FLAGS[flag];

    if (!valueField && !booleanField) {
      fail('UNKNOWN_ARGUMENT');
    }
    if (seenFlags.has(flag)) {
      fail('DUPLICATE_ARGUMENT');
    }
    seenFlags.add(flag);

    if (booleanField) {
      config[booleanField] = true;
      continue;
    }

    const rawValue = argv[index + 1];
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0 || rawValue.startsWith('--')) {
      fail('MISSING_ARGUMENT_VALUE');
    }

    if (POSITIVE_INTEGER_FLAGS.has(flag)) {
      const parsedValue = Number(rawValue);
      if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
        fail('INVALID_POSITIVE_INTEGER');
      }
      config[valueField] = parsedValue;
    } else {
      config[valueField] = rawValue.trim();
    }

    config.explicitFields.push(valueField);
    index += 1;
  }

  return config;
}

export function normalizePreviewBaseUrl(rawValue) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawValue);
  } catch {
    fail('INVALID_BASE_URL');
  }

  if (parsedUrl.protocol !== 'https:'
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.port
    || parsedUrl.pathname !== '/'
    || parsedUrl.search
    || parsedUrl.hash) {
    fail('INVALID_BASE_URL');
  }

  if (!parsedUrl.hostname.endsWith('.up.railway.app')
    || PRODUCTION_HOSTNAME_PATTERN.test(parsedUrl.hostname)
    || parsedUrl.origin.toLowerCase() === PRODUCTION_BASE_URL) {
    fail('TARGET_NOT_ISOLATED_PREVIEW');
  }

  return parsedUrl.origin;
}

export function resolveExecutionPolicy(config) {
  if (Boolean(config.execute) !== Boolean(config.allowNetwork)) {
    fail('NETWORK_AUTHORIZATION_FLAGS_MUST_MATCH');
  }
  if (config.maxSamples > PROBE_LIMITS.maxSamples
    || config.intervalMs > PROBE_LIMITS.intervalMs
    || config.requestTimeoutMs > PROBE_LIMITS.requestTimeoutMs) {
    fail('PROBE_LIMIT_EXCEEDED');
  }

  const explicitFields = new Set(config.explicitFields || []);
  const hasAnyTargetField = TARGET_FIELDS.some((field) => explicitFields.has(field));
  const hasEveryTargetField = TARGET_FIELDS.every((field) => explicitFields.has(field));

  if (hasAnyTargetField && !hasEveryTargetField) {
    fail('INCOMPLETE_EXPLICIT_TARGET');
  }
  if (config.execute && !hasEveryTargetField) {
    fail('EXECUTION_REQUIRES_EXPLICIT_TARGET');
  }
  if (!hasAnyTargetField) {
    return {
      mode: 'DRY_RUN',
      execute: false,
      target: null,
      phase: null,
      maxSamples: 0,
      intervalMs: config.intervalMs,
      requestTimeoutMs: config.requestTimeoutMs
    };
  }

  if (config.target !== 'isolated-preview') {
    fail('TARGET_NOT_ISOLATED_PREVIEW');
  }
  if (!ENVIRONMENT_PATTERN.test(config.environment)) {
    fail('INVALID_ISOLATED_PREVIEW_ENVIRONMENT');
  }
  if (!UUID_PATTERN.test(config.environmentId)
    || !UUID_PATTERN.test(config.webServiceId)
    || !UUID_PATTERN.test(config.webDeploymentId)) {
    fail('INVALID_RAILWAY_RESOURCE_ID');
  }
  if (!['outage', 'recovery'].includes(config.phase)) {
    fail('INVALID_PROBE_PHASE');
  }

  const defaultMaxSamples = config.phase === 'outage' ? 5 : 80;
  return {
    mode: config.execute ? 'EXECUTE' : 'DRY_RUN',
    execute: config.execute,
    target: {
      category: 'isolated-preview',
      baseUrl: normalizePreviewBaseUrl(config.baseUrl),
      environment: config.environment,
      environmentId: config.environmentId,
      webServiceId: config.webServiceId,
      webDeploymentId: config.webDeploymentId
    },
    phase: config.phase,
    maxSamples: config.maxSamples || defaultMaxSamples,
    intervalMs: config.intervalMs,
    requestTimeoutMs: config.requestTimeoutMs
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNullableString(value) {
  return typeof value === 'string' ? value : null;
}

function asNullableTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function asNullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function asNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

export async function requestJson(url, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const clockMs = options.clockMs || Date.now;
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULTS.requestTimeoutMs;
  const controller = new AbortController();
  const startedAt = clockMs();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'arcanos-redis-lifecycle-preview-probe/1'
      }
    });
    const rawBody = await response.text();
    const latencyMs = Math.max(0, Math.round(clockMs() - startedAt));
    const sensitiveContentObserved = SENSITIVE_OR_LOW_LEVEL_PATTERN.test(rawBody);

    if (rawBody.length > MAX_RESPONSE_CHARACTERS) {
      return {
        status: response.status,
        latencyMs,
        body: null,
        errorCode: 'RESPONSE_TOO_LARGE',
        sensitiveContentObserved
      };
    }

    let body = null;
    try {
      const parsed = JSON.parse(rawBody);
      body = isRecord(parsed) ? parsed : null;
    } catch {
      body = null;
    }

    return {
      status: response.status,
      latencyMs,
      body,
      errorCode: body ? null : 'INVALID_JSON_RESPONSE',
      sensitiveContentObserved
    };
  } catch {
    return {
      status: null,
      latencyMs: Math.max(0, Math.round(clockMs() - startedAt)),
      body: null,
      errorCode: controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED',
      sensitiveContentObserved: false
    };
  } finally {
    clearTimeout(timeout);
  }
}

function projectHealthEndpoint(result) {
  const body = isRecord(result.body) ? result.body : {};
  const startup = isRecord(body.startup) ? body.startup : {};
  const dependencies = isRecord(body.dependencies) ? body.dependencies : {};
  const redis = isRecord(dependencies.redis) ? dependencies.redis : {};

  return {
    status: result.status,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    serverTimestamp: asNullableTimestamp(body.timestamp),
    startupPhase: asNullableString(startup.phase),
    listenerBound: asNullableBoolean(startup.listener_bound),
    uptimeSeconds: asNullableNumber(body.uptime),
    redisReady: asNullableBoolean(redis.ready),
    redisStatus: asNullableString(redis.status),
    redisCode: asNullableString(redis.code),
    retryScheduled: asNullableBoolean(redis.retry_scheduled)
  };
}

function projectReadinessEndpoint(result) {
  const body = isRecord(result.body) ? result.body : {};
  const checks = Array.isArray(body.checks) ? body.checks : [];
  const redisCheck = checks.find((check) => isRecord(check) && check.name === 'redis');
  const redis = isRecord(redisCheck) ? redisCheck : {};
  const metadata = isRecord(redis.metadata) ? redis.metadata : {};

  return {
    status: result.status,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    ready: asNullableBoolean(body.ready),
    readinessStatus: asNullableString(body.status),
    redisHealthy: asNullableBoolean(redis.healthy),
    redisCode: asNullableString(redis.code),
    recoveryCount: asNullableInteger(metadata.recoveryCount)
  };
}

export async function collectObservation(policy, sequence, dependencies = {}) {
  const request = dependencies.requestFn || requestJson;
  const requestOptions = {
    fetchFn: dependencies.fetchFn,
    clockMs: dependencies.clockMs,
    requestTimeoutMs: policy.requestTimeoutMs
  };
  const [healthResult, healthzResult, readyzResult] = await Promise.all([
    request(`${policy.target.baseUrl}/health`, requestOptions),
    request(`${policy.target.baseUrl}/healthz`, requestOptions),
    request(`${policy.target.baseUrl}/readyz`, requestOptions)
  ]);

  return {
    sequence,
    observedAt: (dependencies.now || (() => new Date()))().toISOString(),
    health: projectHealthEndpoint(healthResult),
    healthz: projectHealthEndpoint(healthzResult),
    readyz: projectReadinessEndpoint(readyzResult),
    sensitiveContentObserved: Boolean(
      healthResult.sensitiveContentObserved
      || healthzResult.sensitiveContentObserved
      || readyzResult.sensitiveContentObserved
    )
  };
}

function check(name, passed, passCode, failCode) {
  return {
    name,
    status: passed ? 'PASS' : 'FAIL',
    code: passed ? passCode : failCode
  };
}

function reportLimits(policy) {
  return {
    maxSamples: policy.maxSamples,
    intervalMs: policy.intervalMs,
    requestTimeoutMs: policy.requestTimeoutMs
  };
}

function countLivenessFailures(observations) {
  return observations.reduce((count, observation) => (
    count
    + (observation.health.status === 200 ? 0 : 1)
    + (observation.healthz.status === 200 ? 0 : 1)
  ), 0);
}

function hasMonotonicUptime(observations) {
  const uptimes = observations
    .map((observation) => observation.health.uptimeSeconds)
    .filter((uptime) => typeof uptime === 'number');

  return uptimes.length === observations.length
    && uptimes.every((uptime, index) => index === 0 || uptime >= uptimes[index - 1]);
}

function hasBoundedResponseLatency(observations, requestTimeoutMs) {
  return observations.length > 0 && observations.every((observation) => (
    [observation.health, observation.healthz, observation.readyz].every((endpoint) => (
      endpoint.errorCode === null && endpoint.latencyMs <= requestTimeoutMs
    ))
  ));
}

function hasStableProcessStartTime(observations) {
  const inferredStartTimes = observations.flatMap((observation) => (
    [observation.health, observation.healthz].map((endpoint) => {
      const timestampMs = Date.parse(endpoint.serverTimestamp || '');
      if (!Number.isFinite(timestampMs) || typeof endpoint.uptimeSeconds !== 'number') {
        return null;
      }
      return timestampMs - (endpoint.uptimeSeconds * 1000);
    })
  )).filter((value) => typeof value === 'number');

  return inferredStartTimes.length === observations.length * 2
    && Math.max(...inferredStartTimes) - Math.min(...inferredStartTimes) <= PROCESS_START_TOLERANCE_MS;
}

export function evaluateOutageObservations(observations, limits = DEFAULTS) {
  const finalObservation = observations.at(-1);
  const livenessFailures = countLivenessFailures(observations);
  const livenessReachable = observations.length > 0 && livenessFailures === 0;
  const responseLatencyBounded = hasBoundedResponseLatency(observations, limits.requestTimeoutMs);
  const listenerBound = observations.length > 0
    && observations.every((observation) => (
      observation.health.listenerBound === true
      && observation.healthz.listenerBound === true
    ));
  const readinessUnavailable = observations.length > 0
    && observations.every((observation) => (
      observation.readyz.status === 503
      && observation.readyz.ready === false
      && observation.readyz.redisHealthy === false
    ));
  const stableDependencyError = finalObservation?.readyz.redisCode === 'REDIS_DEPENDENCY_UNAVAILABLE'
    && finalObservation?.health.redisCode === 'REDIS_DEPENDENCY_UNAVAILABLE'
    && finalObservation?.health.redisReady === false;
  const retryScheduled = finalObservation?.health.retryScheduled === true
    && finalObservation?.healthz.retryScheduled === true;
  const sanitized = observations.every((observation) => !observation.sensitiveContentObserved);

  const checks = [
    check('liveness_reachable', livenessReachable, 'LIVENESS_REMAINED_REACHABLE', 'LIVENESS_FAILURE_OBSERVED'),
    check('response_latency_bounded', responseLatencyBounded, 'RESPONSES_COMPLETED_WITHIN_TIMEOUT', 'RESPONSE_LATENCY_BOUND_EXCEEDED'),
    check('listener_bound', listenerBound, 'LISTENER_BOUND_DURING_OUTAGE', 'LISTENER_NOT_CONFIRMED_BOUND'),
    check('readiness_unavailable', readinessUnavailable, 'READINESS_REJECTED_TRAFFIC', 'READINESS_OUTAGE_NOT_CONFIRMED'),
    check('stable_dependency_error', stableDependencyError, 'REDIS_DEPENDENCY_UNAVAILABLE_OBSERVED', 'STABLE_REDIS_ERROR_NOT_OBSERVED'),
    check('retry_scheduled', retryScheduled, 'REDIS_RETRY_SCHEDULED', 'REDIS_RETRY_NOT_CONFIRMED'),
    check('sanitized_public_output', sanitized, 'PUBLIC_OUTPUT_SANITIZED', 'SENSITIVE_OR_LOW_LEVEL_OUTPUT_OBSERVED')
  ];

  return {
    checks,
    livenessFailures,
    readinessTransitionObserved: false,
    passed: checks.every((entry) => entry.status === 'PASS')
  };
}

export function evaluateRecoveryObservations(observations, limits = DEFAULTS) {
  const livenessFailures = countLivenessFailures(observations);
  const outageIndex = observations.findIndex((observation) => (
    observation.readyz.status === 503
    && observation.readyz.ready === false
    && ['REDIS_INITIALIZING', 'REDIS_DEPENDENCY_UNAVAILABLE'].includes(observation.readyz.redisCode)
  ));
  const readyIndex = observations.findIndex((observation, index) => (
    index > outageIndex
    && observation.readyz.status === 200
    && observation.readyz.ready === true
    && observation.readyz.redisHealthy === true
  ));
  const transitionObserved = outageIndex >= 0 && readyIndex > outageIndex;
  const finalObservation = readyIndex >= 0 ? observations[readyIndex] : observations.at(-1);
  const livenessReachable = observations.length > 0 && livenessFailures === 0;
  const responseLatencyBounded = hasBoundedResponseLatency(observations, limits.requestTimeoutMs);
  const listenerBound = observations.length > 0
    && observations.every((observation) => (
      observation.health.listenerBound === true
      && observation.healthz.listenerBound === true
    ));
  const uptimeMonotonic = transitionObserved
    && hasMonotonicUptime(observations.slice(0, readyIndex + 1));
  const processStartTimeStable = transitionObserved
    && hasStableProcessStartTime(observations.slice(0, readyIndex + 1));
  const redisReady = finalObservation?.health.redisReady === true
    && finalObservation?.health.redisStatus === 'ready'
    && finalObservation?.health.redisCode === null
    && finalObservation?.healthz.redisReady === true
    && finalObservation?.healthz.redisStatus === 'ready'
    && finalObservation?.healthz.redisCode === null;
  const recoveryRecorded = typeof finalObservation?.readyz.recoveryCount === 'number'
    && finalObservation.readyz.recoveryCount >= 1;
  const sanitized = observations.every((observation) => !observation.sensitiveContentObserved);

  const checks = [
    check('liveness_reachable', livenessReachable, 'LIVENESS_REMAINED_REACHABLE', 'LIVENESS_FAILURE_OBSERVED'),
    check('response_latency_bounded', responseLatencyBounded, 'RESPONSES_COMPLETED_WITHIN_TIMEOUT', 'RESPONSE_LATENCY_BOUND_EXCEEDED'),
    check('listener_bound', listenerBound, 'LISTENER_REMAINED_BOUND', 'LISTENER_NOT_CONFIRMED_BOUND'),
    check('readiness_transition', transitionObserved, 'READINESS_TRANSITIONED_TO_READY', 'READINESS_TRANSITION_NOT_OBSERVED'),
    check('uptime_monotonic', uptimeMonotonic, 'UPTIME_MONOTONIC_ACROSS_RECOVERY', 'UPTIME_RESET_OR_MISSING'),
    check('process_start_time_stable', processStartTimeStable, 'PROCESS_START_TIME_STABLE', 'PROCESS_REPLACEMENT_OBSERVED'),
    check('redis_ready', redisReady, 'REDIS_REPORTED_READY', 'REDIS_READY_NOT_CONFIRMED'),
    check('recovery_recorded', recoveryRecorded, 'REDIS_RECOVERY_COUNT_INCREMENTED', 'REDIS_RECOVERY_COUNT_NOT_CONFIRMED'),
    check('sanitized_public_output', sanitized, 'PUBLIC_OUTPUT_SANITIZED', 'SENSITIVE_OR_LOW_LEVEL_OUTPUT_OBSERVED')
  ];

  return {
    checks,
    livenessFailures,
    readinessTransitionObserved: transitionObserved,
    passed: checks.every((entry) => entry.status === 'PASS')
  };
}

function buildDryRunReport(policy) {
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    kind: PROBE_KIND,
    mode: 'DRY_RUN',
    phase: policy.phase,
    target: policy.target,
    limits: reportLimits(policy),
    executed: false,
    networkAttempted: false,
    startedAt: null,
    completedAt: null,
    summary: {
      status: 'DRY_RUN',
      sampleCount: 0,
      livenessFailures: 0,
      readinessTransitionObserved: false
    },
    observations: [],
    checks: [{
      name: 'network_execution',
      status: 'NOT_RUN',
      code: policy.target ? 'EXPLICIT_TARGET_VALIDATED_NO_NETWORK' : 'DRY_RUN_NO_TARGET_NO_NETWORK'
    }]
  };
}

export async function runProbe(config, dependencies = {}) {
  const policy = resolveExecutionPolicy(config);
  if (!policy.execute) {
    return buildDryRunReport(policy);
  }

  const now = dependencies.now || (() => new Date());
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const startedAt = now().toISOString();
  const observations = [];

  for (let sequence = 1; sequence <= policy.maxSamples; sequence += 1) {
    const observation = await collectObservation(policy, sequence, {
      ...dependencies,
      now
    });
    observations.push(observation);

    if (policy.phase === 'recovery') {
      const transition = evaluateRecoveryObservations(observations, policy).readinessTransitionObserved;
      if (transition) {
        break;
      }
    }
    if (sequence < policy.maxSamples) {
      await sleep(policy.intervalMs);
    }
  }

  const evaluation = policy.phase === 'outage'
    ? evaluateOutageObservations(observations, policy)
    : evaluateRecoveryObservations(observations, policy);

  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    kind: PROBE_KIND,
    mode: 'EXECUTE',
    phase: policy.phase,
    target: policy.target,
    limits: reportLimits(policy),
    executed: true,
    networkAttempted: true,
    startedAt,
    completedAt: now().toISOString(),
    summary: {
      status: evaluation.passed ? 'PASS' : 'FAIL',
      sampleCount: observations.length,
      livenessFailures: evaluation.livenessFailures,
      readinessTransitionObserved: evaluation.readinessTransitionObserved
    },
    observations,
    checks: evaluation.checks
  };
}

export function buildConfigurationFailureReport(code) {
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    kind: PROBE_KIND,
    mode: 'DRY_RUN',
    phase: null,
    target: null,
    limits: {
      maxSamples: 0,
      intervalMs: DEFAULTS.intervalMs,
      requestTimeoutMs: DEFAULTS.requestTimeoutMs
    },
    executed: false,
    networkAttempted: false,
    startedAt: null,
    completedAt: null,
    summary: {
      status: 'FAIL',
      sampleCount: 0,
      livenessFailures: 0,
      readinessTransitionObserved: false
    },
    observations: [],
    checks: [{
      name: 'configuration',
      status: 'FAIL',
      code
    }]
  };
}

async function main() {
  try {
    const report = await runProbe(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.summary.status === 'FAIL' ? 1 : 0;
  } catch (error) {
    const code = error instanceof ProbeConfigurationError
      ? error.code
      : 'PROBE_EXECUTION_FAILED';
    process.stdout.write(`${JSON.stringify(buildConfigurationFailureReport(code), null, 2)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
