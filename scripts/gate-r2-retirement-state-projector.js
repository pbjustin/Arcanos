#!/usr/bin/env node
/**
 * Project the exact Gate R2 retirement and final-isolation state.
 * The fixed query returns identities and safe state only. Variable values are
 * requested only for the two validators with unrendered=true, classified in
 * memory, and never emitted.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GATE_R2_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const GATE_R2_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R2_PROJECT_NAME = 'Arcanos';
export const GATE_R2_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R2_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
export const GATE_R2_PRIVATE_NETWORK_ID = '464f2194-3825-4ac1-a705-192566561675';
export const GATE_R2_TOKEN_ENV = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN';
export const GATE_R2_RESPONSE_LIMIT_BYTES = 96 * 1024;
export const GATE_R2_TIMEOUT_MS = 10_000;

export const GATE_R2_RETIREMENT_TARGETS = Object.freeze({
  'original-postgres': Object.freeze({
    serviceId: 'b7789306-8aef-4113-add5-02883a6cc087',
    serviceInstanceId: '6dac21a3-ad8a-4b98-ad50-637054c13729',
    serviceName: 'Postgres',
    volumeId: '35c26093-1e3f-4d34-b699-89c65d2fb92d',
    volumeInstanceId: 'b8f04086-2e97-4167-a0fd-bcb259541e9f',
    mountPath: '/var/lib/postgresql/data',
    tcpAlias: 'originalPostgresTcp'
  }),
  'failed-postgres-r2': Object.freeze({
    serviceId: 'a2a57da4-a928-427f-be30-d4a68b59a117',
    serviceInstanceId: 'e8c42bea-d887-485b-8aaf-ba0f45d439e8',
    serviceName: 'phase2e-postgres-r2-20260718',
    volumeId: '2998734d-7530-4f26-b715-cea4780bd437',
    volumeInstanceId: '46113532-5609-46da-b7b4-46b8f06930cc',
    mountPath: '/var/lib/postgresql/data',
    tcpAlias: 'failedPostgresR2Tcp'
  }),
  'original-redis': Object.freeze({
    serviceId: '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
    serviceInstanceId: '8340f02f-dbcb-4c0e-bdde-b3f7c4bf5856',
    serviceName: 'Redis',
    volumeId: 'd3690500-fcc5-4c06-afa6-cf30e91f608d',
    volumeInstanceId: 'f222873c-255e-45a2-9a17-840bdba108f6',
    mountPath: '/data',
    tcpAlias: 'originalRedisTcp'
  })
});

export const GATE_R2_RETIREMENT_ORDER = Object.freeze([
  'original-postgres',
  'failed-postgres-r2',
  'original-redis'
]);

export const GATE_R2_ACTIVE_REPLACEMENTS = Object.freeze({
  'postgres-r3': Object.freeze({
    serviceId: '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
    serviceInstanceId: '86dde430-50ac-4d5c-95c3-cb27064eff51',
    serviceName: 'phase2e-postgres-r3-20260720',
    volumeId: 'ce93ced0-0c15-48f9-87fc-d9153ffefdc8',
    volumeInstanceId: 'c7969acf-79fd-4a6b-83d7-1e6cb442a030',
    mountPath: '/var/lib/postgresql/data',
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:18.4',
    deploymentId: 'b5e45d34-19b8-4253-b230-c3ab0b60b0d7',
    endpointAlias: 'postgresR3Endpoint',
    tcpAlias: 'postgresR3Tcp',
    variableNames: Object.freeze([
      'DATABASE_URL', 'PGDATA', 'PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT',
      'PGUSER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER',
      'RAILWAY_DEPLOYMENT_DRAINING_SECONDS', 'SSL_CERT_DAYS'
    ])
  }),
  'redis-r2': Object.freeze({
    serviceId: '1ac0bd56-50b3-49eb-954c-ea83515ec915',
    serviceInstanceId: '0f34bcbb-bfd0-4df5-954a-bb97371bd460',
    serviceName: 'phase2e-redis-r2-20260718',
    volumeId: '983c4f0a-9180-4621-b65e-dfdd0b79f2bd',
    volumeInstanceId: 'b96f20a3-a1f1-40ea-ba4b-334ea3e8ba15',
    mountPath: '/data',
    image: 'redis:8.2.1',
    deploymentId: '9f102e53-ef25-46b5-80e8-0243eb1512d6',
    endpointAlias: 'redisR2Endpoint',
    tcpAlias: 'redisR2Tcp',
    variableNames: Object.freeze([
      'REDISHOST', 'REDISPASSWORD', 'REDISPORT', 'REDISUSER',
      'REDIS_PASSWORD', 'REDIS_URL'
    ])
  })
});

export const GATE_R2_INACTIVE_CONSUMERS = Object.freeze({
  'arcanos-v2': Object.freeze({
    serviceId: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
    serviceInstanceId: null,
    serviceName: 'ARCANOS V2',
    requiredPresent: false,
    tcpAlias: 'arcanosV2Tcp'
  }),
  'arcanos-worker': Object.freeze({
    serviceId: '1765befb-b805-4051-9af9-28634e986886',
    serviceInstanceId: null,
    serviceName: 'ARCANOS Worker',
    requiredPresent: false,
    tcpAlias: 'arcanosWorkerTcp'
  }),
  'migration-validator': Object.freeze({
    serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
    serviceInstanceId: '7a645cbc-dadf-4072-84c1-6f0843fa30d9',
    serviceName: 'phase2e-migration-validator-20260718',
    referenceAlias: 'migrationValidatorVariables',
    requiredPresent: true,
    tcpAlias: 'migrationValidatorTcp'
  }),
  'compatibility-validator': Object.freeze({
    serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
    serviceInstanceId: '3c385dd2-c786-4149-9319-2a168a920aa9',
    serviceName: 'phase2e-compatibility-validator-20260718',
    referenceAlias: 'compatibilityValidatorVariables',
    requiredPresent: true,
    tcpAlias: 'compatibilityValidatorTcp'
  })
});

const ALL_PROFILES = Object.freeze({
  ...GATE_R2_RETIREMENT_TARGETS,
  ...GATE_R2_ACTIVE_REPLACEMENTS,
  ...GATE_R2_INACTIVE_CONSUMERS
});
const PROFILE_BY_SERVICE_ID = new Map(
  Object.entries(ALL_PROFILES).map(([profile, value]) => [value.serviceId, profile])
);

export const GATE_R2_RETIREMENT_STATE_QUERY = `query GateR2RetirementState(
  $projectId: String!
  $environmentId: String!
  $privateNetworkId: String!
  $originalPostgresServiceId: String!
  $originalRedisServiceId: String!
  $failedPostgresR2ServiceId: String!
  $postgresR3ServiceId: String!
  $redisR2ServiceId: String!
  $arcanosV2ServiceId: String!
  $arcanosWorkerServiceId: String!
  $migrationValidatorServiceId: String!
  $compatibilityValidatorServiceId: String!
) {
  projectToken { projectId environmentId }
  project(id: $projectId) { id name }
  environment(id: $environmentId) {
    id name projectId
    serviceInstances(first: 100) {
      pageInfo { hasNextPage }
      edges { node {
        id serviceId serviceName environmentId deletedAt
        restartPolicyType restartPolicyMaxRetries
        source { image }
        latestDeployment { id status }
        activeDeployments { id status }
        domains {
          serviceDomains { id deletedAt environmentId serviceId }
          customDomains { id deletedAt environmentId serviceId }
        }
      } }
    }
    volumeInstances(first: 100) {
      pageInfo { hasNextPage }
      edges { node { id serviceId environmentId mountPath state volume { id projectId } } }
    }
    variables(first: 100) {
      pageInfo { hasNextPage }
      edges { node { id name serviceId environmentId isSealed } }
    }
  }
  privateNetworks(environmentId: $environmentId) { publicId projectId environmentId deletedAt }
  postgresR3Endpoint: privateNetworkEndpoint(
    environmentId: $environmentId privateNetworkId: $privateNetworkId serviceId: $postgresR3ServiceId
  ) { publicId deletedAt serviceInstanceId syncStatus }
  redisR2Endpoint: privateNetworkEndpoint(
    environmentId: $environmentId privateNetworkId: $privateNetworkId serviceId: $redisR2ServiceId
  ) { publicId deletedAt serviceInstanceId syncStatus }
  migrationValidatorVariables: variables(
    projectId: $projectId environmentId: $environmentId
    serviceId: $migrationValidatorServiceId unrendered: true
  )
  compatibilityValidatorVariables: variables(
    projectId: $projectId environmentId: $environmentId
    serviceId: $compatibilityValidatorServiceId unrendered: true
  )
  originalPostgresTcp: tcpProxies(environmentId: $environmentId, serviceId: $originalPostgresServiceId) { id serviceId environmentId deletedAt }
  originalRedisTcp: tcpProxies(environmentId: $environmentId, serviceId: $originalRedisServiceId) { id serviceId environmentId deletedAt }
  failedPostgresR2Tcp: tcpProxies(environmentId: $environmentId, serviceId: $failedPostgresR2ServiceId) { id serviceId environmentId deletedAt }
  postgresR3Tcp: tcpProxies(environmentId: $environmentId, serviceId: $postgresR3ServiceId) { id serviceId environmentId deletedAt }
  redisR2Tcp: tcpProxies(environmentId: $environmentId, serviceId: $redisR2ServiceId) { id serviceId environmentId deletedAt }
  arcanosV2Tcp: tcpProxies(environmentId: $environmentId, serviceId: $arcanosV2ServiceId) { id serviceId environmentId deletedAt }
  arcanosWorkerTcp: tcpProxies(environmentId: $environmentId, serviceId: $arcanosWorkerServiceId) { id serviceId environmentId deletedAt }
  migrationValidatorTcp: tcpProxies(environmentId: $environmentId, serviceId: $migrationValidatorServiceId) { id serviceId environmentId deletedAt }
  compatibilityValidatorTcp: tcpProxies(environmentId: $environmentId, serviceId: $compatibilityValidatorServiceId) { id serviceId environmentId deletedAt }
}`;

const QUERY_VARIABLES = Object.freeze({
  projectId: GATE_R2_PROJECT_ID,
  environmentId: GATE_R2_ENVIRONMENT_ID,
  privateNetworkId: GATE_R2_PRIVATE_NETWORK_ID,
  originalPostgresServiceId: GATE_R2_RETIREMENT_TARGETS['original-postgres'].serviceId,
  originalRedisServiceId: GATE_R2_RETIREMENT_TARGETS['original-redis'].serviceId,
  failedPostgresR2ServiceId: GATE_R2_RETIREMENT_TARGETS['failed-postgres-r2'].serviceId,
  postgresR3ServiceId: GATE_R2_ACTIVE_REPLACEMENTS['postgres-r3'].serviceId,
  redisR2ServiceId: GATE_R2_ACTIVE_REPLACEMENTS['redis-r2'].serviceId,
  arcanosV2ServiceId: GATE_R2_INACTIVE_CONSUMERS['arcanos-v2'].serviceId,
  arcanosWorkerServiceId: GATE_R2_INACTIVE_CONSUMERS['arcanos-worker'].serviceId,
  migrationValidatorServiceId: GATE_R2_INACTIVE_CONSUMERS['migration-validator'].serviceId,
  compatibilityValidatorServiceId: GATE_R2_INACTIVE_CONSUMERS['compatibility-validator'].serviceId
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/iu;
const DEPLOYMENT_STATUSES = new Set([
  'BUILDING', 'CRASHED', 'DEPLOYING', 'FAILED', 'INITIALIZING',
  'NEEDS_APPROVAL', 'QUEUED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING',
  'SUCCESS', 'WAITING'
]);
const RESTART_POLICIES = new Set(['ALWAYS', 'NEVER', 'ON_FAILURE']);
const ENDPOINT_STATUSES = new Set(['ACTIVE', 'CREATING', 'DELETED', 'DELETING', 'UNSPECIFIED', 'UPDATING']);
const VOLUME_STATES = new Set([
  'DELETED', 'DELETING', 'ERROR', 'MIGRATING', 'MIGRATION_PENDING',
  'READY', 'RESTORING', 'UPDATING'
]);
const SAFE_CODES = new Set([
  'GATE_R2_RETIREMENT_ARGUMENT_INVALID', 'GATE_R2_RETIREMENT_CLOCK_INVALID',
  'GATE_R2_RETIREMENT_REQUEST_FAILED', 'GATE_R2_RETIREMENT_RESPONSE_INVALID',
  'GATE_R2_RETIREMENT_SCOPE_MISMATCH', 'GATE_R2_RETIREMENT_TIMEOUT',
  'GATE_R2_RETIREMENT_TOKEN_INVALID', 'GATE_R2_RETIREMENT_TOKEN_MISSING'
]);
const R3_REFERENCE = '${{phase2e-postgres-r3-20260720.DATABASE_URL}}';

function fail(code) { throw new Error(code); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function uuid(value) { return typeof value === 'string' && UUID_PATTERN.test(value); }
function isoOrNull(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) return false;
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(value).toISOString() === canonical;
}
function profileCode(profile) { return profile.toUpperCase().replaceAll('-', '_'); }

function parseConnection(value, projector) {
  if (!exact(value, ['pageInfo', 'edges']) || !exact(value.pageInfo, ['hasNextPage'])
      || value.pageInfo.hasNextPage !== false || !Array.isArray(value.edges)
      || value.edges.length > 100) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  return value.edges.map((edge) => {
    if (!exact(edge, ['node'])) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    return projector(edge.node);
  });
}

function projectDeployment(node) {
  if (node === null) return null;
  if (!exact(node, ['id', 'status']) || !uuid(node.id) || !DEPLOYMENT_STATUSES.has(node.status)) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  return Object.freeze({ id: node.id, status: node.status });
}

function activeDomainCount(domains, serviceId) {
  if (!exact(domains, ['serviceDomains', 'customDomains'])
      || !Array.isArray(domains.serviceDomains) || !Array.isArray(domains.customDomains)
      || domains.serviceDomains.length > 20 || domains.customDomains.length > 20) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const project = (values) => values.filter((domain) => {
    if (!exact(domain, ['id', 'deletedAt', 'environmentId', 'serviceId'])
        || !uuid(domain.id) || !isoOrNull(domain.deletedAt)
        || domain.environmentId !== GATE_R2_ENVIRONMENT_ID || domain.serviceId !== serviceId) {
      fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    }
    return domain.deletedAt === null;
  }).length;
  return Object.freeze({
    railwayDomainCount: project(domains.serviceDomains),
    customDomainCount: project(domains.customDomains)
  });
}

function projectServiceNode(node) {
  if (!exact(node, [
    'id', 'serviceId', 'serviceName', 'environmentId', 'deletedAt',
    'restartPolicyType', 'restartPolicyMaxRetries', 'source', 'latestDeployment',
    'activeDeployments', 'domains'
  ]) || !uuid(node.id) || !uuid(node.serviceId)
      || node.environmentId !== GATE_R2_ENVIRONMENT_ID || !isoOrNull(node.deletedAt)
      || !RESTART_POLICIES.has(node.restartPolicyType)
      || !Number.isSafeInteger(node.restartPolicyMaxRetries) || node.restartPolicyMaxRetries < 0
      || !(node.source === null || (exact(node.source, ['image']) && typeof node.source.image === 'string'))
      || !Array.isArray(node.activeDeployments) || node.activeDeployments.length > 10) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const profile = PROFILE_BY_SERVICE_ID.get(node.serviceId);
  const expected = profile && ALL_PROFILES[profile];
  if (!expected || expected.serviceInstanceId === null
      || node.id !== expected.serviceInstanceId || node.serviceName !== expected.serviceName) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const latestDeployment = projectDeployment(node.latestDeployment);
  const activeDeployments = node.activeDeployments.map(projectDeployment);
  const deploymentIds = new Set(activeDeployments.map(({ id }) => id));
  if (deploymentIds.size !== activeDeployments.length) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  const domainCounts = activeDomainCount(node.domains, node.serviceId);
  return Object.freeze({
    profile,
    serviceId: node.serviceId,
    serviceInstanceId: node.id,
    serviceState: node.deletedAt === null ? 'PRESENT' : 'TOMBSTONED',
    restartPolicyType: node.restartPolicyType,
    restartPolicyMaxRetries: node.restartPolicyMaxRetries,
    sourceImage: node.source?.image ?? null,
    latestDeployment,
    activeDeployments,
    ...domainCounts
  });
}

function absentService(profile) {
  const expected = ALL_PROFILES[profile];
  return Object.freeze({
    profile,
    serviceId: expected.serviceId,
    serviceInstanceId: expected.serviceInstanceId,
    serviceState: 'ABSENT',
    restartPolicyType: null,
    restartPolicyMaxRetries: null,
    sourceImage: null,
    latestDeployment: null,
    activeDeployments: Object.freeze([]),
    railwayDomainCount: 0,
    customDomainCount: 0
  });
}

function projectVolumeNode(node) {
  if (!exact(node, ['id', 'serviceId', 'environmentId', 'mountPath', 'state', 'volume'])
      || !uuid(node.id) || !(node.serviceId === null || uuid(node.serviceId))
      || node.environmentId !== GATE_R2_ENVIRONMENT_ID
      || typeof node.mountPath !== 'string' || node.mountPath.length === 0
      || !VOLUME_STATES.has(node.state) || !exact(node.volume, ['id', 'projectId'])
      || !uuid(node.volume.id) || node.volume.projectId !== GATE_R2_PROJECT_ID) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  return Object.freeze({
    volumeInstanceId: node.id,
    volumeId: node.volume.id,
    serviceId: node.serviceId,
    mountPath: node.mountPath,
    railwayState: node.state
  });
}

function projectVolume(volumes, profile) {
  const expected = ALL_PROFILES[profile];
  const matches = volumes.filter(({ volumeId }) => volumeId === expected.volumeId);
  if (matches.length === 0) return Object.freeze({
    profile, volumeId: expected.volumeId, volumeInstanceId: expected.volumeInstanceId, volumeState: 'ABSENT'
  });
  if (matches.length !== 1 || matches[0].volumeInstanceId !== expected.volumeInstanceId) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const selected = matches[0];
  const exactShape = selected.mountPath === expected.mountPath && selected.railwayState === 'READY';
  const volumeState = !exactShape ? 'MISMATCH'
    : selected.serviceId === expected.serviceId ? 'RETAINED_ATTACHED'
      : selected.serviceId === null ? 'RETAINED_DETACHED' : 'MISMATCH';
  return Object.freeze({
    profile, volumeId: expected.volumeId, volumeInstanceId: expected.volumeInstanceId, volumeState
  });
}

function projectVariableNode(node) {
  if (!exact(node, ['id', 'name', 'serviceId', 'environmentId', 'isSealed'])
      || !uuid(node.id) || !NAME_PATTERN.test(node.name)
      || !(node.serviceId === null || PROFILE_BY_SERVICE_ID.has(node.serviceId))
      || node.environmentId !== GATE_R2_ENVIRONMENT_ID || typeof node.isSealed !== 'boolean') {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  return Object.freeze({ name: node.name, serviceId: node.serviceId });
}

function variableSummary(variables, profile) {
  const expected = ALL_PROFILES[profile];
  const names = variables.filter(({ serviceId }) => serviceId === expected.serviceId).map(({ name }) => name).sort();
  if (new Set(names).size !== names.length) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  const approvedNames = GATE_R2_ACTIVE_REPLACEMENTS[profile]?.variableNames
    ?? (GATE_R2_INACTIVE_CONSUMERS[profile]?.referenceAlias ? ['DATABASE_URL'] : null);
  const variableNameState = approvedNames === null ? 'OBSERVED'
    : names.length === approvedNames.length && names.every((name, index) => name === [...approvedNames].sort()[index])
      ? 'MATCH' : 'MISMATCH';
  return Object.freeze({
    variableNameCount: names.length,
    publicUrlVariableCount: names.filter((name) => /_PUBLIC_URL$/u.test(name)).length,
    variableNameState
  });
}

function projectTcpProxies(value, serviceId) {
  if (!Array.isArray(value) || value.length > 20) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  const ids = new Set();
  let count = 0;
  for (const proxy of value) {
    if (!exact(proxy, ['id', 'serviceId', 'environmentId', 'deletedAt'])
        || !uuid(proxy.id) || ids.has(proxy.id) || proxy.serviceId !== serviceId
        || proxy.environmentId !== GATE_R2_ENVIRONMENT_ID || !isoOrNull(proxy.deletedAt)) {
      fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    }
    ids.add(proxy.id);
    if (proxy.deletedAt === null) count += 1;
  }
  return count;
}

function projectEndpoint(node, expected) {
  if (node === null) return 'ABSENT';
  if (!exact(node, ['publicId', 'deletedAt', 'serviceInstanceId', 'syncStatus'])
      || !uuid(node.publicId) || !isoOrNull(node.deletedAt)
      || node.serviceInstanceId !== expected.serviceInstanceId
      || !ENDPOINT_STATUSES.has(node.syncStatus)) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  return node.deletedAt === null && node.syncStatus === 'ACTIVE' ? 'ACTIVE' : 'MISMATCH';
}

function classifyValidatorReference(value) {
  if (!plain(value) || !exact(value, ['DATABASE_URL'])) return 'INVALID';
  return value.DATABASE_URL === R3_REFERENCE ? 'POSTGRES_R3' : 'INVALID';
}

export function parseGateR2RetirementArgs(argv) {
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--phase' && argv[1] === 'pre') {
    return Object.freeze({ phase: 'pre', profile: null });
  }
  if (Array.isArray(argv) && argv.length === 4 && argv[0] === '--phase'
      && ['post', 'final'].includes(argv[1]) && argv[2] === '--profile'
      && Object.hasOwn(GATE_R2_RETIREMENT_TARGETS, argv[3])) {
    return Object.freeze({ phase: argv[1], profile: argv[3] });
  }
  fail('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
}

export function projectGateR2RetirementResponse(parsed, { phase, profile, observedAt }) {
  const dataKeys = [
    'projectToken', 'project', 'environment', 'privateNetworks',
    'postgresR3Endpoint', 'redisR2Endpoint',
    'migrationValidatorVariables', 'compatibilityValidatorVariables',
    'originalPostgresTcp', 'originalRedisTcp', 'failedPostgresR2Tcp',
    'postgresR3Tcp', 'redisR2Tcp', 'arcanosV2Tcp', 'arcanosWorkerTcp',
    'migrationValidatorTcp', 'compatibilityValidatorTcp'
  ];
  if (!exact(parsed, ['data']) || !exact(parsed.data, dataKeys)
      || !exact(parsed.data.projectToken, ['projectId', 'environmentId'])
      || parsed.data.projectToken.projectId !== GATE_R2_PROJECT_ID
      || parsed.data.projectToken.environmentId !== GATE_R2_ENVIRONMENT_ID) {
    fail('GATE_R2_RETIREMENT_SCOPE_MISMATCH');
  }
  if (!exact(parsed.data.project, ['id', 'name']) || parsed.data.project.id !== GATE_R2_PROJECT_ID
      || parsed.data.project.name !== GATE_R2_PROJECT_NAME
      || !exact(parsed.data.environment, [
        'id', 'name', 'projectId', 'serviceInstances', 'volumeInstances', 'variables'
      ]) || parsed.data.environment.id !== GATE_R2_ENVIRONMENT_ID
      || parsed.data.environment.name !== GATE_R2_ENVIRONMENT_NAME
      || parsed.data.environment.projectId !== GATE_R2_PROJECT_ID) {
    fail('GATE_R2_RETIREMENT_SCOPE_MISMATCH');
  }

  if (!Array.isArray(parsed.data.privateNetworks) || parsed.data.privateNetworks.length > 10) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const activeNetworks = parsed.data.privateNetworks.filter((network) => {
    if (!exact(network, ['publicId', 'projectId', 'environmentId', 'deletedAt'])
        || !uuid(network.publicId) || network.projectId !== GATE_R2_PROJECT_ID
        || network.environmentId !== GATE_R2_ENVIRONMENT_ID || !isoOrNull(network.deletedAt)) {
      fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    }
    return network.deletedAt === null;
  });
  if (activeNetworks.length !== 1 || activeNetworks[0].publicId !== GATE_R2_PRIVATE_NETWORK_ID) {
    fail('GATE_R2_RETIREMENT_SCOPE_MISMATCH');
  }

  const services = parseConnection(parsed.data.environment.serviceInstances, projectServiceNode);
  if (new Set(services.map(({ serviceId }) => serviceId)).size !== services.length
      || new Set(services.map(({ serviceInstanceId }) => serviceInstanceId)).size !== services.length) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const servicesByProfile = new Map(services.map((service) => [service.profile, service]));
  const getService = targetProfile => servicesByProfile.get(targetProfile) ?? absentService(targetProfile);

  const volumes = parseConnection(parsed.data.environment.volumeInstances, projectVolumeNode);
  if (new Set(volumes.map(({ volumeId }) => volumeId)).size !== volumes.length
      || new Set(volumes.map(({ volumeInstanceId }) => volumeInstanceId)).size !== volumes.length) {
    fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  }
  const variables = parseConnection(parsed.data.environment.variables, projectVariableNode);
  const variableKeys = variables.map(({ serviceId, name }) => `${serviceId ?? 'shared'}\u0000${name}`);
  if (new Set(variableKeys).size !== variableKeys.length) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  const sharedVariableCount = variables.filter(({ serviceId }) => serviceId === null).length;

  const targetEntries = GATE_R2_RETIREMENT_ORDER.map((targetProfile) => {
    const expected = GATE_R2_RETIREMENT_TARGETS[targetProfile];
    return Object.freeze({
      ...getService(targetProfile),
      activeDeploymentCount: getService(targetProfile).activeDeployments.length,
      latestDeploymentPresent: getService(targetProfile).latestDeployment !== null,
      ...variableSummary(variables, targetProfile),
      tcpProxyCount: projectTcpProxies(parsed.data[expected.tcpAlias], expected.serviceId),
      volume: projectVolume(volumes, targetProfile)
    });
  });
  const replacementEntries = Object.entries(GATE_R2_ACTIVE_REPLACEMENTS).map(([replacementProfile, expected]) => {
    const service = getService(replacementProfile);
    const deploymentHealthy = service.latestDeployment?.id === expected.deploymentId
      && service.latestDeployment.status === 'SUCCESS'
      && service.activeDeployments.length === 1
      && service.activeDeployments[0].id === expected.deploymentId
      && service.activeDeployments[0].status === 'SUCCESS';
    return Object.freeze({
      ...service,
      activeDeploymentCount: service.activeDeployments.length,
      sourceState: service.sourceImage === expected.image ? 'MATCH' : 'MISMATCH',
      deploymentState: deploymentHealthy ? 'HEALTHY' : 'MISMATCH',
      restartPolicyState: service.restartPolicyType === 'ON_FAILURE'
        && service.restartPolicyMaxRetries === 3 ? 'MATCH' : 'MISMATCH',
      ...variableSummary(variables, replacementProfile),
      privateEndpointState: projectEndpoint(parsed.data[expected.endpointAlias], expected),
      tcpProxyCount: projectTcpProxies(parsed.data[expected.tcpAlias], expected.serviceId),
      volume: projectVolume(volumes, replacementProfile)
    });
  });
  const consumerEntries = Object.entries(GATE_R2_INACTIVE_CONSUMERS).map(([consumerProfile, expected]) => {
    const service = getService(consumerProfile);
    return Object.freeze({
      profile: consumerProfile,
      serviceId: expected.serviceId,
      serviceInstanceId: expected.serviceInstanceId,
      serviceState: service.serviceState,
      activeDeploymentCount: service.activeDeployments.length,
      latestDeploymentPresent: service.latestDeployment !== null,
      railwayDomainCount: service.railwayDomainCount,
      customDomainCount: service.customDomainCount,
      tcpProxyCount: projectTcpProxies(parsed.data[expected.tcpAlias], expected.serviceId),
      ...variableSummary(variables, consumerProfile),
      referenceCategory: expected.referenceAlias
        ? classifyValidatorReference(parsed.data[expected.referenceAlias]) : 'NOT_APPLICABLE'
    });
  });

  const reasons = [];
  const retiredThrough = phase === 'post' ? GATE_R2_RETIREMENT_ORDER.indexOf(profile)
    : phase === 'final' ? GATE_R2_RETIREMENT_ORDER.length - 1 : -1;
  const disposedThrough = phase === 'final' ? GATE_R2_RETIREMENT_ORDER.indexOf(profile) : -1;
  for (const [index, entry] of targetEntries.entries()) {
    const retired = index <= retiredThrough;
    const serviceValid = retired
      ? ['ABSENT', 'TOMBSTONED'].includes(entry.serviceState)
      : entry.serviceState === 'PRESENT';
    const volumeValid = phase === 'final'
      ? index <= disposedThrough ? entry.volume.volumeState === 'ABSENT'
        : ['ABSENT', 'RETAINED_DETACHED'].includes(entry.volume.volumeState)
      : retired ? ['ABSENT', 'RETAINED_ATTACHED', 'RETAINED_DETACHED'].includes(entry.volume.volumeState)
        : entry.volume.volumeState === 'RETAINED_ATTACHED';
    if (!serviceValid) reasons.push(`SERVICE_STATE_${profileCode(entry.profile)}`);
    if (!volumeValid) reasons.push(`VOLUME_STATE_${profileCode(entry.profile)}`);
    if (entry.activeDeploymentCount !== 0 || entry.latestDeploymentPresent
        || entry.railwayDomainCount !== 0 || entry.customDomainCount !== 0 || entry.tcpProxyCount !== 0) {
      reasons.push(`EXPOSURE_STATE_${profileCode(entry.profile)}`);
    }
    if (retired && entry.variableNameCount !== 0) reasons.push(`VARIABLE_STATE_${profileCode(entry.profile)}`);
  }
  for (const entry of replacementEntries) {
    if (entry.serviceState !== 'PRESENT' || entry.activeDeploymentCount !== 1
        || entry.sourceState !== 'MATCH' || entry.deploymentState !== 'HEALTHY'
        || entry.restartPolicyState !== 'MATCH' || entry.variableNameState !== 'MATCH'
        || entry.publicUrlVariableCount !== 0 || entry.privateEndpointState !== 'ACTIVE'
        || entry.railwayDomainCount !== 0 || entry.customDomainCount !== 0
        || entry.tcpProxyCount !== 0 || entry.volume.volumeState !== 'RETAINED_ATTACHED') {
      reasons.push(`REPLACEMENT_STATE_${profileCode(entry.profile)}`);
    }
  }
  for (const entry of consumerEntries) {
    const expected = GATE_R2_INACTIVE_CONSUMERS[entry.profile];
    const stateValid = expected.requiredPresent
      ? entry.serviceState === 'PRESENT' : entry.serviceState === 'ABSENT';
    const variablesValid = expected.referenceAlias
      ? entry.variableNameState === 'MATCH' && entry.referenceCategory === 'POSTGRES_R3'
      : entry.variableNameCount === 0;
    if (!stateValid || entry.activeDeploymentCount !== 0 || entry.latestDeploymentPresent
        || entry.railwayDomainCount !== 0 || entry.customDomainCount !== 0
        || entry.tcpProxyCount !== 0 || entry.publicUrlVariableCount !== 0 || !variablesValid) {
      reasons.push(`CONSUMER_STATE_${profileCode(entry.profile)}`);
    }
  }
  if (sharedVariableCount !== 0) reasons.push('SHARED_VARIABLE_STATE');

  return Object.freeze({
    schemaVersion: 2,
    observedAt,
    projectId: GATE_R2_PROJECT_ID,
    environmentId: GATE_R2_ENVIRONMENT_ID,
    privateNetworkId: GATE_R2_PRIVATE_NETWORK_ID,
    phase,
    retiredProfile: phase === 'post' ? profile : null,
    disposedProfile: phase === 'final' ? profile : null,
    status: reasons.length === 0 ? 'PASS' : 'BLOCKED',
    reasonCodes: Object.freeze([...new Set(reasons)].sort()),
    sharedVariableCount,
    targets: Object.freeze(targetEntries),
    replacements: Object.freeze(replacementEntries),
    consumers: Object.freeze(consumerEntries)
  });
}

function cancelBestEffort(reader) {
  try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* suppress */ }
}

async function readBounded(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/u.test(declared)
      || Number(declared) > GATE_R2_RESPONSE_LIMIT_BYTES)) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  if (!response.body?.getReader) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) fail('GATE_R2_RETIREMENT_TIMEOUT');
      let abortListener;
      const aborted = new Promise((resolve) => {
        abortListener = () => resolve({ aborted: true });
        signal.addEventListener('abort', abortListener, { once: true });
      });
      const selected = await Promise.race([
        reader.read().then((result) => ({ aborted: false, result })), aborted
      ]);
      signal.removeEventListener('abort', abortListener);
      if (selected.aborted) fail('GATE_R2_RETIREMENT_TIMEOUT');
      const { done, value } = selected.result;
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
      total += value.byteLength;
      if (total > GATE_R2_RESPONSE_LIMIT_BYTES) fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    cancelBestEffort(reader);
  }
}

function readProjectAccessValue(env) {
  const projectAccessValue = env?.[GATE_R2_TOKEN_ENV];
  if (projectAccessValue === undefined) fail('GATE_R2_RETIREMENT_TOKEN_MISSING');
  if (typeof projectAccessValue !== 'string'
      || projectAccessValue.length < 16
      || projectAccessValue.length > 512
      || /[\u0000-\u0020\u007f]/u.test(projectAccessValue)) {
    fail('GATE_R2_RETIREMENT_TOKEN_INVALID');
  }
  return projectAccessValue;
}

export async function projectGateR2RetirementState({
  phase,
  profile = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date().toISOString(),
  timeoutMs = GATE_R2_TIMEOUT_MS
} = {}) {
  if (!['pre', 'post', 'final'].includes(phase)
      || (phase === 'pre' && profile !== null)
      || (phase !== 'pre' && !Object.hasOwn(GATE_R2_RETIREMENT_TARGETS, profile))) {
    fail('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
  }
  const observedAt = clock();
  if (!isoOrNull(observedAt) || observedAt === null) fail('GATE_R2_RETIREMENT_CLOCK_INVALID');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    fail('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
  }
  const projectAccessValue = readProjectAccessValue(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(GATE_R2_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: Object.freeze({
        accept: 'application/json',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        pragma: 'no-cache',
        'Project-Access-Token': projectAccessValue
      }),
      body: JSON.stringify({ query: GATE_R2_RETIREMENT_STATE_QUERY, variables: QUERY_VARIABLES }),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store'
    });
    if (!response || response.status !== 200
        || !CONTENT_TYPE_PATTERN.test(response.headers.get('content-type') ?? '')) {
      fail('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    }
    const text = await readBounded(response, controller.signal);
    let parsed;
    try { parsed = JSON.parse(text); } catch { fail('GATE_R2_RETIREMENT_RESPONSE_INVALID'); }
    return projectGateR2RetirementResponse(parsed, { phase, profile, observedAt });
  } catch (error) {
    if (error instanceof Error && SAFE_CODES.has(error.message)) throw error;
    if (controller.signal.aborted) fail('GATE_R2_RETIREMENT_TIMEOUT');
    fail('GATE_R2_RETIREMENT_REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

export async function runGateR2RetirementCli(argv, options = {}) {
  const parsed = parseGateR2RetirementArgs(argv);
  return projectGateR2RetirementState({ ...options, phase: parsed.phase, profile: parsed.profile });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = await runGateR2RetirementCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && SAFE_CODES.has(error.message)
      ? error.message : 'GATE_R2_RETIREMENT_REQUEST_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
