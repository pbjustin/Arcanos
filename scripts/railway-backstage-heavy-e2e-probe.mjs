#!/usr/bin/env node
/**
 * Bounded network proof for one disposable Railway Backstage heavy-flow target.
 *
 * Dry-run is the default. Network execution requires both --execute and
 * --allow-network plus an exact dedicated-preview identity contract. The
 * Booker bearer is read only from ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER and is
 * never included in output.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { win32 as win32Path } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
} from './railway-backstage-heavy-openai-fixture.mjs';

export const BACKSTAGE_HEAVY_PROBE_TARGET =
  'dedicated-backstage-heavy-preview';
export const BACKSTAGE_HEAVY_PROBE_BEARER_ENV =
  'ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const ENVIRONMENT_PATTERN =
  /^backstage-heavy-pr-[1-9]\d*-e2e(?:-[a-z0-9]{1,16})?$/u;
const JOB_ID_PATTERN = UUID_PATTERN;
const CAPABILITY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const DERIVED_PUBLIC_ID_PATTERN = /^derived:[A-Za-z0-9_-]{16,256}$/u;
const CANONICAL_IDS = new Set([
  '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  'fb583147-6c39-4343-9267-500f357d25ab',
  '1765befb-b805-4051-9af9-28634e986886',
  'c4ade025-3f13-4fca-9309-5d0dd81396fe',
  '6647b5b1-d796-4783-b5f0-b8e356019ca6',
  '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
]);
const APPROVED_RAILWAY_WORKSPACE_ID =
  '1c9265a3-986f-4304-ad3e-5a874caab039';
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;
const RAILWAY_COMMAND_TIMEOUT_MS = 15_000;
const RAILWAY_COMMAND_MAX_BYTES = 2 * 1024 * 1024;
const RAILWAY_START_COMMAND =
  'node scripts/railway-backstage-heavy-proof-supervisor.mjs';
const RAILWAY_CLI_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'RAILWAY_API_TOKEN',
  'RAILWAY_CONFIG_DIR',
  'RAILWAY_TOKEN',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);
const FORBIDDEN_DATA_ALIAS_NAMES = new Set([
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'PGDATA',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGUSER',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'REDISHOST',
  'REDIS_HOST',
  'REDISPORT',
  'REDIS_PORT',
  'REDISUSER',
  'REDIS_USER',
  'REDISPASSWORD',
  'REDIS_PASSWORD',
  'ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN',
  'ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON',
  'ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON',
]);
const execFileAsync = promisify(execFile);

function fail(code) {
  throw new Error(code);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function railwayInvocationForBackstageHeavyProbe(
  platform = process.platform,
  appData = process.env.APPDATA,
  nodeExecutable = process.execPath
) {
  if (platform !== 'win32') {
    return { executable: 'railway', argsPrefix: [] };
  }
  if (
    typeof appData !== 'string'
    || appData.length === 0
    || /[\r\n\0]/u.test(appData)
    || typeof nodeExecutable !== 'string'
    || nodeExecutable.length === 0
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_INVOCATION_INVALID');
  }
  return {
    executable: nodeExecutable,
    argsPrefix: [win32Path.join(
      appData,
      'npm',
      'node_modules',
      '@railway',
      'cli',
      'bin',
      'railway.js'
    )],
  };
}

export function buildBackstageHeavyRailwayCliEnvironment(
  env = process.env
) {
  const childEnv = {
    CI: 'true',
    NO_COLOR: '1',
  };
  for (const [name, value] of Object.entries(env)) {
    if (
      typeof value === 'string'
      && value.length > 0
      && RAILWAY_CLI_ENV_ALLOWLIST.has(name.toUpperCase())
    ) {
      childEnv[name] = value;
    }
  }
  return childEnv;
}

function parseArguments(args) {
  const values = new Map();
  let execute = false;
  let allowNetwork = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--execute') {
      execute = true;
      continue;
    }
    if (argument === '--allow-network') {
      allowNetwork = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= args.length) {
      fail('BACKSTAGE_HEAVY_PROBE_ARGUMENT_INVALID');
    }
    const name = argument.slice(2);
    if (values.has(name)) {
      fail('BACKSTAGE_HEAVY_PROBE_ARGUMENT_DUPLICATE');
    }
    values.set(name, args[index + 1]);
    index += 1;
  }
  return { allowNetwork, execute, values };
}

function readRequired(values, name) {
  const value = values.get(name)?.trim();
  if (!value) {
    fail('BACKSTAGE_HEAVY_PROBE_ARGUMENT_REQUIRED');
  }
  return value;
}

function validateUuid(value) {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized) || CANONICAL_IDS.has(normalized)) {
    fail('BACKSTAGE_HEAVY_PROBE_TARGET_ID_INVALID');
  }
  return normalized;
}

function validateBaseUrl(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    fail('BACKSTAGE_HEAVY_PROBE_BASE_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !parsed.hostname.endsWith('.up.railway.app')
    || parsed.hostname.toLowerCase().includes('production')
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_BASE_URL_INVALID');
  }
  return parsed.origin;
}

function validatePrivateHost(rawValue, serviceKind) {
  const hostname = rawValue.trim().toLowerCase();
  const expectedHostname = serviceKind === 'postgres'
    ? 'postgres.railway.internal'
    : 'redis.railway.internal';
  if (hostname !== expectedHostname) {
    fail('BACKSTAGE_HEAVY_PROBE_DATA_HOST_INVALID');
  }
  return hostname;
}

export function resolveBackstageHeavyProbeConfig(
  args,
  env = process.env
) {
  const parsed = parseArguments(args);
  const supportedNames = new Set([
    'target',
    'base-url',
    'project-id',
    'environment-id',
    'environment-name',
    'web-service-id',
    'web-deployment-id',
    'worker-service-id',
    'worker-deployment-id',
    'postgres-service-id',
    'postgres-service-name',
    'postgres-internal-host',
    'redis-service-id',
    'redis-service-name',
    'redis-internal-host',
    'source-sha',
    'run-id',
  ]);
  if ([...parsed.values.keys()].some(name => !supportedNames.has(name))) {
    fail('BACKSTAGE_HEAVY_PROBE_ARGUMENT_UNKNOWN');
  }
  if (parsed.execute !== parsed.allowNetwork) {
    fail('BACKSTAGE_HEAVY_PROBE_NETWORK_GATES_REQUIRED');
  }
  if (readRequired(parsed.values, 'target') !== BACKSTAGE_HEAVY_PROBE_TARGET) {
    fail('BACKSTAGE_HEAVY_PROBE_TARGET_INVALID');
  }

  const environmentName = readRequired(parsed.values, 'environment-name')
    .toLowerCase();
  const sourceSha = readRequired(parsed.values, 'source-sha').toLowerCase();
  const runId = readRequired(parsed.values, 'run-id').toLowerCase();
  const prNumber = /^backstage-heavy-pr-([1-9]\d*)-e2e/u.exec(
    environmentName
  )?.[1];
  if (!ENVIRONMENT_PATTERN.test(environmentName)) {
    fail('BACKSTAGE_HEAVY_PROBE_ENVIRONMENT_INVALID');
  }
  if (!SHA_PATTERN.test(sourceSha)) {
    fail('BACKSTAGE_HEAVY_PROBE_SOURCE_SHA_INVALID');
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    fail('BACKSTAGE_HEAVY_PROBE_RUN_ID_INVALID');
  }
  const postgresServiceName = readRequired(
    parsed.values,
    'postgres-service-name'
  );
  const redisServiceName = readRequired(parsed.values, 'redis-service-name');
  if (
    !prNumber
    || postgresServiceName !== 'Postgres'
    || redisServiceName !== 'Redis'
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_DATA_SERVICE_NAME_INVALID');
  }

  const config = {
    allowNetwork: parsed.allowNetwork,
    baseUrl: validateBaseUrl(readRequired(parsed.values, 'base-url')),
    environmentId: validateUuid(readRequired(parsed.values, 'environment-id')),
    environmentName,
    execute: parsed.execute,
    projectId: validateUuid(readRequired(parsed.values, 'project-id')),
    postgresInternalHost: validatePrivateHost(
      readRequired(parsed.values, 'postgres-internal-host'),
      'postgres'
    ),
    postgresServiceId: validateUuid(
      readRequired(parsed.values, 'postgres-service-id')
    ),
    postgresServiceName,
    redisInternalHost: validatePrivateHost(
      readRequired(parsed.values, 'redis-internal-host'),
      'redis'
    ),
    redisServiceId: validateUuid(
      readRequired(parsed.values, 'redis-service-id')
    ),
    redisServiceName,
    runId,
    sourceSha,
    target: BACKSTAGE_HEAVY_PROBE_TARGET,
    webDeploymentId: validateUuid(readRequired(parsed.values, 'web-deployment-id')),
    webServiceId: validateUuid(readRequired(parsed.values, 'web-service-id')),
    webServiceName: `arcanos-web-pr${prNumber}-heavy`,
    workerDeploymentId: validateUuid(readRequired(parsed.values, 'worker-deployment-id')),
    workerServiceId: validateUuid(readRequired(parsed.values, 'worker-service-id')),
    workerServiceName: `arcanos-worker-pr${prNumber}-heavy`,
  };
  if (
    config.webServiceId === config.workerServiceId
    || config.webDeploymentId === config.workerDeploymentId
    || new Set([
      config.webServiceId,
      config.workerServiceId,
      config.postgresServiceId,
      config.redisServiceId,
    ]).size !== 4
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_SERVICE_IDENTITY_INVALID');
  }
  if (!parsed.execute) {
    return config;
  }

  return config;
}

export function buildBackstageHeavyProbePrompt(runId) {
  const clauses = Array.from(
    { length: 20 },
    (_, index) => (
      `Fictional constraint ${index + 1}: keep every performer, venue, title, `
      + 'result, and continuity fact invented for this disposable proof only.'
    )
  ).join(' ');
  const prompt = [
    BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
    `Run ${runId}.`,
    `${BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE} for a complete fictional wrestling event using only invented performers, titles, venues, and continuity.`,
    'Include a coherent opening, escalating middle card, championship stakes, rivalry developments, and a conclusive main event.',
    clauses,
  ].join(' ');
  if (prompt.length < 1_200) {
    fail('BACKSTAGE_HEAVY_PROBE_PROMPT_TOO_SHORT');
  }
  return prompt;
}

async function readBoundedJson(response) {
  if (!response.body) {
    fail('BACKSTAGE_HEAVY_PROBE_RESPONSE_INVALID');
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await response.body.cancel?.().catch?.(() => undefined);
      fail('BACKSTAGE_HEAVY_PROBE_RESPONSE_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks, totalBytes);
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed)) {
      fail('BACKSTAGE_HEAVY_PROBE_RESPONSE_INVALID');
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BACKSTAGE_')) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_PROBE_RESPONSE_INVALID');
  }
}

async function boundedJsonFetch(fetchImpl, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await readBoundedJson(response);
    return { response, body };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function readDeploymentSourceSha(deployment) {
  const meta = isRecord(deployment?.meta) ? deployment.meta : {};
  for (const key of ['commitHash', 'commitSha', 'sourceCommit', 'gitCommitSha']) {
    const value = typeof meta[key] === 'string' ? meta[key].toLowerCase() : '';
    if (SHA_PATTERN.test(value)) {
      return value;
    }
  }
  const cliMessage = typeof meta.cliMessage === 'string'
    ? meta.cliMessage.trim()
    : '';
  const match = /^GitHub auto deploy ([0-9a-f]{40})$/iu.exec(cliMessage);
  return match?.[1]?.toLowerCase() ?? null;
}

function readServiceDomains(serviceNode) {
  const domains = isRecord(serviceNode.domains) ? serviceNode.domains : {};
  return [
    ...(Array.isArray(domains.serviceDomains) ? domains.serviceDomains : []),
    ...(Array.isArray(domains.customDomains) ? domains.customDomains : []),
  ].map(item => isRecord(item) && typeof item.domain === 'string'
    ? item.domain.toLowerCase()
    : '').filter(Boolean);
}

export function attestBackstageHeavyRailwayStatus(statusPayload, config) {
  if (
    !isRecord(statusPayload)
    || statusPayload.id?.toLowerCase() !== config.projectId
    || statusPayload.workspaceId?.toLowerCase()
      !== APPROVED_RAILWAY_WORKSPACE_ID
    || statusPayload.deletedAt !== null
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_PROJECT_MISMATCH');
  }
  const prNumber = /^backstage-heavy-pr-([1-9]\d*)-e2e/u.exec(
    config.environmentName
  )?.[1];
  const projectName = typeof statusPayload.name === 'string'
    ? statusPayload.name.trim()
    : '';
  const expectedProjectPrefix = `arc-pr${prNumber}-heavy-`;
  const expectedProjectPattern = new RegExp(
    `^arc-pr${prNumber}-heavy-[a-z0-9][a-z0-9-]{0,13}$`,
    'u'
  );
  if (
    !prNumber
    || !expectedProjectPattern.test(projectName)
    || projectName.length <= expectedProjectPrefix.length
    || projectName.length > expectedProjectPrefix.length + 14
    || projectName.length > 32
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_PROJECT_NAME_INVALID');
  }
  const projectServices = Array.isArray(statusPayload.services?.edges)
    ? statusPayload.services.edges.map(edge => edge?.node).filter(Boolean)
    : [];
  const expectedProjectServices = new Map([
    [config.webServiceId, config.webServiceName],
    [config.workerServiceId, config.workerServiceName],
    [config.postgresServiceId, config.postgresServiceName],
    [config.redisServiceId, config.redisServiceName],
  ]);
  if (
    projectServices.length !== expectedProjectServices.size
    || new Set(projectServices.map(service => service.id?.toLowerCase())).size
      !== expectedProjectServices.size
    || projectServices.some(service => (
      expectedProjectServices.get(service.id?.toLowerCase())
        !== service.name
    ))
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_SERVICE_TOPOLOGY_MISMATCH');
  }
  const environmentEdges = statusPayload.environments?.edges;
  const environment = Array.isArray(environmentEdges)
    ? environmentEdges.map(edge => edge?.node).find(node => (
        node?.id?.toLowerCase() === config.environmentId
        && node?.name?.toLowerCase() === config.environmentName
        && node?.deletedAt === null
      ))
    : null;
  if (!environment) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_ENVIRONMENT_MISMATCH');
  }
  const volumes = Array.isArray(environment.volumeInstances?.edges)
    ? environment.volumeInstances.edges.map(edge => edge?.node).filter(Boolean)
    : [];
  const expectedVolumeMounts = new Map([
    [config.postgresServiceId, '/var/lib/postgresql/data'],
    [config.redisServiceId, '/data'],
  ]);
  if (
    volumes.length !== 2
    || new Set(volumes.map(volume => volume.serviceId?.toLowerCase())).size
      !== 2
    || volumes.some(volume => !UUID_PATTERN.test(volume.id ?? ''))
    || new Set(volumes.map(volume => volume.id.toLowerCase())).size !== 2
    || volumes.some(volume => (
      volume.deletedAt !== null
      || volume.isPendingDeletion !== false
      || volume.state !== 'READY'
      || expectedVolumeMounts.get(volume.serviceId?.toLowerCase())
        !== volume.mountPath
    ))
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_VOLUME_TOPOLOGY_MISMATCH');
  }
  const serviceEdges = environment.serviceInstances?.edges;
  const services = Array.isArray(serviceEdges)
    ? serviceEdges.map(edge => edge?.node).filter(Boolean)
    : [];
  if (
    services.length !== 4
    || new Set(services.map(service => service.serviceId?.toLowerCase())).size
      !== 4
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_SERVICE_TOPOLOGY_MISMATCH');
  }
  const attestService = (serviceId, serviceName, deploymentId) => {
    const service = services.find(
      candidate => candidate.serviceId?.toLowerCase() === serviceId
    );
    const deployment = service?.latestDeployment;
    const effectiveStartCommand =
      deployment?.meta?.serviceManifest?.deploy?.startCommand;
    const effectiveDeployConfig =
      deployment?.meta?.serviceManifest?.deploy;
    const activeDeployments = Array.isArray(service?.activeDeployments)
      ? service.activeDeployments.filter(
          active => active?.deploymentStopped !== true
        )
      : null;
    if (
      !service
      || service.serviceName !== serviceName
      || deployment?.id?.toLowerCase() !== deploymentId
      || deployment.status !== 'SUCCESS'
      || !Array.isArray(deployment.instances)
      || deployment.instances.length !== 1
      || deployment.instances.some(instance => instance?.status !== 'RUNNING')
      || deployment?.meta?.serviceManifest?.deploy?.numReplicas !== 1
      || effectiveStartCommand !== RAILWAY_START_COMMAND
      || effectiveDeployConfig?.restartPolicyType !== 'NEVER'
      || effectiveDeployConfig?.restartPolicyMaxRetries !== 0
      || readDeploymentSourceSha(deployment) !== config.sourceSha
      || activeDeployments === null
      || activeDeployments.length !== 1
      || activeDeployments[0]?.id?.toLowerCase() !== deploymentId
      || activeDeployments[0]?.status !== 'SUCCESS'
      || !Array.isArray(activeDeployments[0]?.instances)
      || activeDeployments[0].instances.length !== 1
      || activeDeployments[0].instances[0]?.status !== 'RUNNING'
    ) {
      fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
    }
    return service;
  };
  const web = attestService(
    config.webServiceId,
    config.webServiceName,
    config.webDeploymentId
  );
  const worker = attestService(
    config.workerServiceId,
    config.workerServiceName,
    config.workerDeploymentId
  );
  const attestDataService = (serviceId, serviceName) => {
    const service = services.find(
      candidate => candidate.serviceId?.toLowerCase() === serviceId
    );
    const deployment = service?.latestDeployment;
    const activeDeployments = Array.isArray(service?.activeDeployments)
      ? service.activeDeployments.filter(
          active => active?.deploymentStopped !== true
        )
      : [];
    if (
      !service
      || service.serviceName !== serviceName
      || deployment?.status !== 'SUCCESS'
      || deployment.deploymentStopped === true
      || !Array.isArray(deployment.instances)
      || deployment.instances.length !== 1
      || deployment.instances[0]?.status !== 'RUNNING'
      || deployment?.meta?.serviceManifest?.deploy?.numReplicas !== 1
      || activeDeployments.length !== 1
      || activeDeployments[0]?.id !== deployment.id
      || activeDeployments[0]?.status !== 'SUCCESS'
      || readServiceDomains(service).length !== 0
    ) {
      fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_DATA_SERVICE_MISMATCH');
    }
    return service;
  };
  attestDataService(config.postgresServiceId, config.postgresServiceName);
  attestDataService(config.redisServiceId, config.redisServiceName);
  const expectedHostname = new URL(config.baseUrl).hostname.toLowerCase();
  const webDomains = readServiceDomains(web);
  if (!webDomains.includes(expectedHostname) || readServiceDomains(worker).length !== 0) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_DOMAIN_MISMATCH');
  }
  return {
    projectId: config.projectId,
    environmentId: config.environmentId,
    webDeploymentId: config.webDeploymentId,
    workerDeploymentId: config.workerDeploymentId,
    sourceSha: config.sourceSha,
    webDomain: expectedHostname,
  };
}

function attestDeploymentList(payload, serviceId, deploymentId, sourceSha) {
  if (!Array.isArray(payload)) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_LIST_INVALID');
  }
  const deployment = payload.find(
    candidate => candidate?.id?.toLowerCase() === deploymentId
  );
  if (
    !deployment
    || deployment.status !== 'SUCCESS'
    || readDeploymentSourceSha(deployment) !== sourceSha
    || deployment.meta?.serviceManifest?.deploy?.startCommand
      !== RAILWAY_START_COMMAND
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_LIST_MISMATCH');
  }
  return { deploymentId, serviceId, sourceSha };
}

function attestDomainList(payload, expectedDomains) {
  const domains = Array.isArray(payload?.domains)
    ? payload.domains.map(item => (
        typeof item === 'string' ? item.trim() : ''
      )).filter(Boolean)
    : null;
  if (
    domains === null
    || domains.length !== expectedDomains.length
    || domains.some((domain, index) => domain !== expectedDomains[index])
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_DOMAIN_LIST_MISMATCH');
  }
}

function attestNoTcpProxy(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.proxies) || payload.proxies.length !== 0) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_TCP_PROXY_MISMATCH');
  }
}

function attestServiceVariableIdentity(
  payload,
  config,
  serviceId,
  serviceName
) {
  if (
    !isRecord(payload)
    || payload.RAILWAY_PROJECT_ID?.toLowerCase() !== config.projectId
    || payload.RAILWAY_ENVIRONMENT_ID?.toLowerCase()
      !== config.environmentId
    || payload.RAILWAY_ENVIRONMENT_NAME?.toLowerCase()
      !== config.environmentName
    || payload.RAILWAY_SERVICE_ID?.toLowerCase() !== serviceId
    || payload.RAILWAY_SERVICE_NAME !== serviceName
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_VARIABLE_IDENTITY_MISMATCH');
  }
}

function validateInternalServiceUrl(rawValue, options) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    fail('BACKSTAGE_HEAVY_PROBE_DATA_URL_INVALID');
  }
  if (
    !options.protocols.has(parsed.protocol)
    || parsed.hostname.toLowerCase() !== options.hostname
    || parsed.port !== options.port
    || !parsed.username
    || !parsed.password
    || (
      options.requireDatabasePath
        ? parsed.pathname.length <= 1
        : (
            parsed.pathname === ''
              ? options.allowEmptyPath !== true
              : !/^\/(?:[0-9]+)?$/u.test(parsed.pathname)
          )
    )
    || parsed.search
    || parsed.hash
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_DATA_URL_INVALID');
  }
  return rawValue;
}

function attestDataPlaneVariables(payloads, config) {
  attestServiceVariableIdentity(
    payloads.webVariables,
    config,
    config.webServiceId,
    config.webServiceName
  );
  attestServiceVariableIdentity(
    payloads.workerVariables,
    config,
    config.workerServiceId,
    config.workerServiceName
  );
  attestServiceVariableIdentity(
    payloads.postgresVariables,
    config,
    config.postgresServiceId,
    config.postgresServiceName
  );
  attestServiceVariableIdentity(
    payloads.redisVariables,
    config,
    config.redisServiceId,
    config.redisServiceName
  );
  if (
    payloads.postgresVariables.RAILWAY_PRIVATE_DOMAIN?.toLowerCase()
      !== config.postgresInternalHost
    || payloads.redisVariables.RAILWAY_PRIVATE_DOMAIN?.toLowerCase()
      !== config.redisInternalHost
    || payloads.webVariables.RAILWAY_GIT_COMMIT_SHA?.toLowerCase()
      !== config.sourceSha
    || payloads.workerVariables.RAILWAY_GIT_COMMIT_SHA?.toLowerCase()
      !== config.sourceSha
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_VARIABLE_IDENTITY_MISMATCH');
  }

  const postgresUrl = validateInternalServiceUrl(
    payloads.postgresVariables.DATABASE_URL,
    {
      hostname: config.postgresInternalHost,
      port: '5432',
      protocols: new Set(['postgres:', 'postgresql:']),
      requireDatabasePath: true,
    }
  );
  const redisUrl = validateInternalServiceUrl(
    payloads.redisVariables.REDIS_URL,
    {
      hostname: config.redisInternalHost,
      port: '6379',
      protocols: new Set(['redis:']),
      requireDatabasePath: false,
      allowEmptyPath: true,
    }
  );
  if (
    payloads.webVariables.DATABASE_URL !== postgresUrl
    || payloads.workerVariables.DATABASE_URL !== postgresUrl
    || payloads.webVariables.REDIS_URL !== redisUrl
    || payloads.workerVariables.REDIS_URL !== redisUrl
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_DATA_URL_MISMATCH');
  }

  const forbiddenEnvironmentName = /^(?:OPENAI_API_KEY|OPENAI_KEY|API_KEY|RAILWAY_OPENAI_API_KEY|RAILWAY_OPENAI_BASE_URL|OPENAI_API_BASE_URL|OPENAI_API_BASE|OPENAI_BASEURL|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY|NODE_OPTIONS|NODE_USE_ENV_PROXY)$/iu;
  for (const variables of [payloads.webVariables, payloads.workerVariables]) {
    if (Object.keys(variables).some(name => (
      FORBIDDEN_DATA_ALIAS_NAMES.has(name.toUpperCase())
    ))) {
      fail('BACKSTAGE_HEAVY_PROBE_DATA_ALIAS_FORBIDDEN');
    }
    if (Object.entries(variables).some(([name, value]) => (
      (
        forbiddenEnvironmentName.test(name)
        || /(?:OPENAI|API)_KEY$/iu.test(name)
      )
      && typeof value === 'string'
      && value.length > 0
    ))) {
      fail('BACKSTAGE_HEAVY_PROBE_PROVIDER_ENV_FORBIDDEN');
    }
  }
  if (
    payloads.webVariables.OPENAI_BASE_URL !== 'http://127.0.0.1:9/v1'
    || payloads.workerVariables.OPENAI_BASE_URL
      !== 'http://127.0.0.1:8766/v1'
    || payloads.workerVariables.ARCANOS_PREVIEW_OPENAI_FIXTURE
      !== 'backstage-heavy-compact-retry-v1'
    || payloads.webVariables.ARCANOS_PREVIEW_OPENAI_FIXTURE
      !== undefined
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_PROVIDER_ENV_MISMATCH');
  }
  const exactCommonVariables = [
    ['ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET', 'dedicated-backstage-heavy-preview-v1'],
    ['ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID', config.runId],
    ['ARCANOS_PREVIEW_ISOLATION', 'true'],
    ['FORCE_MOCK', 'true'],
    ['ALLOW_MOCK_OPENAI', 'true'],
    ['OPENAI_API_KEY_REQUIRED', 'false'],
    ['ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID', config.postgresServiceId],
    ['ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME', config.postgresServiceName],
    ['ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST', config.postgresInternalHost],
    ['ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID', config.redisServiceId],
    ['ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME', config.redisServiceName],
    ['ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST', config.redisInternalHost],
  ];
  for (const variables of [payloads.webVariables, payloads.workerVariables]) {
    if (exactCommonVariables.some(([name, value]) => variables[name] !== value)) {
      fail('BACKSTAGE_HEAVY_PROBE_PROOF_ENV_MISMATCH');
    }
  }
  if (
    payloads.webVariables.ARCANOS_PROCESS_KIND !== 'web'
    || payloads.workerVariables.ARCANOS_PROCESS_KIND !== 'worker'
    || payloads.webVariables
      .ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED !== 'true'
    || Object.prototype.hasOwnProperty.call(
      payloads.workerVariables,
      'ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED'
    )
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_PROOF_ENV_MISMATCH');
  }
  const payloadKey = payloads.webVariables
    .ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  const accessToken = payloads.webVariables
    .ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN;
  const jobReadSecret = payloads.webVariables
    .ARCANOS_JOB_READ_CAPABILITY_SECRET;
  if (
    typeof payloadKey !== 'string'
    || !/^[A-Za-z0-9+/]{43}=$/u.test(payloadKey)
    || payloads.workerVariables.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY
      !== payloadKey
    || Object.prototype.hasOwnProperty.call(
      payloads.webVariables,
      'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY'
    )
    || Object.prototype.hasOwnProperty.call(
      payloads.workerVariables,
      'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY'
    )
    || typeof accessToken !== 'string'
    || accessToken.length < 32
    || typeof jobReadSecret !== 'string'
    || jobReadSecret.length < 32
    || jobReadSecret.length > 4_096
    || !/^[\x21-\x7e]+$/u.test(jobReadSecret)
    || jobReadSecret === accessToken
    || jobReadSecret === payloadKey
    || accessToken === payloadKey
    || Object.prototype.hasOwnProperty.call(
      payloads.workerVariables,
      'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN'
    )
    || Object.prototype.hasOwnProperty.call(
      payloads.workerVariables,
      'ARCANOS_JOB_READ_CAPABILITY_SECRET'
    )
    || Object.prototype.hasOwnProperty.call(
      payloads.webVariables,
      'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET'
    )
    || Object.prototype.hasOwnProperty.call(
      payloads.workerVariables,
      'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET'
    )
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_PURPOSE_CREDENTIAL_MISMATCH');
  }
  return {
    databaseBound: true,
    redisBound: true,
  };
}

export function attestBackstageHeavyRailwayControlPlane(
  payloads,
  config
) {
  const status = attestBackstageHeavyRailwayStatus(payloads.status, config);
  attestDomainList(payloads.webDomains, [`https://${status.webDomain}`]);
  attestDomainList(payloads.workerDomains, []);
  attestDomainList(payloads.postgresDomains, []);
  attestDomainList(payloads.redisDomains, []);
  attestNoTcpProxy(payloads.postgresTcpProxies);
  attestNoTcpProxy(payloads.redisTcpProxies);
  attestDeploymentList(
    payloads.webDeployments,
    config.webServiceId,
    config.webDeploymentId,
    config.sourceSha
  );
  attestDeploymentList(
    payloads.workerDeployments,
    config.workerServiceId,
    config.workerDeploymentId,
    config.sourceSha
  );
  attestDataPlaneVariables(payloads, config);
  return status;
}

async function readRailwayJson(command, args, env, invocation) {
  try {
    const result = await command(
      invocation.executable,
      [...invocation.argsPrefix, ...args],
      {
      encoding: 'utf8',
      env: buildBackstageHeavyRailwayCliEnvironment(env),
      maxBuffer: RAILWAY_COMMAND_MAX_BYTES,
      timeout: RAILWAY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      }
    );
    return JSON.parse(result.stdout);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('BACKSTAGE_HEAVY_PROBE_')
    ) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_PROBE_RAILWAY_STATUS_UNAVAILABLE');
  }
}

export async function readRailwayControlPlaneAttestation(
  config,
  command = execFileAsync,
  env = process.env,
  invocation = railwayInvocationForBackstageHeavyProbe(
    process.platform,
    env.APPDATA,
    process.execPath
  )
) {
  const common = [
    '--project', config.projectId,
    '--environment', config.environmentName,
  ];
  const [
    status,
    webDomains,
    workerDomains,
    postgresDomains,
    redisDomains,
    postgresTcpProxies,
    redisTcpProxies,
    webDeployments,
    workerDeployments,
    webVariables,
    workerVariables,
    postgresVariables,
    redisVariables,
  ] =
    await Promise.all([
      readRailwayJson(command, ['status', ...common, '--json'], env, invocation),
      readRailwayJson(command, [
        'domain', 'list', ...common,
        '--service', config.webServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'domain', 'list', ...common,
        '--service', config.workerServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'domain', 'list', ...common,
        '--service', config.postgresServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'domain', 'list', ...common,
        '--service', config.redisServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'tcp-proxy', 'list', ...common,
        '--service', config.postgresServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'tcp-proxy', 'list', ...common,
        '--service', config.redisServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'deployment', 'list', ...common,
        '--service', config.webServiceId,
        '--limit', '5',
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'deployment', 'list', ...common,
        '--service', config.workerServiceId,
        '--limit', '5',
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'variable', 'list', ...common,
        '--service', config.webServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'variable', 'list', ...common,
        '--service', config.workerServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'variable', 'list', ...common,
        '--service', config.postgresServiceId,
        '--json',
      ], env, invocation),
      readRailwayJson(command, [
        'variable', 'list', ...common,
        '--service', config.redisServiceId,
        '--json',
      ], env, invocation),
    ]);
  return {
    status,
    webDomains,
    workerDomains,
    postgresDomains,
    redisDomains,
    postgresTcpProxies,
    redisTcpProxies,
    webDeployments,
    workerDeployments,
    webVariables,
    workerVariables,
    postgresVariables,
    redisVariables,
  };
}

function validateSubmissionPair(submissions) {
  if (submissions.some(item => (
    item.response.status !== 202
    || item.response.headers.get('x-gpt-route-decision-reason')
      !== 'backstage_prompt_size'
    || item.response.headers.get('x-gpt-queue-bypassed') !== 'false'
    || !/^application\/json(?:;|$)/iu.test(
      item.response.headers.get('content-type') ?? ''
    )
    || !(item.response.headers.get('cache-control') ?? '')
      .toLowerCase()
      .split(',')
      .some(value => value.trim() === 'no-store')
  ))) {
    fail('BACKSTAGE_HEAVY_PROBE_SUBMISSION_STATUS_INVALID');
  }
  const bodies = submissions.map(item => item.body);
  const jobId = bodies[0].jobId;
  const token = bodies[0].jobReadToken;
  const publicIdentity = bodies[0].idempotencyKey;
  if (
    typeof jobId !== 'string'
    || !JOB_ID_PATTERN.test(jobId)
    || typeof token !== 'string'
    || !CAPABILITY_PATTERN.test(token)
    || bodies.some(body => (
      body.jobId !== jobId
      || body.jobReadToken !== token
      || body.jobReadTokenHeader !== 'x-arcanos-job-read-token'
      || body.poll !== `/jobs/${jobId}/result`
      || body.idempotencySource !== 'derived'
      || body.idempotencyKey !== publicIdentity
    ))
    || typeof publicIdentity !== 'string'
    || !DERIVED_PUBLIC_ID_PATTERN.test(publicIdentity)
    || bodies.filter(body => body.deduped === true).length !== 1
    || submissions.some(item => (
      item.response.headers.get('x-request-id') !== item.requestId
      || item.response.headers.get('x-trace-id') !== item.traceId
    ))
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_DEDUPE_INVALID');
  }
  const createdSubmission = submissions.find(
    item => item.body.deduped !== true
  );
  if (
    !createdSubmission
    || createdSubmission.response.headers.get('x-request-id')
      !== createdSubmission.requestId
    || createdSubmission.response.headers.get('x-trace-id')
      !== createdSubmission.traceId
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_ACK_CORRELATION_INVALID');
  }
  return {
    jobId,
    token,
    createdRequestId: createdSubmission.requestId,
    createdTraceId: createdSubmission.traceId,
  };
}

function validateTerminalResult(body, expectedCorrelation) {
  const numberedItems = typeof body.result?.result === 'string'
    ? body.result.result.split('\n')
    : [];
  if (
    body.status !== 'completed'
    || body.jobStatus !== 'completed'
    || body.lifecycleStatus !== 'completed'
    || body.error !== null
    || body.result?.ok !== true
    || body.result?.result !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT
    || body.result?._route?.gptId !== 'backstage-booker'
    || body.result?._route?.action !== 'generateBooking'
    || body.result?._route?.requestId !== expectedCorrelation.requestId
    || body.result?._route?.traceId !== expectedCorrelation.traceId
    || numberedItems.length !== 6
    || numberedItems.some((item, index) => (
      !item.startsWith(`${index + 1}. `)
      || item.length > 512
    ))
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_TERMINAL_RESULT_INVALID');
  }
  const serialized = JSON.stringify(body);
  if (
    serialized.includes(BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT)
    || serialized.includes(BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL)
    || serialized.includes('sealedPayload')
    || serialized.includes('ciphertext')
    || serialized.includes('authTag')
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_TERMINAL_RESULT_LEAKED');
  }
}

export async function runBackstageHeavyProbe(
  config,
  options = {}
) {
  if (!config.execute || !config.allowNetwork) {
    return {
      mode: 'dry-run',
      networkRequests: 0,
      target: config.target,
      environmentName: config.environmentName,
      sourceSha: config.sourceSha,
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const railwayPayloads = options.railwayPayloads
    ?? await readRailwayControlPlaneAttestation(
      config,
      options.execFileImpl,
      options.env ?? process.env,
      options.railwayInvocation
    );
  attestBackstageHeavyRailwayControlPlane(railwayPayloads, config);
  const bearer = (options.env ?? process.env)[
    BACKSTAGE_HEAVY_PROBE_BEARER_ENV
  ]?.trim();
  if (
    !bearer
    || bearer.length < 32
    || bearer.length > 512
    || !/^[\x21-\x7e]+$/u.test(bearer)
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_BEARER_UNAVAILABLE');
  }
  if (
    railwayPayloads.webVariables.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN
      !== bearer
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_BEARER_TARGET_MISMATCH');
  }
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const prompt = buildBackstageHeavyProbePrompt(config.runId);
  const requestBody = JSON.stringify({
    action: 'generateBooking',
    executionMode: 'sync',
    payload: {
      universeId: `fixture-${config.runId}`,
      prompt,
    },
  });
  const submit = async (suffix) => {
    const requestId = `bh-${config.runId}-${suffix}`;
    const traceId = `bht-${config.runId}-${suffix}`;
    const fetched = await boundedJsonFetch(
      fetchImpl,
      `${config.baseUrl}/gpt/backstage-booker`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'x-request-id': requestId,
          'x-trace-id': traceId,
        },
        body: requestBody,
      }
    );
    return {
      response: fetched.response,
      body: fetched.body,
      requestId,
      traceId,
    };
  };
  const submissions = await Promise.all([submit('a'), submit('b')]);
  const {
    jobId,
    token,
    createdRequestId,
    createdTraceId,
  } = validateSubmissionPair(submissions);

  const unauthorized = await boundedJsonFetch(
    fetchImpl,
    `${config.baseUrl}/jobs/${jobId}/result`,
    { method: 'GET' }
  );
  if (
    unauthorized.response.status !== 200
    || unauthorized.body.status !== 'not_found'
    || unauthorized.body.result !== null
  ) {
    fail('BACKSTAGE_HEAVY_PROBE_RESULT_CAPABILITY_GATE_INVALID');
  }

  const startedAt = now();
  let pollCount = 0;
  let pendingObserved = false;
  let terminalBody = null;
  while (now() - startedAt <= POLL_TIMEOUT_MS) {
    pollCount += 1;
    const fetched = await boundedJsonFetch(
      fetchImpl,
      `${config.baseUrl}/jobs/${jobId}/result`,
      {
        method: 'GET',
        headers: { 'x-arcanos-job-read-token': token },
      }
    );
    if (fetched.response.status !== 200) {
      fail('BACKSTAGE_HEAVY_PROBE_POLL_STATUS_INVALID');
    }
    const body = fetched.body;
    if (body.status === 'pending') {
      pendingObserved = true;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    terminalBody = body;
    break;
  }
  if (!pendingObserved || terminalBody === null) {
    fail('BACKSTAGE_HEAVY_PROBE_PENDING_OR_TERMINAL_MISSING');
  }
  validateTerminalResult(terminalBody, {
    requestId: createdRequestId,
    traceId: createdTraceId,
  });

  return {
    mode: 'executed',
    target: config.target,
    projectId: config.projectId,
    environmentId: config.environmentId,
    environmentName: config.environmentName,
    webServiceId: config.webServiceId,
    webDeploymentId: config.webDeploymentId,
    workerServiceId: config.workerServiceId,
    workerDeploymentId: config.workerDeploymentId,
    postgresServiceId: config.postgresServiceId,
    redisServiceId: config.redisServiceId,
    sourceSha: config.sourceSha,
    runId: config.runId,
    jobId,
    jobIdSha256: digest(jobId),
    requestId: createdRequestId,
    traceId: createdTraceId,
    resultSha256: digest(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT),
    duplicatePrevented: true,
    pendingObserved,
    pollCount,
    compactRetryResultObserved: true,
    railwayTopologyAttested: true,
    dataPlaneAttested: true,
    unauthorizedResultConcealed: true,
  };
}

async function main() {
  const config = resolveBackstageHeavyProbeConfig(process.argv.slice(2));
  const result = await runBackstageHeavyProbe(config);
  const safeResult = { ...result };
  delete safeResult.bearer;
  process.stdout.write(`${JSON.stringify(safeResult)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof Error
      ? error.message
      : 'BACKSTAGE_HEAVY_PROBE_FAILED';
    process.stderr.write(`${code.startsWith('BACKSTAGE_HEAVY_PROBE_') ? code : 'BACKSTAGE_HEAVY_PROBE_FAILED'}\n`);
    process.exitCode = 1;
  });
}
