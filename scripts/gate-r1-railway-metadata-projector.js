#!/usr/bin/env node
/**
 * Purpose: Project only the allowlisted Railway metadata required by Gate R1.
 * Safety: Uses fixed read-only queries, exact target/scope validation, bounded responses,
 * and never requests variable values, raw config, domain values, or endpoint hostnames.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GATE_R1_METADATA_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const GATE_R1_METADATA_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R1_METADATA_PROJECT_NAME = 'Arcanos';
export const GATE_R1_METADATA_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R1_METADATA_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
export const GATE_R1_METADATA_PRIVATE_NETWORK_ID = '464f2194-3825-4ac1-a705-192566561675';
export const GATE_R1_METADATA_TOKEN_ENV = 'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN';
export const GATE_R1_METADATA_RESPONSE_LIMIT_BYTES = 64 * 1024;
export const GATE_R1_METADATA_TIMEOUT_MS = 10_000;
export const GATE_R1_METADATA_TOKEN_MAX_CHARACTERS = 512;
export const GATE_R1_POSTGRES_R3_SERVICE_ID = '7346b3f6-bf3d-46e1-9d66-79f10847ef89';
export const GATE_R1_POSTGRES_R3_SERVICE_INSTANCE_ID = '86dde430-50ac-4d5c-95c3-cb27064eff51';
export const GATE_R1_POSTGRES_R3_SERVICE_NAME = 'phase2e-postgres-r3-20260720';

export const GATE_R1_APPROVED_SERVICES = Object.freeze({
  'b7789306-8aef-4113-add5-02883a6cc087': 'Postgres',
  '434fa5b4-b52c-4caf-aaba-e87c173bf10d': 'Redis',
  'a2a57da4-a928-427f-be30-d4a68b59a117': 'phase2e-postgres-r2-20260718',
  '1ac0bd56-50b3-49eb-954c-ea83515ec915': 'phase2e-redis-r2-20260718',
  'c4ade025-3f13-4fca-9309-5d0dd81396fe': 'ARCANOS V2',
  '1765befb-b805-4051-9af9-28634e986886': 'ARCANOS Worker',
  'd8d5181a-2f72-48d7-8413-6f05d113876c': 'phase2e-migration-validator-20260718',
  'febdf999-1c96-48df-8e28-c905b8b27082': 'phase2e-compatibility-validator-20260718',
  [GATE_R1_POSTGRES_R3_SERVICE_ID]: GATE_R1_POSTGRES_R3_SERVICE_NAME
});
export const GATE_R1_REPLACEMENT_NAMES = Object.freeze([
  'phase2e-postgres-r2-20260718',
  'phase2e-redis-r2-20260718',
  'phase2e-postgres-r3-20260720'
]);
export const GATE_R1_NEW_REPLACEMENT_NAMES = Object.freeze([]);
export const GATE_R1_ENDPOINT_NAMES = Object.freeze([
  'phase2e-redis-r2-20260718',
  'phase2e-postgres-r3-20260720'
]);
export const GATE_R1_APPROVED_IMAGES_BY_SERVICE = Object.freeze({
  'phase2e-postgres-r3-20260720': 'ghcr.io/railwayapp-templates/postgres-ssl:18.4',
  'phase2e-redis-r2-20260718': 'redis:8.2.1'
});
export const GATE_R1_APPROVED_REDIS_START_COMMAND = '/bin/sh -c \'test "$RAILWAY_VOLUME_MOUNT_PATH" = /data && test -n "$REDIS_PASSWORD" && { [ ! -e /data/lost+found ] || rmdir /data/lost+found; } && exec docker-entrypoint.sh redis-server --requirepass "$REDIS_PASSWORD" --save 60 1 --dir /data\'';

export const GATE_R1_ENVIRONMENT_METADATA_QUERY = `query GateR1EnvironmentMetadata($projectId: String!, $environmentId: String!) {
  projectToken {
    projectId
    environmentId
  }
  project(id: $projectId) {
    id
    name
    services(first: 100) {
      pageInfo { hasNextPage }
      edges { node { id name } }
    }
  }
  environment(id: $environmentId) {
    id
    name
    projectId
    serviceInstances(first: 100) {
      pageInfo { hasNextPage }
      edges {
        node {
          id
          serviceId
          serviceName
          environmentId
          deletedAt
          restartPolicyType
          restartPolicyMaxRetries
          startCommand
          source { image repo }
          latestDeployment { id status createdAt }
          activeDeployments { id status createdAt }
          domains {
            serviceDomains { id deletedAt environmentId serviceId }
            customDomains { id deletedAt environmentId serviceId }
          }
        }
      }
    }
    volumeInstances(first: 100) {
      pageInfo { hasNextPage }
      edges {
        node {
          id
          serviceId
          environmentId
          mountPath
          state
          volume { id name projectId }
        }
      }
    }
    variables(first: 100) {
      pageInfo { hasNextPage }
      edges {
        node { id name serviceId environmentId isSealed }
      }
    }
  }
  privateNetworks(environmentId: $environmentId) {
    publicId
    projectId
    environmentId
    deletedAt
  }
}`;

export const GATE_R1_PRIVATE_ENDPOINT_QUERY = `query GateR1PrivateEndpoint($environmentId: String!, $privateNetworkId: String!, $serviceId: String!) {
  projectToken {
    projectId
    environmentId
  }
  service(id: $serviceId) {
    id
    name
    projectId
  }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id
    environmentId
    serviceId
  }
  privateNetworkEndpoint(
    environmentId: $environmentId
    privateNetworkId: $privateNetworkId
    serviceId: $serviceId
  ) {
    publicId
    deletedAt
    serviceInstanceId
    syncStatus
  }
}`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/i;
const DEPLOYMENT_STATUSES = new Set([
  'BUILDING', 'CRASHED', 'DEPLOYING', 'FAILED', 'INITIALIZING',
  'NEEDS_APPROVAL', 'QUEUED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING',
  'SUCCESS', 'WAITING'
]);
const VOLUME_STATES = new Set(['DELETED', 'DELETING', 'ERROR', 'MIGRATING', 'MIGRATION_PENDING', 'READY', 'RESTORING', 'UPDATING']);
const ENDPOINT_SYNC_STATUSES = new Set(['ACTIVE', 'CREATING', 'DELETED', 'DELETING', 'UNSPECIFIED', 'UPDATING']);
const RESTART_POLICY_TYPES = new Set(['ALWAYS', 'NEVER', 'ON_FAILURE']);
const SAFE_CODES = new Set([
  'GATE_R1_METADATA_ARGUMENT_INVALID',
  'GATE_R1_METADATA_AUTH_REFUSED',
  'GATE_R1_METADATA_CLOCK_INVALID',
  'GATE_R1_METADATA_GRAPHQL_FAILED',
  'GATE_R1_METADATA_HTTP_FAILED',
  'GATE_R1_METADATA_REQUEST_FAILED',
  'GATE_R1_METADATA_RESPONSE_INVALID',
  'GATE_R1_METADATA_SCOPE_MISMATCH',
  'GATE_R1_METADATA_TARGET_FORBIDDEN',
  'GATE_R1_METADATA_TIMEOUT',
  'GATE_R1_METADATA_TOKEN_INVALID',
  'GATE_R1_METADATA_TOKEN_MISSING'
]);

function fail(code) { throw new Error(code); }
function safeError(error) { return error instanceof Error && SAFE_CODES.has(error.message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function uuid(value) { return typeof value === 'string' && UUID_PATTERN.test(value); }
function nullableString(value) { return value === null || typeof value === 'string'; }
function isoOrNull(value) {
  return value === null || (typeof value === 'string' && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value)));
}

function assertGraphqlSuccessEnvelope(value) {
  if (plain(value) && (Object.hasOwn(value, 'errors') || (Object.hasOwn(value, 'data') && value.data === null))) {
    fail('GATE_R1_METADATA_GRAPHQL_FAILED');
  }
}

function resolveObservedAt(clock) {
  let observedAt;
  try { observedAt = clock(); } catch { fail('GATE_R1_METADATA_CLOCK_INVALID'); }
  if (typeof observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
      || Number.isNaN(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    fail('GATE_R1_METADATA_CLOCK_INVALID');
  }
  return observedAt;
}

function resolveToken(env) {
  let projectAccessValue;
  try { projectAccessValue = env?.[GATE_R1_METADATA_TOKEN_ENV]; } catch { fail('GATE_R1_METADATA_TOKEN_INVALID'); }
  if (typeof projectAccessValue !== 'string' || projectAccessValue.trim().length === 0) fail('GATE_R1_METADATA_TOKEN_MISSING');
  if (projectAccessValue.length > GATE_R1_METADATA_TOKEN_MAX_CHARACTERS
      || projectAccessValue !== projectAccessValue.trim() || /[^\x21-\x7e]/.test(projectAccessValue)) {
    fail('GATE_R1_METADATA_TOKEN_INVALID');
  }
  return projectAccessValue;
}

function assertScope(scope) {
  if (!exact(scope, ['projectId', 'environmentId']) || !uuid(scope.projectId) || !uuid(scope.environmentId)) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  if (scope.projectId !== GATE_R1_METADATA_PROJECT_ID || scope.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID) {
    fail('GATE_R1_METADATA_SCOPE_MISMATCH');
  }
}

function parseConnection(value, projectNode, max = 100) {
  if (!exact(value, ['pageInfo', 'edges']) || !exact(value.pageInfo, ['hasNextPage']) || value.pageInfo.hasNextPage !== false) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  if (!Array.isArray(value.edges) || value.edges.length > max) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  return value.edges.map((edge) => {
    if (!exact(edge, ['node']) || !plain(edge.node)) fail('GATE_R1_METADATA_RESPONSE_INVALID');
    return projectNode(edge.node);
  });
}

function projectDeployment(value) {
  if (value === null) return null;
  if (!exact(value, ['id', 'status', 'createdAt']) || !uuid(value.id) || !DEPLOYMENT_STATUSES.has(value.status) || !isoOrNull(value.createdAt)) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  return Object.freeze({ id: value.id, status: value.status, createdAt: value.createdAt });
}

function approvedServiceName(serviceId, serviceName) {
  const fixed = GATE_R1_APPROVED_SERVICES[serviceId];
  return fixed !== undefined && fixed === serviceName;
}

function projectService(node) {
  const keys = [
    'id', 'serviceId', 'serviceName', 'environmentId', 'deletedAt', 'restartPolicyType',
    'restartPolicyMaxRetries', 'startCommand', 'source', 'latestDeployment',
    'activeDeployments', 'domains'
  ];
  if (!exact(node, keys) || !uuid(node.id) || !uuid(node.serviceId)
      || node.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID
      || typeof node.serviceName !== 'string' || !approvedServiceName(node.serviceId, node.serviceName)
      || !isoOrNull(node.deletedAt) || !RESTART_POLICY_TYPES.has(node.restartPolicyType)
      || !Number.isSafeInteger(node.restartPolicyMaxRetries) || node.restartPolicyMaxRetries < 0
      || !nullableString(node.startCommand)) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  if (node.serviceId === GATE_R1_POSTGRES_R3_SERVICE_ID
      && node.id !== GATE_R1_POSTGRES_R3_SERVICE_INSTANCE_ID) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  if (node.source !== null && (!exact(node.source, ['image', 'repo']) || !nullableString(node.source.image) || !nullableString(node.source.repo))) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  if (!Array.isArray(node.activeDeployments) || node.activeDeployments.length > 10) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const activeDeployments = node.activeDeployments.map(projectDeployment);
  if (activeDeployments.some((item) => item === null)) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const ids = new Set(activeDeployments.map(({ id }) => id));
  if (ids.size !== activeDeployments.length) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  if (!exact(node.domains, ['serviceDomains', 'customDomains'])
      || !Array.isArray(node.domains.serviceDomains) || !Array.isArray(node.domains.customDomains)
      || node.domains.serviceDomains.length > 20 || node.domains.customDomains.length > 20) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  for (const domain of [...node.domains.serviceDomains, ...node.domains.customDomains]) {
    if (!exact(domain, ['id', 'deletedAt', 'environmentId', 'serviceId']) || !uuid(domain.id)
        || !isoOrNull(domain.deletedAt) || domain.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID
        || domain.serviceId !== node.serviceId) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  const latestDeployment = projectDeployment(node.latestDeployment);
  const approvedSourceImage = node.source?.image !== null
    && node.source?.image !== undefined
    && GATE_R1_APPROVED_IMAGES_BY_SERVICE[node.serviceName] === node.source.image
    ? node.source.image
    : null;
  const startCommandContract = node.serviceName === 'phase2e-redis-r2-20260718'
    ? node.startCommand === GATE_R1_APPROVED_REDIS_START_COMMAND ? 'APPROVED_REDIS' : node.startCommand === null ? 'MISSING' : 'MISMATCH'
    : node.serviceName === 'phase2e-postgres-r3-20260720'
      ? node.startCommand === null ? 'UNSET' : 'MISMATCH'
      : 'NOT_APPLICABLE';
  return Object.freeze({
    serviceId: node.serviceId,
    serviceInstanceId: node.id,
    serviceName: node.serviceName,
    deleted: node.deletedAt !== null,
    sourceKind: node.source === null ? 'NONE' : node.source.image !== null ? 'IMAGE' : node.source.repo !== null ? 'REPOSITORY' : 'NONE',
    sourceImage: approvedSourceImage,
    sourceImageApproved: node.source?.image === null || node.source?.image === undefined
      ? null
      : approvedSourceImage !== null,
    repositoryConfigured: node.source?.repo !== null && node.source?.repo !== undefined,
    latestDeployment,
    activeDeployments,
    restartPolicyType: node.restartPolicyType,
    restartPolicyMaxRetries: node.restartPolicyMaxRetries,
    startCommandContract,
    railwayDomainCount: node.domains.serviceDomains.filter(({ deletedAt }) => deletedAt === null).length,
    customDomainCount: node.domains.customDomains.filter(({ deletedAt }) => deletedAt === null).length
  });
}

function projectVolume(node) {
  if (!exact(node, ['id', 'serviceId', 'environmentId', 'mountPath', 'state', 'volume'])
      || !uuid(node.id) || !uuid(node.serviceId) || node.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID
      || typeof node.mountPath !== 'string' || node.mountPath.length === 0 || !VOLUME_STATES.has(node.state)
      || !exact(node.volume, ['id', 'name', 'projectId']) || !uuid(node.volume.id)
      || node.volume.projectId !== GATE_R1_METADATA_PROJECT_ID
      || typeof node.volume.name !== 'string' || node.volume.name.length === 0 || node.volume.name.length > 128) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  return Object.freeze({
    volumeInstanceId: node.id,
    volumeId: node.volume.id,
    volumeName: node.volume.name,
    serviceId: node.serviceId,
    mountPath: node.mountPath,
    state: node.state
  });
}

function projectVariable(node) {
  if (!exact(node, ['id', 'name', 'serviceId', 'environmentId', 'isSealed'])
      || !uuid(node.id) || !NAME_PATTERN.test(node.name) || !(node.serviceId === null || uuid(node.serviceId))
      || node.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID || typeof node.isSealed !== 'boolean') {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  return Object.freeze({ serviceId: node.serviceId, name: node.name, sealed: node.isSealed });
}

function projectEnvironmentResponse(parsed) {
  if (!exact(parsed, ['data']) || !exact(parsed.data, ['projectToken', 'project', 'environment', 'privateNetworks'])) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  assertScope(parsed.data.projectToken);
  if (!exact(parsed.data.project, ['id', 'name', 'services'])
      || parsed.data.project.id !== GATE_R1_METADATA_PROJECT_ID
      || parsed.data.project.name !== GATE_R1_METADATA_PROJECT_NAME) fail('GATE_R1_METADATA_SCOPE_MISMATCH');
  const projectServices = parseConnection(parsed.data.project.services, (node) => {
    if (!exact(node, ['id', 'name']) || !uuid(node.id) || typeof node.name !== 'string'
        || node.name.length === 0 || node.name.length > 128) fail('GATE_R1_METADATA_RESPONSE_INVALID');
    return Object.freeze({ serviceId: node.id, serviceName: node.name });
  });
  if (new Set(projectServices.map(({ serviceId }) => serviceId)).size !== projectServices.length
      || new Set(projectServices.map(({ serviceName }) => serviceName)).size !== projectServices.length) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  const environment = parsed.data.environment;
  if (!exact(environment, ['id', 'name', 'projectId', 'serviceInstances', 'volumeInstances', 'variables'])
      || environment.id !== GATE_R1_METADATA_ENVIRONMENT_ID
      || environment.name !== GATE_R1_METADATA_ENVIRONMENT_NAME
      || environment.projectId !== GATE_R1_METADATA_PROJECT_ID) fail('GATE_R1_METADATA_SCOPE_MISMATCH');

  const services = parseConnection(environment.serviceInstances, projectService);
  const serviceIds = new Set(services.map(({ serviceId }) => serviceId));
  const serviceNames = new Set(services.map(({ serviceName }) => serviceName));
  if (serviceIds.size !== services.length || serviceNames.size !== services.length) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const projectServiceById = new Map(projectServices.map(({ serviceId, serviceName }) => [serviceId, serviceName]));
  if (services.some(({ serviceId, serviceName }) => projectServiceById.get(serviceId) !== serviceName)) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  const volumes = parseConnection(environment.volumeInstances, projectVolume);
  if (new Set(volumes.map(({ volumeId }) => volumeId)).size !== volumes.length
      || new Set(volumes.map(({ volumeInstanceId }) => volumeInstanceId)).size !== volumes.length
      || volumes.some(({ serviceId }) => !serviceIds.has(serviceId))) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const variables = parseConnection(environment.variables, projectVariable);
  if (variables.some(({ serviceId }) => serviceId !== null && !serviceIds.has(serviceId))) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const variableScopes = new Set();
  for (const { serviceId, name } of variables) {
    const scopeKey = `${serviceId ?? 'shared'}\u0000${name}`;
    if (variableScopes.has(scopeKey)) fail('GATE_R1_METADATA_RESPONSE_INVALID');
    variableScopes.add(scopeKey);
  }

  if (!Array.isArray(parsed.data.privateNetworks) || parsed.data.privateNetworks.length > 10) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const activeNetworks = parsed.data.privateNetworks.filter((network) => {
    if (!exact(network, ['publicId', 'projectId', 'environmentId', 'deletedAt'])
        || !uuid(network.publicId) || network.projectId !== GATE_R1_METADATA_PROJECT_ID
        || network.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID || !isoOrNull(network.deletedAt)) {
      fail('GATE_R1_METADATA_RESPONSE_INVALID');
    }
    return network.deletedAt === null;
  });
  if (activeNetworks.length !== 1) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  if (activeNetworks[0].publicId !== GATE_R1_METADATA_PRIVATE_NETWORK_ID) {
    fail('GATE_R1_METADATA_SCOPE_MISMATCH');
  }

  const variablesByService = Object.fromEntries([...serviceIds].sort().map((serviceId) => [
    serviceId,
    variables.filter((item) => item.serviceId === serviceId)
      .map(({ name, sealed }) => Object.freeze({ name, sealed }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ]));
  const sharedVariableNames = variables.filter(({ serviceId }) => serviceId === null)
    .map(({ name }) => name).sort((a, b) => a.localeCompare(b));
  return Object.freeze({
    projectId: GATE_R1_METADATA_PROJECT_ID,
    projectName: GATE_R1_METADATA_PROJECT_NAME,
    environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
    environmentName: GATE_R1_METADATA_ENVIRONMENT_NAME,
    privateNetworkId: activeNetworks[0].publicId,
    projectServices: projectServices.sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    services: services.sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    volumes: volumes.sort((a, b) => a.volumeId.localeCompare(b.volumeId)),
    variablesByService,
    sharedVariableNames
  });
}

function projectEndpointResponse(parsed, { serviceId, serviceName, privateNetworkId }) {
  if (!exact(parsed, ['data']) || !exact(parsed.data, ['projectToken', 'service', 'serviceInstance', 'privateNetworkEndpoint'])) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  assertScope(parsed.data.projectToken);
  if (!exact(parsed.data.service, ['id', 'name', 'projectId'])
      || parsed.data.service.id !== serviceId || parsed.data.service.name !== serviceName
      || parsed.data.service.projectId !== GATE_R1_METADATA_PROJECT_ID) fail('GATE_R1_METADATA_SCOPE_MISMATCH');
  const serviceInstance = parsed.data.serviceInstance;
  if (!exact(serviceInstance, ['id', 'environmentId', 'serviceId']) || !uuid(serviceInstance.id)
      || serviceInstance.environmentId !== GATE_R1_METADATA_ENVIRONMENT_ID
      || serviceInstance.serviceId !== serviceId) fail('GATE_R1_METADATA_SCOPE_MISMATCH');
  if (serviceId === GATE_R1_POSTGRES_R3_SERVICE_ID
      && serviceInstance.id !== GATE_R1_POSTGRES_R3_SERVICE_INSTANCE_ID) {
    fail('GATE_R1_METADATA_SCOPE_MISMATCH');
  }
  const endpoint = parsed.data.privateNetworkEndpoint;
  if (endpoint !== null && (!exact(endpoint, ['publicId', 'deletedAt', 'serviceInstanceId', 'syncStatus'])
      || !uuid(endpoint.publicId) || !isoOrNull(endpoint.deletedAt)
      || endpoint.serviceInstanceId !== serviceInstance.id || !ENDPOINT_SYNC_STATUSES.has(endpoint.syncStatus))) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  return Object.freeze({
    projectId: GATE_R1_METADATA_PROJECT_ID,
    environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
    serviceId,
    serviceName,
    serviceInstanceId: serviceInstance.id,
    privateNetworkId,
    endpointPresent: endpoint !== null && endpoint.deletedAt === null,
    endpointSyncStatus: endpoint?.syncStatus ?? null
  });
}

function cancelReaderBestEffort(reader) {
  try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* suppress */ }
}

async function readBounded(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > GATE_R1_METADATA_RESPONSE_LIMIT_BYTES)) {
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  }
  if (!response.body?.getReader) fail('GATE_R1_METADATA_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  let rejectForAbort;
  const abortPromise = new Promise((_resolve, reject) => { rejectForAbort = reject; });
  const onAbort = () => {
    cancelReaderBestEffort(reader);
    rejectForAbort(new Error('GATE_R1_METADATA_TIMEOUT'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    while (true) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (!plain(part) || typeof part.done !== 'boolean') fail('GATE_R1_METADATA_RESPONSE_INVALID');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail('GATE_R1_METADATA_RESPONSE_INVALID');
      size += part.value.byteLength;
      if (size > GATE_R1_METADATA_RESPONSE_LIMIT_BYTES) fail('GATE_R1_METADATA_RESPONSE_INVALID');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (safeError(error)) throw error;
    fail(signal.aborted ? 'GATE_R1_METADATA_TIMEOUT' : 'GATE_R1_METADATA_RESPONSE_INVALID');
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) cancelReaderBestEffort(reader);
    try { reader.releaseLock(); } catch { /* fixed output is unaffected */ }
  }
}

async function requestProjection({ query, variables, project, env, fetchImpl, setTimeoutImpl, clearTimeoutImpl, AbortControllerImpl, clock }) {
  const projectAccessValue = resolveToken(env);
  if (typeof fetchImpl !== 'function') fail('GATE_R1_METADATA_REQUEST_FAILED');
  let controller;
  let timer;
  try {
    controller = new AbortControllerImpl();
    timer = setTimeoutImpl(() => controller.abort(), GATE_R1_METADATA_TIMEOUT_MS);
    timer?.unref?.();
  } catch { fail('GATE_R1_METADATA_REQUEST_FAILED'); }
  try {
    let response;
    try {
      response = await fetchImpl(GATE_R1_METADATA_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json', 'Cache-Control': 'no-store',
          'Content-Type': 'application/json', Pragma: 'no-cache',
          'Project-Access-Token': projectAccessValue
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store'
      });
    } catch { fail(controller.signal.aborted ? 'GATE_R1_METADATA_TIMEOUT' : 'GATE_R1_METADATA_REQUEST_FAILED'); }
    if (!response || !Number.isSafeInteger(response.status)) {
      fail('GATE_R1_METADATA_RESPONSE_INVALID');
    }
    if (response.status === 401 || response.status === 403) fail('GATE_R1_METADATA_AUTH_REFUSED');
    if (response.status !== 200) fail('GATE_R1_METADATA_HTTP_FAILED');
    if (!JSON_CONTENT_TYPE_PATTERN.test(response.headers?.get?.('content-type') ?? '')) {
      fail('GATE_R1_METADATA_RESPONSE_INVALID');
    }
    const raw = await readBounded(response, controller.signal);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('GATE_R1_METADATA_RESPONSE_INVALID'); }
    assertGraphqlSuccessEnvelope(parsed);
    const projected = project(parsed);
    if (controller.signal.aborted) fail('GATE_R1_METADATA_TIMEOUT');
    const observedAt = resolveObservedAt(clock);
    if (controller.signal.aborted) fail('GATE_R1_METADATA_TIMEOUT');
    return Object.freeze({ schemaVersion: 1, observedAt, ...projected });
  } catch (error) {
    if (safeError(error)) throw error;
    fail('GATE_R1_METADATA_RESPONSE_INVALID');
  } finally {
    try { clearTimeoutImpl(timer); } catch { /* never disclose cleanup diagnostics */ }
  }
}

const defaults = {
  env: process.env, fetchImpl: globalThis.fetch, setTimeoutImpl: setTimeout,
  clearTimeoutImpl: clearTimeout, AbortControllerImpl: AbortController,
  clock: () => new Date().toISOString()
};

export function projectGateR1EnvironmentMetadata(options = {}) {
  const dependencies = { ...defaults, ...options };
  return requestProjection({
    ...dependencies,
    query: GATE_R1_ENVIRONMENT_METADATA_QUERY,
    variables: { projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID },
    project: projectEnvironmentResponse
  });
}

export function projectGateR1PrivateEndpoint({ serviceId, serviceName, privateNetworkId, ...options }) {
  const fixedServiceName = GATE_R1_APPROVED_SERVICES[serviceId];
  const approvedTarget = fixedServiceName === serviceName
    && GATE_R1_ENDPOINT_NAMES.includes(serviceName);
  if (!uuid(serviceId) || !approvedTarget || privateNetworkId !== GATE_R1_METADATA_PRIVATE_NETWORK_ID) {
    fail('GATE_R1_METADATA_TARGET_FORBIDDEN');
  }
  const dependencies = { ...defaults, ...options };
  return requestProjection({
    ...dependencies,
    query: GATE_R1_PRIVATE_ENDPOINT_QUERY,
    variables: { environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, privateNetworkId, serviceId },
    project: (parsed) => projectEndpointResponse(parsed, { serviceId, serviceName, privateNetworkId })
  });
}

export function parseGateR1MetadataArgs(argv) {
  if (Array.isArray(argv) && argv.length === 1 && argv[0] === '--environment') return Object.freeze({ mode: 'environment' });
  if (Array.isArray(argv) && argv.length === 7 && argv[0] === '--endpoint'
      && argv[1] === '--service-id' && argv[3] === '--service-name' && argv[5] === '--private-network-id'
      && uuid(argv[2]) && uuid(argv[6])) {
    const fixedServiceName = GATE_R1_APPROVED_SERVICES[argv[2]];
    const approvedTarget = fixedServiceName === argv[4]
      && GATE_R1_ENDPOINT_NAMES.includes(argv[4]);
    if (!approvedTarget || argv[6] !== GATE_R1_METADATA_PRIVATE_NETWORK_ID) {
      fail('GATE_R1_METADATA_TARGET_FORBIDDEN');
    }
    return Object.freeze({ mode: 'endpoint', serviceId: argv[2], serviceName: argv[4], privateNetworkId: argv[6] });
  }
  fail('GATE_R1_METADATA_ARGUMENT_INVALID');
}

export async function runGateR1MetadataCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  try {
    const args = parseGateR1MetadataArgs(argv);
    const result = args.mode === 'environment'
      ? await projectGateR1EnvironmentMetadata(options)
      : await projectGateR1PrivateEndpoint({ ...args, ...options });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${safeError(error) ? error.message : 'GATE_R1_METADATA_FAILED'}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await runGateR1MetadataCli();
