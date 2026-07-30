#!/usr/bin/env node
/**
 * Purpose: Verify worker-diagnostics containment against one explicitly identified
 * isolated Railway preview using externally seeded, non-secret fixture metadata.
 *
 * Inputs/outputs:
 * - Input: explicit target identity flags, fixture JSON from a file or environment,
 *   and purpose-bound credentials from environment variables only.
 * - Output: one bounded JSON evidence object containing no response bodies,
 *   credentials, fixture sentinels, or raw worker/job identifiers.
 *
 * Edge cases:
 * - Dry-run is the default and performs no network access.
 * - Live execution requires both --execute and --allow-network.
 * - Production and native PR targets, redirects, oversized responses, partial
 *   identities, malformed fixtures, and unexpected response shapes fail closed.
 */

import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const PROBE_SCHEMA_VERSION = 1;
export const PROBE_KIND = 'worker_diagnostics_preview_e2e';
export const PINNED_RAILWAY_TARGET = Object.freeze({
  projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  webServiceId: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
  workerServiceId: '1765befb-b805-4051-9af9-28634e986886',
  repository: 'pbjustin/Arcanos',
  branch: 'codex/worker-diagnostics-containment',
  startCommand: 'node scripts/start-railway-service.mjs',
});

export const CREDENTIAL_ENV_NAMES = Object.freeze({
  workerHelper: 'ARCANOS_WORKER_HELPER_TOKEN',
  gptAccess: 'ARCANOS_GPT_ACCESS_TOKEN',
  jobReadSecret: 'ARCANOS_JOB_READ_CAPABILITY_SECRET',
});

export const FIXTURE_JSON_ENV_NAME =
  'ARCANOS_WORKER_DIAGNOSTICS_FIXTURE_JSON';

export const PROBE_LIMITS = Object.freeze({
  requestTimeoutMs: 10_000,
  maxResponseBytes: 512 * 1024,
  maxFixtureBytes: 16 * 1024,
  maxRequests: 20,
  railwayCliTimeoutMs: 15_000,
  maxRailwayStatusBytes: 2 * 1024 * 1024,
});

const execFileAsync = promisify(execFile);

const DEFAULTS = Object.freeze({
  execute: false,
  allowNetwork: false,
  baseUrl: '',
  projectId: '',
  environment: '',
  environmentId: '',
  webServiceId: '',
  webDeploymentId: '',
  workerServiceId: '',
  workerDeploymentId: '',
  branch: '',
  commitSha: '',
  fixtureFile: '',
  requestTimeoutMs: 5_000,
  maxResponseBytes: 256 * 1024,
});

const VALUE_FLAGS = Object.freeze({
  '--base-url': 'baseUrl',
  '--project-id': 'projectId',
  '--environment': 'environment',
  '--environment-id': 'environmentId',
  '--web-service-id': 'webServiceId',
  '--web-deployment-id': 'webDeploymentId',
  '--worker-service-id': 'workerServiceId',
  '--worker-deployment-id': 'workerDeploymentId',
  '--branch': 'branch',
  '--commit-sha': 'commitSha',
  '--fixture-file': 'fixtureFile',
  '--request-timeout-ms': 'requestTimeoutMs',
  '--max-response-bytes': 'maxResponseBytes',
});

const BOOLEAN_FLAGS = Object.freeze({
  '--execute': 'execute',
  '--allow-network': 'allowNetwork',
});

const INTEGER_FLAGS = new Set([
  '--request-timeout-ms',
  '--max-response-bytes',
]);

const TARGET_FIELDS = Object.freeze([
  'baseUrl',
  'projectId',
  'environment',
  'environmentId',
  'webServiceId',
  'webDeploymentId',
  'workerServiceId',
  'workerDeploymentId',
  'branch',
  'commitSha',
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const CUSTOM_E2E_ENVIRONMENT_PATTERN =
  /^worker-diagnostics-pr-[1-9][0-9]*-e2e$/u;
const PREVIEW_MARKER_PATTERN = /(?:^|[._-])(?:preview|e2e)(?:[._-]|$)/iu;
const PRODUCTION_MARKER_PATTERN =
  /(?:^|[._-])(?:production|prod)(?:[._-]|$)/iu;
const NATIVE_PR_ENVIRONMENT_PATTERN =
  /^(?:Arcanos-pr-[1-9][0-9]*|pr-[0-9a-f]{6}-[1-9][0-9]*)$/iu;
const NATIVE_PR_HOST_PATTERN =
  /(?:^|[.-])(?:arcanos-pr-[1-9][0-9]*|pr-[0-9a-f]{6}-[1-9][0-9]*)(?:[.-]|$)/iu;
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const JOB_READ_CAPABILITY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const PURPOSE_BOUND_CREDENTIAL_MIN_LENGTH = 32;
const PURPOSE_BOUND_CREDENTIAL_MAX_LENGTH = 4096;
const MAX_SENTINEL_LENGTH = 256;
const MIN_SENTINEL_LENGTH = 8;
const PUBLIC_HEALTH_PATHS = Object.freeze([
  '/worker-helper/status',
  '/worker-helper/health',
  '/workers/status',
  '/trinity/status',
]);
const PUBLIC_FORBIDDEN_KEYS = Object.freeze([
  'latestJob',
  'recentFailedJobs',
  'activeJobs',
  'currentJobId',
  'lastError',
  'workerIds',
  'lastInputPreview',
  'lastResult',
  'workersDirectory',
]);
const PUBLIC_SHAPE = Object.freeze({
  root: Object.freeze([
    'availableWorkers',
    'memory',
    'overallStatus',
    'queue',
    'runtime',
    'status',
    'timestamp',
    'totalWorkers',
    'workers',
  ]),
  runtime: Object.freeze([
    'lastDispatchAt',
    'startedAt',
    'status',
    'totalDispatched',
  ]),
  workers: Object.freeze([
    'active',
    'available',
    'configured',
    'degraded',
    'lastHeartbeatAt',
    'observed',
    'stale',
    'status',
    'total',
    'unhealthy',
  ]),
  queue: Object.freeze([
    'completed',
    'delayed',
    'lastUpdatedAt',
    'pending',
    'retainedFailed',
    'running',
    'stalledRunning',
    'status',
    'total',
  ]),
  memory: Object.freeze([
    'lastUpdatedAt',
    'routes',
    'status',
  ]),
});
const HEALTH_STATES = new Set([
  'healthy',
  'degraded',
  'unhealthy',
  'offline',
  'unknown',
]);
const RUNTIME_STATES = new Set([
  'active',
  'pending',
  'disabled',
  'offline',
  'unknown',
]);
const QUEUE_STATES = new Set([
  'idle',
  'active',
  'stalled',
  'unavailable',
]);
const MEMORY_STATES = new Set([
  'active',
  'degraded',
  'offline',
  'unknown',
]);
const SENSITIVE_TEXT_PATTERN =
  /(?:postgres|postgresql|mysql|mongodb|redis|rediss):\/\/[^\s,;}]+|Bearer\s+[^\s]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;}]+/giu;

export class WorkerDiagnosticsPreviewE2EError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WorkerDiagnosticsPreviewE2EError';
    this.code = code;
  }
}

function fail(code) {
  throw new WorkerDiagnosticsPreviewE2EError(code);
}

function requireCondition(condition, code) {
  if (!condition) {
    fail(code);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function responseCode(body) {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body.error === 'string') {
    return body.error;
  }
  return isRecord(body.error) && typeof body.error.code === 'string'
    ? body.error.code
    : null;
}

function exactKeys(value, expected) {
  return isRecord(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...expected].sort());
}

function collectObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nestedValue]) => [
    key,
    ...collectObjectKeys(nestedValue),
  ]);
}

function isNullableCount(value) {
  return value === null
    || (Number.isSafeInteger(value) && value >= 0);
}

function isNullableTimestamp(value) {
  return value === null
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function cacheDirectives(headers) {
  const value = headers?.get?.('cache-control');
  if (typeof value !== 'string') {
    return new Set();
  }
  return new Set(
    value
      .split(',')
      .map((directive) => directive.trim().toLowerCase())
      .filter(Boolean),
  );
}

function requireCacheDirectives(result, directives, code) {
  const actual = cacheDirectives(result.headers);
  requireCondition(
    directives.every((directive) => actual.has(directive)),
    code,
  );
}

function assertPublicHealthPayload(body, sentinels) {
  requireCondition(exactKeys(body, PUBLIC_SHAPE.root), 'PUBLIC_ALLOWLIST_MISMATCH');
  requireCondition(
    exactKeys(body.runtime, PUBLIC_SHAPE.runtime)
      && exactKeys(body.workers, PUBLIC_SHAPE.workers)
      && exactKeys(body.queue, PUBLIC_SHAPE.queue)
      && exactKeys(body.memory, PUBLIC_SHAPE.memory),
    'PUBLIC_ALLOWLIST_MISMATCH',
  );

  const allKeys = new Set(collectObjectKeys(body));
  requireCondition(
    PUBLIC_FORBIDDEN_KEYS.every((key) => !allKeys.has(key)),
    'PUBLIC_FORBIDDEN_KEY_EXPOSED',
  );

  const serialized = JSON.stringify(body);
  requireCondition(
    sentinels.every((sentinel) => !serialized.includes(sentinel)),
    'PUBLIC_SENTINEL_EXPOSED',
  );

  requireCondition(
    HEALTH_STATES.has(body.status)
      && HEALTH_STATES.has(body.overallStatus)
      && HEALTH_STATES.has(body.workers.status)
      && RUNTIME_STATES.has(body.runtime.status)
      && QUEUE_STATES.has(body.queue.status)
      && MEMORY_STATES.has(body.memory.status),
    'PUBLIC_STATE_NOT_NORMALIZED',
  );

  const counts = [
    body.totalWorkers,
    body.availableWorkers,
    body.runtime.totalDispatched,
    body.workers.total,
    body.workers.available,
    body.workers.configured,
    body.workers.active,
    body.workers.observed,
    body.workers.stale,
    body.workers.degraded,
    body.workers.unhealthy,
    body.queue.total,
    body.queue.pending,
    body.queue.running,
    body.queue.completed,
    body.queue.retainedFailed,
    body.queue.delayed,
    body.queue.stalledRunning,
    body.memory.routes,
  ];
  requireCondition(
    counts.every(isNullableCount),
    'PUBLIC_COUNT_NOT_NORMALIZED',
  );

  const timestamps = [
    body.timestamp,
    body.runtime.startedAt,
    body.runtime.lastDispatchAt,
    body.workers.lastHeartbeatAt,
    body.queue.lastUpdatedAt,
    body.memory.lastUpdatedAt,
  ];
  requireCondition(
    timestamps.every(isNullableTimestamp),
    'PUBLIC_TIMESTAMP_NOT_NORMALIZED',
  );
}

function validateSentinel(value) {
  return typeof value === 'string'
    && value.length >= MIN_SENTINEL_LENGTH
    && value.length <= MAX_SENTINEL_LENGTH
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

export function validateFixtureMetadata(value) {
  requireCondition(isRecord(value), 'FIXTURE_INVALID');
  const expectedKeys = [
    'absolutePathSentinel',
    'errorSentinel',
    'jobId',
    'promptSentinel',
    'resultSentinel',
    'schemaVersion',
    'workerId',
  ];
  requireCondition(exactKeys(value, expectedKeys), 'FIXTURE_KEYS_INVALID');
  requireCondition(value.schemaVersion === 1, 'FIXTURE_VERSION_INVALID');
  requireCondition(JOB_ID_PATTERN.test(value.jobId), 'FIXTURE_JOB_ID_INVALID');
  requireCondition(
    WORKER_ID_PATTERN.test(value.workerId),
    'FIXTURE_WORKER_ID_INVALID',
  );

  const sentinels = [
    value.promptSentinel,
    value.resultSentinel,
    value.errorSentinel,
    value.absolutePathSentinel,
  ];
  requireCondition(sentinels.every(validateSentinel), 'FIXTURE_SENTINEL_INVALID');
  requireCondition(
    new Set([value.jobId, value.workerId, ...sentinels]).size
      === 2 + sentinels.length,
    'FIXTURE_SENTINELS_NOT_DISTINCT',
  );
  requireCondition(
    path.posix.isAbsolute(value.absolutePathSentinel)
      || path.win32.isAbsolute(value.absolutePathSentinel),
    'FIXTURE_ABSOLUTE_PATH_INVALID',
  );

  return Object.freeze({
    schemaVersion: 1,
    jobId: value.jobId.toLowerCase(),
    workerId: value.workerId,
    promptSentinel: value.promptSentinel,
    resultSentinel: value.resultSentinel,
    errorSentinel: value.errorSentinel,
    absolutePathSentinel: value.absolutePathSentinel,
  });
}

export async function loadFixtureMetadata(config, dependencies = {}) {
  const env = dependencies.env || process.env;
  const readFileFn = dependencies.readFileFn || readFile;
  const statFn = dependencies.statFn || stat;
  const fixtureJson = env[FIXTURE_JSON_ENV_NAME];
  const hasEnvironmentFixture =
    typeof fixtureJson === 'string' && fixtureJson.trim().length > 0;
  const hasFileFixture =
    typeof config.fixtureFile === 'string' && config.fixtureFile.length > 0;

  requireCondition(
    !(hasEnvironmentFixture && hasFileFixture),
    'FIXTURE_SOURCE_AMBIGUOUS',
  );
  requireCondition(
    hasEnvironmentFixture || hasFileFixture,
    'FIXTURE_METADATA_REQUIRED',
  );

  let rawFixture;
  if (hasFileFixture) {
    const fileStats = await statFn(config.fixtureFile).catch(() => null);
    requireCondition(
      fileStats?.isFile?.() === true
        && fileStats.size > 0
        && fileStats.size <= PROBE_LIMITS.maxFixtureBytes,
      'FIXTURE_FILE_INVALID',
    );
    rawFixture = await readFileFn(config.fixtureFile, 'utf8').catch(() => null);
  } else {
    rawFixture = fixtureJson;
  }

  requireCondition(
    typeof rawFixture === 'string'
      && Buffer.byteLength(rawFixture, 'utf8') <= PROBE_LIMITS.maxFixtureBytes,
    'FIXTURE_TOO_LARGE',
  );

  let parsedFixture;
  try {
    parsedFixture = JSON.parse(rawFixture);
  } catch {
    fail('FIXTURE_JSON_INVALID');
  }
  return validateFixtureMetadata(parsedFixture);
}

export function parseArgs(argv) {
  const config = { ...DEFAULTS, explicitFields: [] };
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
    if (
      typeof rawValue !== 'string'
      || rawValue.trim().length === 0
      || rawValue.startsWith('--')
    ) {
      fail('MISSING_ARGUMENT_VALUE');
    }
    if (INTEGER_FLAGS.has(flag)) {
      const parsedValue = Number(rawValue);
      requireCondition(
        Number.isSafeInteger(parsedValue) && parsedValue > 0,
        'INVALID_POSITIVE_INTEGER',
      );
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
    fail('BASE_URL_INVALID');
  }

  requireCondition(
    parsedUrl.protocol === 'https:'
      && !parsedUrl.username
      && !parsedUrl.password
      && !parsedUrl.port
      && parsedUrl.pathname === '/'
      && !parsedUrl.search
      && !parsedUrl.hash,
    'BASE_URL_INVALID',
  );
  const hostname = parsedUrl.hostname.toLowerCase();
  requireCondition(
    hostname.endsWith('.up.railway.app')
      && PREVIEW_MARKER_PATTERN.test(hostname)
      && !PRODUCTION_MARKER_PATTERN.test(hostname)
      && !NATIVE_PR_HOST_PATTERN.test(hostname),
    'TARGET_NOT_ISOLATED_PREVIEW',
  );
  return parsedUrl.origin;
}

export function resolveExecutionPolicy(config) {
  requireCondition(
    Boolean(config.execute) === Boolean(config.allowNetwork),
    'NETWORK_AUTHORIZATION_FLAGS_MUST_MATCH',
  );
  requireCondition(
    config.requestTimeoutMs <= PROBE_LIMITS.requestTimeoutMs
      && config.maxResponseBytes <= PROBE_LIMITS.maxResponseBytes,
    'PROBE_LIMIT_EXCEEDED',
  );

  const explicitFields = new Set(config.explicitFields || []);
  const hasEveryTargetField = TARGET_FIELDS.every((field) =>
    explicitFields.has(field));
  requireCondition(hasEveryTargetField, 'INCOMPLETE_EXPLICIT_TARGET');
  requireCondition(
    UUID_PATTERN.test(config.projectId)
      && UUID_PATTERN.test(config.environmentId)
      && UUID_PATTERN.test(config.webServiceId)
      && UUID_PATTERN.test(config.webDeploymentId)
      && UUID_PATTERN.test(config.workerServiceId)
      && UUID_PATTERN.test(config.workerDeploymentId),
    'RAILWAY_RESOURCE_ID_INVALID',
  );
  requireCondition(COMMIT_PATTERN.test(config.commitSha), 'COMMIT_SHA_INVALID');
  requireCondition(
    ENVIRONMENT_PATTERN.test(config.environment)
      && CUSTOM_E2E_ENVIRONMENT_PATTERN.test(config.environment)
      && PREVIEW_MARKER_PATTERN.test(config.environment)
      && !PRODUCTION_MARKER_PATTERN.test(config.environment)
      && !NATIVE_PR_ENVIRONMENT_PATTERN.test(config.environment),
    'ENVIRONMENT_NOT_ISOLATED_PREVIEW',
  );
  requireCondition(
    config.projectId.toLowerCase() === PINNED_RAILWAY_TARGET.projectId
      && config.webServiceId.toLowerCase()
        === PINNED_RAILWAY_TARGET.webServiceId
      && config.workerServiceId.toLowerCase()
        === PINNED_RAILWAY_TARGET.workerServiceId
      && config.branch === PINNED_RAILWAY_TARGET.branch,
    'PINNED_RAILWAY_TARGET_MISMATCH',
  );

  return {
    mode: config.execute ? 'EXECUTE' : 'DRY_RUN',
    execute: config.execute,
    target: {
      baseUrl: normalizePreviewBaseUrl(config.baseUrl),
      projectId: config.projectId.toLowerCase(),
      environment: config.environment,
      environmentId: config.environmentId.toLowerCase(),
      webServiceId: config.webServiceId.toLowerCase(),
      webDeploymentId: config.webDeploymentId.toLowerCase(),
      workerServiceId: config.workerServiceId.toLowerCase(),
      workerDeploymentId: config.workerDeploymentId.toLowerCase(),
      repository: PINNED_RAILWAY_TARGET.repository,
      branch: config.branch,
      commitSha: config.commitSha.toLowerCase(),
    },
    fixtureFile: config.fixtureFile,
    requestTimeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  };
}

function railwayInvocationForPlatform(
  platform = process.platform,
  appData = process.env.APPDATA,
  nodeExecutable = process.execPath,
) {
  if (platform !== 'win32') {
    return { executable: 'railway', argsPrefix: [] };
  }
  requireCondition(
    typeof appData === 'string'
      && appData.length > 0
      && !/[\r\n\u0000]/u.test(appData),
    'RAILWAY_STATUS_UNAVAILABLE',
  );
  return {
    executable: nodeExecutable,
    argsPrefix: [
      path.win32.join(
        appData,
        'npm',
        'node_modules',
        '@railway',
        'cli',
        'bin',
        'railway.js',
      ),
    ],
  };
}

/**
 * Run exactly one bounded, read-only Railway CLI command and parse its output
 * in memory. Raw status and stderr are never written by this process.
 */
export async function readRailwayStatusJson(dependencies = {}) {
  const executeFile = dependencies.execFileFn || execFileAsync;
  const invocation = railwayInvocationForPlatform(
    dependencies.platform,
    dependencies.appData,
    dependencies.nodeExecutable,
  );

  let stdout;
  try {
    const result = await executeFile(
      invocation.executable,
      [...invocation.argsPrefix, 'status', '--json'],
      {
        encoding: 'utf8',
        timeout: PROBE_LIMITS.railwayCliTimeoutMs,
        maxBuffer: PROBE_LIMITS.maxRailwayStatusBytes,
        windowsHide: true,
      },
    );
    stdout = result?.stdout;
  } catch {
    fail('RAILWAY_STATUS_UNAVAILABLE');
  }

  requireCondition(
    typeof stdout === 'string'
      && stdout.length > 0
      && Buffer.byteLength(stdout, 'utf8')
        <= PROBE_LIMITS.maxRailwayStatusBytes,
    'RAILWAY_STATUS_INVALID',
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail('RAILWAY_STATUS_INVALID');
  }
  requireCondition(isRecord(parsed), 'RAILWAY_STATUS_INVALID');
  return parsed;
}

function readRailwayEnvironment(status, target) {
  const environments = status.environments?.edges;
  requireCondition(Array.isArray(environments), 'RAILWAY_STATUS_INVALID');
  const nodes = environments
    .map((edge) => edge?.node)
    .filter(isRecord);
  const byId = nodes.filter((node) => node.id === target.environmentId);
  const byName = nodes.filter((node) => node.name === target.environment);
  requireCondition(
    byId.length === 1
      && byName.length === 1
      && byId[0] === byName[0]
      && byId[0].deletedAt == null
      && byId[0].canAccess === true,
    'RAILWAY_ENVIRONMENT_ATTESTATION_FAILED',
  );
  return byId[0];
}

function readRailwayService(environment, expectedServiceId) {
  const edges = environment.serviceInstances?.edges;
  requireCondition(Array.isArray(edges), 'RAILWAY_STATUS_INVALID');
  const matches = edges
    .map((edge) => edge?.node)
    .filter((node) =>
      isRecord(node) && node.serviceId === expectedServiceId);
  requireCondition(
    matches.length === 1,
    'RAILWAY_SERVICE_ATTESTATION_FAILED',
  );
  return matches[0];
}

function readRailwayDomains(service) {
  const serviceDomains = Array.isArray(service.domains?.serviceDomains)
    ? service.domains.serviceDomains
    : [];
  const customDomains = Array.isArray(service.domains?.customDomains)
    ? service.domains.customDomains
    : [];
  return [...serviceDomains, ...customDomains]
    .map((domain) => domain?.domain)
    .filter((domain) => typeof domain === 'string')
    .map((domain) => domain.trim().toLowerCase());
}

function attestRailwayService(service, target, expected) {
  requireCondition(
    service.environmentId === target.environmentId
      && service.source?.repo === PINNED_RAILWAY_TARGET.repository,
    'RAILWAY_SERVICE_ATTESTATION_FAILED',
  );

  const deployment = service.latestDeployment;
  const metadata = deployment?.meta;
  requireCondition(
    isRecord(deployment)
      && deployment.id === expected.deploymentId
      && deployment.status === 'SUCCESS'
      && isRecord(metadata)
      && metadata.repo === PINNED_RAILWAY_TARGET.repository
      && metadata.branch === target.branch
      && metadata.commitHash?.toLowerCase() === target.commitSha,
    'RAILWAY_DEPLOYMENT_ATTESTATION_FAILED',
  );

  const startCommands = [
    service.startCommand,
    metadata.serviceManifest?.deploy?.startCommand,
    metadata.fileServiceManifest?.deploy?.startCommand,
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  requireCondition(
    startCommands.length > 0
      && startCommands.every((command) =>
        command === PINNED_RAILWAY_TARGET.startCommand)
      && startCommands.every((command) =>
        !command.includes('--pr-preview-safe')),
    'RAILWAY_START_COMMAND_ATTESTATION_FAILED',
  );
}

/**
 * Bind the external HTTP target to Railway's authenticated control-plane view
 * before any bearer, helper, or job capability can be sent over HTTP.
 */
export function validateRailwayStatusAttestation(status, target) {
  requireCondition(
    isRecord(status)
      && isRecord(target)
      && status.id === PINNED_RAILWAY_TARGET.projectId
      && target.projectId === PINNED_RAILWAY_TARGET.projectId
      && target.webServiceId === PINNED_RAILWAY_TARGET.webServiceId
      && target.workerServiceId === PINNED_RAILWAY_TARGET.workerServiceId
      && target.repository === PINNED_RAILWAY_TARGET.repository
      && target.branch === PINNED_RAILWAY_TARGET.branch,
    'RAILWAY_PROJECT_ATTESTATION_FAILED',
  );

  const environment = readRailwayEnvironment(status, target);
  const webService = readRailwayService(environment, target.webServiceId);
  const workerService = readRailwayService(
    environment,
    target.workerServiceId,
  );
  const webHostname = new URL(target.baseUrl).hostname.toLowerCase();
  requireCondition(
    readRailwayDomains(webService).filter((domain) =>
      domain === webHostname).length === 1,
    'RAILWAY_WEB_DOMAIN_ATTESTATION_FAILED',
  );

  attestRailwayService(webService, target, {
    deploymentId: target.webDeploymentId,
  });
  attestRailwayService(workerService, target, {
    deploymentId: target.workerDeploymentId,
  });

  return Object.freeze({
    projectId: target.projectId,
    environmentId: target.environmentId,
    webServiceId: target.webServiceId,
    webDeploymentId: target.webDeploymentId,
    workerServiceId: target.workerServiceId,
    workerDeploymentId: target.workerDeploymentId,
    repository: target.repository,
    branch: target.branch,
    commitSha: target.commitSha,
    webDomain: webHostname,
    deploymentStatus: 'SUCCESS',
    startCommand: PINNED_RAILWAY_TARGET.startCommand,
  });
}

function validateCredential(value, code) {
  requireCondition(
    typeof value === 'string'
      && value.length >= PURPOSE_BOUND_CREDENTIAL_MIN_LENGTH
      && value.length <= PURPOSE_BOUND_CREDENTIAL_MAX_LENGTH
      && !/\s/u.test(value),
    code,
  );
  return value;
}

export function readCredentials(env = process.env) {
  const workerHelperToken = validateCredential(
    env[CREDENTIAL_ENV_NAMES.workerHelper],
    'WORKER_HELPER_CREDENTIAL_INVALID',
  );
  const gptAccessToken = validateCredential(
    env[CREDENTIAL_ENV_NAMES.gptAccess],
    'GPT_ACCESS_CREDENTIAL_INVALID',
  );
  const jobReadSecret = validateCredential(
    env[CREDENTIAL_ENV_NAMES.jobReadSecret],
    'JOB_READ_SECRET_INVALID',
  );
  requireCondition(
    new Set([
      workerHelperToken,
      gptAccessToken,
      jobReadSecret,
    ]).size === 3,
    'CREDENTIAL_REUSE_FORBIDDEN',
  );
  return {
    workerHelperToken,
    gptAccessToken,
    jobReadSecret,
  };
}

export function issueJobReadCapability(jobId, secret) {
  requireCondition(JOB_ID_PATTERN.test(jobId), 'FIXTURE_JOB_ID_INVALID');
  const signature = createHmac('sha256', secret)
    .update(`arcanos:job-read:v1:${jobId.trim().toLowerCase()}`)
    .digest('base64url');
  const capability = `v1.${signature}`;
  requireCondition(
    JOB_READ_CAPABILITY_PATTERN.test(capability),
    'JOB_READ_CAPABILITY_INVALID',
  );
  return capability;
}

async function readBoundedResponseBody(response, maxResponseBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let body = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        requireCondition(size <= maxResponseBytes, 'RESPONSE_TOO_LARGE');
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      return body;
    } finally {
      reader.releaseLock?.();
    }
  }

  const body = await response.text();
  requireCondition(
    Buffer.byteLength(body, 'utf8') <= maxResponseBytes,
    'RESPONSE_TOO_LARGE',
  );
  return body;
}

export async function requestEndpoint(policy, request, dependencies = {}) {
  const fetchFn = dependencies.fetchFn || globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    policy.requestTimeoutMs,
  );
  const requestedUrl = new URL(request.path, `${policy.target.baseUrl}/`);

  try {
    const response = await fetchFn(requestedUrl, {
      method: request.method || 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: request.accept || 'application/json',
        'user-agent': 'arcanos-worker-diagnostics-preview-e2e/1',
        ...(request.headers || {}),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });

    requireCondition(
      response.redirected !== true
        && !(response.status >= 300 && response.status < 400),
      'REDIRECT_REFUSED',
    );
    if (typeof response.url === 'string' && response.url.length > 0) {
      const finalUrl = new URL(response.url);
      requireCondition(
        finalUrl.origin === requestedUrl.origin
          && finalUrl.pathname === requestedUrl.pathname
          && finalUrl.search === requestedUrl.search,
        'REDIRECT_REFUSED',
      );
    }

    const rawBody = await readBoundedResponseBody(
      response,
      policy.maxResponseBytes,
    );
    let parsedBody = null;
    if (request.responseType !== 'text') {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        fail('INVALID_JSON_RESPONSE');
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: request.responseType === 'text' ? rawBody : parsedBody,
    };
  } catch (error) {
    if (error instanceof WorkerDiagnosticsPreviewE2EError) {
      throw error;
    }
    fail(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

function recordCheck(checks, {
  caseId,
  method,
  pathTemplate,
  result,
  cacheDirectivesChecked = [],
}) {
  checks.push({
    caseId,
    method,
    path: pathTemplate,
    status: result.status,
    cacheDirectivesChecked,
    passed: true,
  });
}

function findFailedJob(body, fixture) {
  const jobs = isRecord(body) && Array.isArray(body.jobs) ? body.jobs : [];
  return jobs.find((job) => isRecord(job) && job.id === fixture.jobId);
}

function findWorker(body, fixture) {
  const workers = isRecord(body)
    && isRecord(body.workerService)
    && isRecord(body.workerService.health)
    && Array.isArray(body.workerService.health.workers)
    ? body.workerService.health.workers
    : [];
  return workers.find((worker) =>
    isRecord(worker) && worker.workerId === fixture.workerId);
}

function assertOperatorWorkerDetail(body, fixture) {
  requireCondition(isRecord(body), 'OPERATOR_WORKER_STATUS_INVALID');
  const latestJob = isRecord(body.workerService)
    ? body.workerService.latestJob
    : null;
  requireCondition(
    isRecord(latestJob)
      && latestJob.id === fixture.jobId
      && latestJob.error_message === fixture.errorSentinel,
    'OPERATOR_LATEST_JOB_DETAIL_MISSING',
  );
  const recentFailedJobs = isRecord(body.workerService)
    && Array.isArray(body.workerService.recentFailedJobs)
    ? body.workerService.recentFailedJobs
    : [];
  const failedJob = recentFailedJobs.find((job) =>
    isRecord(job) && job.id === fixture.jobId);
  requireCondition(
    isRecord(failedJob)
      && failedJob.error_message === fixture.errorSentinel,
    'OPERATOR_FAILED_JOB_DETAIL_MISSING',
  );

  const worker = findWorker(body, fixture);
  requireCondition(
    isRecord(worker)
      && worker.currentJobId === fixture.jobId
      && Array.isArray(worker.activeJobs)
      && worker.activeJobs.includes(fixture.jobId)
      && worker.lastError === fixture.errorSentinel
      && worker.disabledReason === fixture.promptSentinel
      && worker.lastClaimResult === fixture.resultSentinel,
    'OPERATOR_WORKER_DETAIL_MISSING',
  );
}

function parseSseEvents(value) {
  const events = [];
  let eventName = null;
  let dataLines = [];
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    } else if (line.length === 0 && (eventName || dataLines.length > 0)) {
      let data = null;
      if (dataLines.length > 0) {
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          fail('SSE_DATA_INVALID');
        }
      }
      events.push({ event: eventName, data });
      eventName = null;
      dataLines = [];
    }
  }
  return events;
}

function assertContainsSentinel(value, sentinel, code) {
  requireCondition(JSON.stringify(value).includes(sentinel), code);
}

async function runLiveProbe(
  policy,
  fixture,
  credentials,
  railwayAttestation,
  dependencies,
) {
  const request = dependencies.requestFn || requestEndpoint;
  const requestOptions = {
    fetchFn: dependencies.fetchFn,
  };
  const checks = [{
    caseId: 'railway-control-plane-attestation',
    method: 'CLI',
    path: 'railway status --json',
    status: railwayAttestation.deploymentStatus,
    cacheDirectivesChecked: [],
    passed: true,
  }];
  let requestCount = 0;
  const invoke = async (requestConfig) => {
    requestCount += 1;
    requireCondition(
      requestCount <= PROBE_LIMITS.maxRequests,
      'REQUEST_COUNT_LIMIT_EXCEEDED',
    );
    return request(policy, requestConfig, requestOptions);
  };

  const gptAuthorization = {
    authorization: `Bearer ${credentials.gptAccessToken}`,
  };
  const workerAuthorization = {
    'content-type': 'application/json',
    'x-arcanos-worker-helper-token': credentials.workerHelperToken,
  };
  const jobReadToken = issueJobReadCapability(
    fixture.jobId,
    credentials.jobReadSecret,
  );
  const jobAuthorization = {
    'x-arcanos-job-read-token': jobReadToken,
  };

  const identity = await invoke({
    path: '/gpt-access/health',
    headers: gptAuthorization,
  });
  requireCondition(identity.status === 200, 'DEPLOYMENT_IDENTITY_UNAVAILABLE');
  const deployment = isRecord(identity.body) ? identity.body.deployment : null;
  requireCondition(
    isRecord(deployment)
      && deployment.provider === 'railway'
      && deployment.projectId?.toLowerCase() === policy.target.projectId
      && deployment.environmentId?.toLowerCase() === policy.target.environmentId
      && deployment.environmentName === policy.target.environment
      && deployment.serviceId?.toLowerCase()
        === policy.target.webServiceId
      && deployment.deploymentId?.toLowerCase()
        === policy.target.webDeploymentId
      && deployment.gitCommitSha?.toLowerCase() === policy.target.commitSha,
    'DEPLOYMENT_IDENTITY_MISMATCH',
  );
  recordCheck(checks, {
    caseId: 'deployment-identity',
    method: 'GET',
    pathTemplate: '/gpt-access/health',
    result: identity,
  });

  const dispatch = await invoke({
    method: 'POST',
    path: '/worker-helper/dispatch',
    headers: workerAuthorization,
    body: {
      input: fixture.promptSentinel,
      attempts: 1,
      backoffMs: 0,
      sourceEndpoint: 'worker-diagnostics-preview-e2e',
    },
  });
  requireCondition(
    dispatch.status === 200
      && isRecord(dispatch.body)
      && dispatch.body.mode === 'direct-dispatch'
      && dispatch.body.input === fixture.promptSentinel
      && isRecord(dispatch.body.primaryResult)
      && dispatch.body.primaryResult.error === 'OpenAI adapter unavailable',
    'PROVIDER_FREE_DISPATCH_FAILED',
  );
  const expectedRuntimeResult = dispatch.body.primaryResult;
  recordCheck(checks, {
    caseId: 'provider-free-runtime-dispatch',
    method: 'POST',
    pathTemplate: '/worker-helper/dispatch',
    result: dispatch,
  });

  const publicSentinels = [
    fixture.jobId,
    fixture.workerId,
    fixture.promptSentinel,
    fixture.resultSentinel,
    fixture.errorSentinel,
    fixture.absolutePathSentinel,
  ];
  for (const publicPath of PUBLIC_HEALTH_PATHS) {
    const publicResult = await invoke({ path: publicPath });
    const acceptedStatuses = publicPath === '/trinity/status'
      ? [200, 503]
      : [200];
    requireCondition(
      acceptedStatuses.includes(publicResult.status),
      'PUBLIC_ROUTE_STATUS_INVALID',
    );
    requireCacheDirectives(
      publicResult,
      ['no-store'],
      'PUBLIC_ROUTE_CACHE_POLICY_INVALID',
    );
    assertPublicHealthPayload(publicResult.body, publicSentinels);
    recordCheck(checks, {
      caseId: `public-${publicPath.replaceAll('/', '-').replace(/^-+/u, '')}`,
      method: 'GET',
      pathTemplate: publicPath,
      result: publicResult,
      cacheDirectivesChecked: ['no-store'],
    });
  }

  const anonymousFailedJobs = await invoke({
    path: '/worker-helper/jobs/failed?limit=not-a-number',
  });
  requireCondition(
    anonymousFailedJobs.status === 401
      && responseCode(anonymousFailedJobs.body) === 'WORKER_HELPER_AUTH_REQUIRED'
      && !JSON.stringify(anonymousFailedJobs.body).includes(fixture.jobId),
    'FAILED_LIST_AUTH_BOUNDARY_INVALID',
  );
  requireCacheDirectives(
    anonymousFailedJobs,
    ['no-store'],
    'FAILED_LIST_CACHE_POLICY_INVALID',
  );
  recordCheck(checks, {
    caseId: 'failed-list-anonymous',
    method: 'GET',
    pathTemplate: '/worker-helper/jobs/failed?limit=not-a-number',
    result: anonymousFailedJobs,
    cacheDirectivesChecked: ['no-store'],
  });

  const authenticatedFailedJobs = await invoke({
    path: '/worker-helper/jobs/failed?limit=100',
    headers: {
      'x-arcanos-worker-helper-token': credentials.workerHelperToken,
    },
  });
  const retainedFailedJob = findFailedJob(
    authenticatedFailedJobs.body,
    fixture,
  );
  requireCondition(
    authenticatedFailedJobs.status === 200
      && authenticatedFailedJobs.body?.failedCountMode
        === 'retained_terminal_jobs'
      && isRecord(retainedFailedJob)
      && retainedFailedJob.error_message === fixture.errorSentinel
      && retainedFailedJob.status === 'failed',
    'FAILED_LIST_OPERATOR_DETAIL_MISSING',
  );
  requireCacheDirectives(
    authenticatedFailedJobs,
    ['no-store'],
    'FAILED_LIST_CACHE_POLICY_INVALID',
  );
  recordCheck(checks, {
    caseId: 'failed-list-authenticated',
    method: 'GET',
    pathTemplate: '/worker-helper/jobs/failed?limit=100',
    result: authenticatedFailedJobs,
    cacheDirectivesChecked: ['no-store'],
  });

  const anonymousOperatorStatus = await invoke({
    path: '/gpt-access/workers/status',
  });
  requireCondition(
    anonymousOperatorStatus.status === 401
      && responseCode(anonymousOperatorStatus.body)
        === 'UNAUTHORIZED_GPT_ACCESS',
    'GPT_ACCESS_AUTH_BOUNDARY_INVALID',
  );
  requireCacheDirectives(
    anonymousOperatorStatus,
    ['no-store'],
    'GPT_ACCESS_CACHE_POLICY_INVALID',
  );
  recordCheck(checks, {
    caseId: 'operator-status-anonymous',
    method: 'GET',
    pathTemplate: '/gpt-access/workers/status',
    result: anonymousOperatorStatus,
    cacheDirectivesChecked: ['no-store'],
  });

  const operatorStatus = await invoke({
    path: '/gpt-access/workers/status',
    headers: gptAuthorization,
  });
  requireCondition(operatorStatus.status === 200, 'OPERATOR_STATUS_UNAVAILABLE');
  requireCacheDirectives(
    operatorStatus,
    ['no-store'],
    'GPT_ACCESS_CACHE_POLICY_INVALID',
  );
  assertOperatorWorkerDetail(operatorStatus.body, fixture);
  const runtime = isRecord(operatorStatus.body?.mainApp)
    ? operatorStatus.body.mainApp.runtime
    : null;
  requireCondition(
    isRecord(runtime)
      && runtime.lastInputPreview === fixture.promptSentinel
      && stableJson(runtime.lastResult) === stableJson(expectedRuntimeResult)
      && runtime.lastError === expectedRuntimeResult.error,
    'OPERATOR_RUNTIME_DETAIL_MISSING',
  );
  recordCheck(checks, {
    caseId: 'operator-status-authenticated',
    method: 'GET',
    pathTemplate: '/gpt-access/workers/status',
    result: operatorStatus,
    cacheDirectivesChecked: ['no-store'],
  });

  const operatorHealth = await invoke({
    path: '/gpt-access/worker-helper/health',
    headers: gptAuthorization,
  });
  requireCondition(
    operatorHealth.status === 200
      && isRecord(findWorker({
        workerService: {
          health: {
            workers: operatorHealth.body?.workers,
          },
        },
      }, fixture)),
    'OPERATOR_HEALTH_DETAIL_MISSING',
  );
  requireCacheDirectives(
    operatorHealth,
    ['no-store'],
    'GPT_ACCESS_CACHE_POLICY_INVALID',
  );
  recordCheck(checks, {
    caseId: 'operator-health-authenticated',
    method: 'GET',
    pathTemplate: '/gpt-access/worker-helper/health',
    result: operatorHealth,
    cacheDirectivesChecked: ['no-store'],
  });

  const jobStatus = await invoke({
    path: `/jobs/${fixture.jobId}`,
    headers: jobAuthorization,
  });
  requireCondition(
    jobStatus.status === 200
      && jobStatus.body?.id === fixture.jobId
      && jobStatus.body?.status === 'failed'
      && jobStatus.body?.error_message === fixture.errorSentinel,
    'JOB_STATUS_DETAIL_MISSING',
  );
  assertContainsSentinel(
    jobStatus.body?.output,
    fixture.resultSentinel,
    'JOB_STATUS_RESULT_MISSING',
  );
  assertContainsSentinel(
    jobStatus.body?.output,
    fixture.absolutePathSentinel,
    'JOB_STATUS_ABSOLUTE_PATH_MISSING',
  );
  requireCacheDirectives(
    jobStatus,
    ['no-store'],
    'JOB_STATUS_CACHE_POLICY_INVALID',
  );
  recordCheck(checks, {
    caseId: 'generic-job-status',
    method: 'GET',
    pathTemplate: '/jobs/:id',
    result: jobStatus,
    cacheDirectivesChecked: ['no-store'],
  });

  const jobResult = await invoke({
    path: `/jobs/${fixture.jobId}/result`,
    headers: jobAuthorization,
  });
  requireCondition(
    jobResult.status === 200
      && jobResult.body?.jobId === fixture.jobId
      && jobResult.body?.status === 'failed'
      && jobResult.body?.error?.message === fixture.errorSentinel,
    'JOB_RESULT_DETAIL_MISSING',
  );
  assertContainsSentinel(
    jobResult.body?.result,
    fixture.resultSentinel,
    'JOB_RESULT_OUTPUT_MISSING',
  );
  assertContainsSentinel(
    jobResult.body?.result,
    fixture.absolutePathSentinel,
    'JOB_RESULT_ABSOLUTE_PATH_MISSING',
  );
  requireCacheDirectives(
    jobResult,
    ['no-store'],
    'JOB_RESULT_CACHE_POLICY_INVALID',
  );
  recordCheck(checks, {
    caseId: 'generic-job-result',
    method: 'GET',
    pathTemplate: '/jobs/:id/result',
    result: jobResult,
    cacheDirectivesChecked: ['no-store'],
  });

  const jobStream = await invoke({
    path: `/jobs/${fixture.jobId}/stream`,
    headers: jobAuthorization,
    accept: 'text/event-stream',
    responseType: 'text',
  });
  requireCondition(
    jobStream.status === 200
      && jobStream.headers?.get?.('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
      && jobStream.headers?.get?.('x-accel-buffering')?.toLowerCase() === 'no'
      && jobStream.body.includes('retry: 1000'),
    'JOB_SSE_RESPONSE_INVALID',
  );
  requireCacheDirectives(
    jobStream,
    ['no-store', 'no-cache', 'no-transform'],
    'JOB_SSE_CACHE_POLICY_INVALID',
  );
  const terminalEvent = parseSseEvents(jobStream.body)
    .find((event) => event.event === 'terminal');
  requireCondition(
    isRecord(terminalEvent?.data)
      && terminalEvent.data.jobId === fixture.jobId
      && terminalEvent.data.status === 'failed'
      && terminalEvent.data.error_message === fixture.errorSentinel,
    'JOB_SSE_TERMINAL_EVENT_INVALID',
  );
  assertContainsSentinel(
    terminalEvent.data.output,
    fixture.resultSentinel,
    'JOB_SSE_RESULT_MISSING',
  );
  assertContainsSentinel(
    terminalEvent.data.output,
    fixture.absolutePathSentinel,
    'JOB_SSE_ABSOLUTE_PATH_MISSING',
  );
  recordCheck(checks, {
    caseId: 'generic-job-terminal-sse',
    method: 'GET',
    pathTemplate: '/jobs/:id/stream',
    result: jobStream,
    cacheDirectivesChecked: ['no-store', 'no-cache', 'no-transform'],
  });

  return {
    checks,
    requestCount,
  };
}

export async function runProbe(config, dependencies = {}) {
  const policy = resolveExecutionPolicy(config);
  if (!policy.execute) {
    return {
      schemaVersion: PROBE_SCHEMA_VERSION,
      kind: PROBE_KIND,
      mode: policy.mode,
      executed: false,
      networkAttempted: false,
      target: policy.target,
      limits: {
        requestTimeoutMs: policy.requestTimeoutMs,
        maxResponseBytes: policy.maxResponseBytes,
        maxRequests: PROBE_LIMITS.maxRequests,
      },
      checks: [],
      summary: {
        status: 'DRY_RUN',
        code: 'EXPLICIT_TARGET_VALIDATED_NO_NETWORK',
      },
    };
  }

  let railwayStatus;
  try {
    railwayStatus = dependencies.railwayStatusFn
      ? await dependencies.railwayStatusFn()
      : await readRailwayStatusJson(dependencies);
  } catch (error) {
    if (error instanceof WorkerDiagnosticsPreviewE2EError) {
      throw error;
    }
    fail('RAILWAY_STATUS_UNAVAILABLE');
  }
  const railwayAttestation = validateRailwayStatusAttestation(
    railwayStatus,
    policy.target,
  );
  const fixture = await loadFixtureMetadata(policy, dependencies);
  const credentials = readCredentials(dependencies.env || process.env);
  const liveResult = await runLiveProbe(
    policy,
    fixture,
    credentials,
    railwayAttestation,
    dependencies,
  );

  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    kind: PROBE_KIND,
    mode: policy.mode,
    executed: true,
    networkAttempted: true,
    target: policy.target,
    fixture: {
      jobIdSha256: sha256(fixture.jobId),
      workerIdSha256: sha256(fixture.workerId),
    },
    limits: {
      requestTimeoutMs: policy.requestTimeoutMs,
      maxResponseBytes: policy.maxResponseBytes,
      maxRequests: PROBE_LIMITS.maxRequests,
    },
    checks: liveResult.checks,
    summary: {
      status: 'PASS',
      code: 'WORKER_DIAGNOSTICS_PREVIEW_E2E_PASS',
      checksPassed: liveResult.checks.length,
      requestsMade: liveResult.requestCount,
    },
  };
}

export function sanitizeEvidence(value, knownSecrets = []) {
  const secrets = knownSecrets.filter(
    (secret) => typeof secret === 'string' && secret.length > 0,
  );
  const seen = new WeakSet();

  function sanitizeString(input) {
    let sanitized = input;
    for (const secret of secrets) {
      sanitized = sanitized.replaceAll(secret, '[REDACTED]');
    }
    return sanitized.replace(SENSITIVE_TEXT_PATTERN, '[REDACTED]');
  }

  function visit(input) {
    if (typeof input === 'string') {
      return sanitizeString(input);
    }
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (seen.has(input)) {
      return '[REDACTED]';
    }
    seen.add(input);
    if (Array.isArray(input)) {
      return input.map(visit);
    }

    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [
        sanitizeString(key),
        visit(entry),
      ]),
    );
  }

  return visit(value);
}

export function writeSanitizedEvidence(
  value,
  knownSecrets = [],
  output = process.stdout,
) {
  output.write(`${JSON.stringify(sanitizeEvidence(value, knownSecrets))}\n`);
}

export function buildFailureEvidence(error) {
  const code = error instanceof WorkerDiagnosticsPreviewE2EError
    ? error.code
    : 'WORKER_DIAGNOSTICS_PREVIEW_E2E_FAILED';
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    kind: PROBE_KIND,
    mode: 'FAILED',
    checks: [],
    summary: {
      status: 'FAIL',
      code,
    },
  };
}

function configuredCredentialValues(env) {
  return Object.values(CREDENTIAL_ENV_NAMES)
    .map((name) => env[name])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

async function main() {
  try {
    const config = parseArgs(process.argv.slice(2));
    const report = await runProbe(config);
    writeSanitizedEvidence(
      report,
      configuredCredentialValues(process.env),
    );
  } catch (error) {
    writeSanitizedEvidence(
      buildFailureEvidence(error),
      configuredCredentialValues(process.env),
      process.stderr,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
