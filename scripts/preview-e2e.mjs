#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const TOKEN_ENV = 'ARCANOS_PREVIEW_GPT_ACCESS_TOKEN';
const SEARCH_ENV = 'ARCANOS_PREVIEW_E2E_SEARCH_QUERY';
const MODES = new Set(['discovery', 'readonly', 'confirmation-challenge']);
const TEST_EXECUTION_MODES = new Set([
  'disabled',
  'sandboxed',
  'unsandboxed-development-only'
]);
const PRODUCTIVITY_MODULE = 'ARCANOS:PRODUCTIVITY';
const LOCAL_AGENT_MODULE = 'ARCANOS:LOCAL_AGENT';
const PRODUCTIVITY_ACTIONS = Object.freeze([
  'intent.catalog',
  'intent.resolve',
  'state.current',
  'context.summary',
  'reference.resolve',
  'inbox.list',
  'task.list',
  'project.list',
  'project.health',
  'focus.today',
  'knowledge.find',
  'review.daily',
  'review.weekly',
  'capture.add',
  'inbox.process',
  'task.create',
  'task.complete',
  'task.defer',
  'task.transition',
  'project.create',
  'project.advance',
  'project.transition',
  'knowledge.store',
  'review.record'
]);
const LOCAL_AGENT_ACTIONS = Object.freeze([
  'local_agent.status',
  'repo.search',
  'git.status',
  'git.diff',
  'tests.run',
  'patch.preview',
  'patch.apply'
]);
const LOCAL_AGENT_CONTRACT_EXPECTATIONS = Object.freeze({
  'local_agent.status': {
    risk: 'readonly',
    requiresConfirmation: false,
    timeoutMs: 10_000,
    readOnly: true,
    mayModifyFiles: false
  },
  'repo.search': {
    risk: 'readonly',
    requiresConfirmation: false,
    timeoutMs: 30_000,
    readOnly: true,
    mayModifyFiles: false
  },
  'git.status': {
    risk: 'readonly',
    requiresConfirmation: false,
    timeoutMs: 15_000,
    readOnly: true,
    mayModifyFiles: false
  },
  'git.diff': {
    risk: 'readonly',
    requiresConfirmation: false,
    timeoutMs: 30_000,
    readOnly: true,
    mayModifyFiles: false
  },
  'tests.run': {
    risk: 'privileged',
    requiresConfirmation: true,
    timeoutMs: 900_000,
    readOnly: false,
    mayModifyFiles: true
  },
  'patch.preview': {
    risk: 'readonly',
    requiresConfirmation: false,
    timeoutMs: 30_000,
    readOnly: true,
    mayModifyFiles: false
  },
  'patch.apply': {
    risk: 'privileged',
    requiresConfirmation: true,
    timeoutMs: 60_000,
    readOnly: false,
    mayModifyFiles: true
  }
});
const PRODUCTIVITY_READ_ACTIONS = Object.freeze([
  ['intent.catalog', {}],
  ['intent.resolve', { utterance: "What's going on?" }],
  ['state.current', {}],
  ['context.summary', {}],
  ['reference.resolve', { entityType: 'task', reference: '__preview_e2e_missing__' }],
  ['inbox.list', {}],
  ['task.list', {}],
  ['project.list', {}],
  ['project.health', {}],
  ['focus.today', {}],
  ['knowledge.find', {}],
  ['review.daily', {}],
  ['review.weekly', {}]
]);
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RAILWAY_CLI_TIMEOUT_MS = 30_000;
const RAILWAY_CLI_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TARGET_NAME_PATTERN = /^[^\u0000-\u001F\u007F]{1,128}$/u;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const REJECTED_TARGET_PATTERN =
  /(?:^|[^a-z0-9])(?:production|prod|phase[-_. ]?2e|redis[-_. ]?validation)(?:$|[^a-z0-9])/iu;
const PREVIEW_TARGET_PATTERN =
  /(?:preview|(?:^|[-_.])pr[-_.]?\d+(?:$|[-_.])|(?:^|[-_.])e2e(?:$|[-_.]))/iu;
const RAILWAY_HOST_PATTERN = /(?:^|\.)railway\.(?:internal|app)$/iu;
const RAILWAY_PUBLIC_HOST_PATTERN = /(?:^|\.)up\.railway\.app$/iu;
const RAILWAY_PROXY_HOST_PATTERN = /(?:^|\.)proxy\.rlwy\.net$/iu;
const execFileAsync = promisify(execFile);

export class PreviewE2EError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreviewE2EError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreviewE2EError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) {
    fail(code, message);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.every((value) => typeof value === 'string')
    && stableJson([...actual].sort()) === stableJson([...expected].sort());
}

function assertExactActionCatalog(actual, expected, code, message) {
  requireCondition(hasExactStrings(actual, expected), code, message);
}

function assertLocalAgentContractMetadata(metadata, expectedContracts) {
  requireCondition(
    isObject(metadata)
      && Object.keys(metadata).length === LOCAL_AGENT_ACTIONS.length
      && hasExactStrings(Object.keys(metadata), LOCAL_AGENT_ACTIONS),
    'LOCAL_AGENT_METADATA_MISMATCH',
    'The local-agent action metadata does not match the exact action catalog.'
  );
  for (const action of LOCAL_AGENT_ACTIONS) {
    const contract = metadata[action];
    const expected = LOCAL_AGENT_CONTRACT_EXPECTATIONS[action];
    requireCondition(
      isObject(contract)
        && (contract.id === undefined || contract.id === action)
        && typeof contract.description === 'string'
        && contract.description.length > 0
        && contract.executionTarget === 'python-daemon'
        && isObject(contract.inputSchema)
        && isObject(contract.outputSchema)
        && contract.risk === expected.risk
        && contract.requiresConfirmation === expected.requiresConfirmation
        && contract.idempotent === true
        && contract.timeoutMs === expected.timeoutMs
        && hasExactStrings(contract.requiredDeviceScopes, [action])
        && contract.readOnly === expected.readOnly
        && contract.mayModifyFiles === expected.mayModifyFiles,
      'LOCAL_AGENT_METADATA_MISMATCH',
      `The local-agent contract metadata for ${action} is incomplete or unsafe.`
    );
    if (expectedContracts) {
      const authoritative = expectedContracts[action];
      requireCondition(
        isObject(authoritative)
          && authoritative.description === contract.description
          && stableJson(authoritative.inputSchema) === stableJson(contract.inputSchema)
          && stableJson(authoritative.outputSchema) === stableJson(contract.outputSchema),
        'LOCAL_AGENT_METADATA_MISMATCH',
        `Capability discovery drifted from the OpenAPI contract for ${action}.`
      );
    }
  }
}

function responseCode(body) {
  if (!isObject(body)) {
    return undefined;
  }
  if (typeof body.code === 'string') {
    return body.code;
  }
  if (isObject(body.error) && typeof body.error.code === 'string') {
    return body.error.code;
  }
  if (
    isObject(body.result)
    && isObject(body.result.error)
    && typeof body.result.error.code === 'string'
  ) {
    return body.result.error.code;
  }
  return undefined;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('INVALID_ARGUMENT', `${label} is outside its safe range.`);
  }
  return parsed;
}

function validateExpectedIdentifier(value, label) {
  requireCondition(
    typeof value === 'string' && TARGET_ID_PATTERN.test(value),
    'INVALID_TARGET_IDENTIFIER',
    `${label} must be an explicit non-secret identifier.`
  );
  return value;
}

function validateExpectedPreviewName(value, label) {
  requireCondition(
    typeof value === 'string'
      && value === value.trim()
      && TARGET_NAME_PATTERN.test(value)
      && PREVIEW_TARGET_PATTERN.test(value)
      && !REJECTED_TARGET_PATTERN.test(value),
    'INVALID_PREVIEW_NAME',
    `${label} must be an explicit preview-only name.`
  );
  return value;
}

export function validatePreviewTarget(input) {
  let url;
  try {
    url = new URL(input.baseUrl);
  } catch {
    fail('INVALID_BASE_URL', 'The preview base URL is invalid.');
  }
  requireCondition(url.protocol === 'https:', 'HTTPS_REQUIRED', 'The preview base URL must use HTTPS.');
  requireCondition(!url.username && !url.password, 'URL_CREDENTIALS_DENIED', 'URL credentials are denied.');
  requireCondition(
    (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash,
    'ORIGIN_ONLY_REQUIRED',
    'The preview base URL must be an origin without a path, query, or fragment.'
  );

  const target = {
    baseUrl: url.origin,
    projectId: validateExpectedIdentifier(input.projectId, 'project-id'),
    environmentId: validateExpectedIdentifier(input.environmentId, 'environment-id'),
    environmentName: validateExpectedPreviewName(input.environmentName, 'environment-name'),
    apiServiceId: validateExpectedIdentifier(input.apiServiceId, 'api-service-id'),
    apiServiceName: validateExpectedPreviewName(input.apiServiceName, 'api-service-name'),
    apiDeploymentId: validateExpectedIdentifier(input.apiDeploymentId, 'api-deployment-id'),
    workerServiceId: validateExpectedIdentifier(input.workerServiceId, 'worker-service-id'),
    workerServiceName: validateExpectedPreviewName(input.workerServiceName, 'worker-service-name'),
    workerDeploymentId: validateExpectedIdentifier(
      input.workerDeploymentId,
      'worker-deployment-id'
    ),
    postgresServiceId: validateExpectedIdentifier(
      input.postgresServiceId,
      'postgres-service-id'
    ),
    postgresServiceName: validateExpectedPreviewName(
      input.postgresServiceName,
      'postgres-service-name'
    ),
    redisServiceId: validateExpectedIdentifier(input.redisServiceId, 'redis-service-id'),
    redisServiceName: validateExpectedPreviewName(input.redisServiceName, 'redis-service-name'),
    commitSha: input.commitSha
  };
  requireCondition(
    typeof target.commitSha === 'string' && COMMIT_PATTERN.test(target.commitSha),
    'INVALID_COMMIT_SHA',
    'commit-sha must be an explicit hexadecimal commit identifier.'
  );

  const targetText = [
    url.hostname,
    target.projectId,
    target.environmentId,
    target.environmentName,
    target.apiServiceId,
    target.apiServiceName,
    target.workerServiceId,
    target.workerServiceName,
    target.postgresServiceId,
    target.postgresServiceName,
    target.redisServiceId,
    target.redisServiceName
  ].join(' ');
  requireCondition(
    !REJECTED_TARGET_PATTERN.test(targetText),
    'UNSAFE_TARGET_REJECTED',
    'The target resembles production or the Phase 2E validation target.'
  );
  requireCondition(
    PREVIEW_TARGET_PATTERN.test(targetText),
    'PREVIEW_TARGET_NOT_PROVEN',
    'At least one target identifier or hostname must explicitly identify a preview or E2E target.'
  );
  return Object.freeze(target);
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    requireCondition(
      !/(?:confirmation[-_]?token|authorization|bearer|secret)/iu.test(argument),
      'TOKEN_ARGUMENT_DENIED',
      'Credentials and confirmation tokens are accepted from no CLI argument.'
    );
    requireCondition(argument.startsWith('--'), 'INVALID_ARGUMENT', 'Only named arguments are supported.');
    const key = argument.slice(2);
    const allowed = new Set([
      'base-url',
      'mode',
      'project-id',
      'environment-id',
      'environment-name',
      'api-service-id',
      'api-service-name',
      'api-deployment-id',
      'worker-service-id',
      'worker-service-name',
      'worker-deployment-id',
      'postgres-service-id',
      'postgres-service-name',
      'redis-service-id',
      'redis-service-name',
      'commit-sha',
      'patch-file',
      'expected-test-mode',
      'poll-timeout-ms',
      'poll-interval-ms'
    ]);
    requireCondition(allowed.has(key), 'INVALID_ARGUMENT', 'An unsupported argument was supplied.');
    const value = argv[index + 1];
    requireCondition(value !== undefined && !value.startsWith('--'), 'INVALID_ARGUMENT', `Missing ${key}.`);
    values[key] = value;
    index += 1;
  }
  return {
    baseUrl: values['base-url'],
    mode: values.mode ?? 'discovery',
    projectId: values['project-id'],
    environmentId: values['environment-id'],
    environmentName: values['environment-name'],
    apiServiceId: values['api-service-id'],
    apiServiceName: values['api-service-name'],
    apiDeploymentId: values['api-deployment-id'],
    workerServiceId: values['worker-service-id'],
    workerServiceName: values['worker-service-name'],
    workerDeploymentId: values['worker-deployment-id'],
    postgresServiceId: values['postgres-service-id'],
    postgresServiceName: values['postgres-service-name'],
    redisServiceId: values['redis-service-id'],
    redisServiceName: values['redis-service-name'],
    commitSha: values['commit-sha'],
    patchFile: values['patch-file'],
    expectedTestMode: values['expected-test-mode'] ?? 'disabled',
    pollTimeoutMs: boundedInteger(
      values['poll-timeout-ms'],
      DEFAULT_POLL_TIMEOUT_MS,
      1_000,
      120_000,
      'poll-timeout-ms'
    ),
    pollIntervalMs: boundedInteger(
      values['poll-interval-ms'],
      DEFAULT_POLL_INTERVAL_MS,
      100,
      5_000,
      'poll-interval-ms'
    )
  };
}

function requireJsonObject(value, code, message) {
  requireCondition(isObject(value), code, message);
  return value;
}

function readRequiredString(record, key, code, message) {
  const value = record?.[key];
  requireCondition(
    typeof value === 'string' && value.length > 0,
    code,
    message
  );
  return value;
}

function railwayCommandIsReadOnly(args) {
  const command = args.join(' ');
  return command === 'status --json'
    || /^environment config --environment [^ ]+ --json$/u.test(command)
    || /^service status --service [^ ]+ --environment [^ ]+ --json$/u.test(command)
    || /^deployment list --service [^ ]+ --environment [^ ]+ --limit 5 --json$/u.test(command)
    || /^variable list --service [^ ]+ --environment [^ ]+ --json$/u.test(command);
}

export async function executeRailwayCliJson(args) {
  requireCondition(
    Array.isArray(args)
      && args.every((argument) => typeof argument === 'string' && !/[\r\n\0]/u.test(argument))
      && railwayCommandIsReadOnly(args),
    'UNSAFE_RAILWAY_COMMAND',
    'The preview verifier permits only its fixed read-only Railway commands.'
  );
  let stdout;
  try {
    ({ stdout } = await execFileAsync('railway', args, {
      encoding: 'utf8',
      timeout: RAILWAY_CLI_TIMEOUT_MS,
      maxBuffer: RAILWAY_CLI_MAX_OUTPUT_BYTES,
      windowsHide: true
    }));
  } catch {
    fail('RAILWAY_INSPECTION_FAILED', 'Read-only Railway inspection failed.');
  }
  requireCondition(
    Buffer.byteLength(stdout, 'utf8') <= RAILWAY_CLI_MAX_OUTPUT_BYTES,
    'RAILWAY_INSPECTION_TOO_LARGE',
    'Railway inspection exceeded the verifier output limit.'
  );
  try {
    return JSON.parse(stdout);
  } catch {
    fail('RAILWAY_INSPECTION_INVALID_JSON', 'Railway inspection did not return JSON.');
  }
}

function readEnvironmentNode(status, environmentId) {
  const edges = status?.environments?.edges;
  requireCondition(
    Array.isArray(edges),
    'RAILWAY_STATUS_INVALID',
    'Railway project status omitted environments.'
  );
  const matches = edges
    .map((edge) => edge?.node)
    .filter((node) => node?.id === environmentId);
  requireCondition(
    matches.length === 1,
    'RAILWAY_ENVIRONMENT_MISMATCH',
    'The explicit preview environment was not found exactly once in the linked project.'
  );
  return matches[0];
}

function readEnvironmentServices(environment) {
  const edges = environment?.serviceInstances?.edges;
  requireCondition(
    Array.isArray(edges),
    'RAILWAY_STATUS_INVALID',
    'Railway environment status omitted service instances.'
  );
  return edges.map((edge) => edge?.node).filter(isObject);
}

function readServiceDomainNames(service) {
  const serviceDomains = Array.isArray(service?.domains?.serviceDomains)
    ? service.domains.serviceDomains
    : [];
  const customDomains = Array.isArray(service?.domains?.customDomains)
    ? service.domains.customDomains
    : [];
  return [
    ...serviceDomains,
    ...customDomains
  ]
    .map((domain) => domain?.domain)
    .filter((domain) => typeof domain === 'string')
    .map((domain) => domain.toLowerCase());
}

function expectedServices(target) {
  return [
    {
      role: 'api',
      id: target.apiServiceId,
      name: target.apiServiceName,
      deploymentId: target.apiDeploymentId
    },
    {
      role: 'worker',
      id: target.workerServiceId,
      name: target.workerServiceName,
      deploymentId: target.workerDeploymentId
    },
    {
      role: 'postgres',
      id: target.postgresServiceId,
      name: target.postgresServiceName
    },
    {
      role: 'redis',
      id: target.redisServiceId,
      name: target.redisServiceName
    }
  ];
}

function assertExactServiceSet(services, target, readIdentity) {
  const expected = expectedServices(target);
  requireCondition(
    services.length === expected.length,
    'RAILWAY_SERVICE_SET_MISMATCH',
    'The preview environment does not contain exactly the four selected preview services.'
  );
  for (const service of expected) {
    const matches = services.filter((candidate) => {
      const identity = readIdentity(candidate);
      return identity.id === service.id && identity.name === service.name;
    });
    requireCondition(
      matches.length === 1,
      'RAILWAY_SERVICE_IDENTITY_MISMATCH',
      `The selected ${service.role} preview service identity did not match Railway.`
    );
  }
}

function requireResolvedVariables(value, role) {
  const variables = requireJsonObject(
    value,
    'RAILWAY_VARIABLES_INVALID',
    `Railway returned an invalid ${role} variable projection.`
  );
  for (const [name, variableValue] of Object.entries(variables)) {
    requireCondition(
      typeof variableValue === 'string',
      'RAILWAY_VARIABLES_INVALID',
      `Railway returned a non-string ${role} variable.`
    );
    requireCondition(
      !/[\r\n\0]/u.test(name),
      'RAILWAY_VARIABLES_INVALID',
      `Railway returned an invalid ${role} variable name.`
    );
  }
  return variables;
}

function assertVariableIdentity(variables, target, service) {
  const expected = {
    RAILWAY_PROJECT_ID: target.projectId,
    RAILWAY_ENVIRONMENT_ID: target.environmentId,
    RAILWAY_ENVIRONMENT_NAME: target.environmentName,
    RAILWAY_SERVICE_ID: service.id,
    RAILWAY_SERVICE_NAME: service.name
  };
  for (const [name, value] of Object.entries(expected)) {
    requireCondition(
      variables[name] === value,
      'RAILWAY_VARIABLE_IDENTITY_MISMATCH',
      `The resolved ${service.role} Railway identity variables do not match the preview target.`
    );
  }
}

function parseCriticalServiceUrl(value, protocols, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('RAILWAY_DEPENDENCY_URL_INVALID', `${label} is not a valid service URL.`);
  }
  requireCondition(
    protocols.includes(url.protocol) && url.hostname.length > 0,
    'RAILWAY_DEPENDENCY_URL_INVALID',
    `${label} does not use an allowed service protocol.`
  );
  const parameters = [...url.searchParams.entries()];
  const postgresUrl = protocols.includes('postgres:') || protocols.includes('postgresql:');
  requireCondition(
    !url.hash
      && (
        parameters.length === 0
        || (
          postgresUrl
          && parameters.length === 1
          && parameters[0][0] === 'sslmode'
          && parameters[0][1] === 'no-verify'
        )
      ),
    'RAILWAY_DEPENDENCY_URL_PARAMETERS_DENIED',
    `${label} contains unsupported connection parameters.`
  );
  return url;
}

function assertDependencyUrl(value, providerVariables, protocols, defaultPort, label) {
  const url = parseCriticalServiceUrl(value, protocols, label);
  const expectedHost = readRequiredString(
    providerVariables,
    'RAILWAY_PRIVATE_DOMAIN',
    'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
    `${label} provider has no Railway private domain.`
  ).toLowerCase();
  requireCondition(
    url.hostname.toLowerCase() === expectedHost,
    'RAILWAY_DEPENDENCY_IDENTITY_MISMATCH',
    `${label} does not resolve to the selected preview service.`
  );
  const expectedPort = providerVariables.PGPORT
    ?? providerVariables.REDISPORT
    ?? defaultPort;
  requireCondition(
    (url.port || defaultPort) === expectedPort,
    'RAILWAY_DEPENDENCY_IDENTITY_MISMATCH',
    `${label} does not resolve to the selected preview service port.`
  );
  return url.hostname.toLowerCase();
}

function assertPublicDependencyUrl(value, providerVariables, protocols, label) {
  const url = parseCriticalServiceUrl(value, protocols, label);
  const expectedHost = readRequiredString(
    providerVariables,
    'RAILWAY_TCP_PROXY_DOMAIN',
    'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
    `${label} provider has no Railway TCP proxy domain.`
  ).toLowerCase();
  const expectedPort = readRequiredString(
    providerVariables,
    'RAILWAY_TCP_PROXY_PORT',
    'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
    `${label} provider has no Railway TCP proxy port.`
  );
  requireCondition(
    url.hostname.toLowerCase() === expectedHost && url.port === expectedPort,
    'RAILWAY_DEPENDENCY_IDENTITY_MISMATCH',
    `${label} does not resolve to the selected preview service TCP proxy.`
  );
  return expectedHost;
}

function extractUrlHosts(value) {
  const hosts = [];
  const matches = value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu) ?? [];
  for (const candidate of matches) {
    try {
      hosts.push(new URL(candidate).hostname.toLowerCase());
    } catch {
      // Non-URL configuration text is ignored; critical dependency URLs are parsed separately.
    }
  }
  return hosts;
}

function assertNoUnsafeVariableReferences(variableSets, target, allowedRailwayHosts) {
  const serviceNames = new Set(expectedServices(target).map((service) => service.name));
  for (const variables of variableSets) {
    for (const [name, value] of Object.entries(variables)) {
      requireCondition(
        (name === 'NODE_ENV' && value.toLowerCase() === 'production')
          || !REJECTED_TARGET_PATTERN.test(value),
        'RAILWAY_UNSAFE_REFERENCE',
        'A preview variable contains a production or Phase 2E resource reference.'
      );
      const references = value.matchAll(/\$\{\{\s*([^}.]+)\.[^}]+\}\}/gu);
      for (const reference of references) {
        requireCondition(
          serviceNames.has(reference[1].trim()),
          'RAILWAY_EXTERNAL_SERVICE_REFERENCE',
          'A preview variable references a service outside the selected preview stack.'
        );
      }
      for (const host of extractUrlHosts(value)) {
        requireCondition(
          !REJECTED_TARGET_PATTERN.test(host),
          'RAILWAY_UNSAFE_REFERENCE',
          'A preview variable references a production or Phase 2E host.'
        );
        if (
          RAILWAY_HOST_PATTERN.test(host)
          || RAILWAY_PUBLIC_HOST_PATTERN.test(host)
          || RAILWAY_PROXY_HOST_PATTERN.test(host)
        ) {
          requireCondition(
            allowedRailwayHosts.has(host),
            'RAILWAY_EXTERNAL_SERVICE_REFERENCE',
            'A preview variable references a Railway host outside the selected preview stack.'
          );
        }
      }
    }
  }
}

function assertDeployment(deployments, service, commitSha) {
  requireCondition(
    Array.isArray(deployments),
    'RAILWAY_DEPLOYMENT_INVALID',
    `Railway returned invalid ${service.role} deployment metadata.`
  );
  const deployment = deployments.find((candidate) => candidate?.id === service.deploymentId);
  requireCondition(
    deployment
      && deployments[0]?.id === service.deploymentId
      && deployment.status === 'SUCCESS'
      && deployment.meta?.commitHash === commitSha,
    'RAILWAY_DEPLOYMENT_MISMATCH',
    `The selected ${service.role} deployment is not the latest successful tested commit.`
  );
  return deployment;
}

function sanitizedRailwayInspection(target, serviceStatuses, deployments, dependencyHosts) {
  const statusById = new Map(serviceStatuses.map((service) => [service.id, service]));
  return {
    projectId: target.projectId,
    environmentId: target.environmentId,
    services: {
      api: {
        id: target.apiServiceId,
        deploymentId: target.apiDeploymentId,
        status: statusById.get(target.apiServiceId)?.status
      },
      worker: {
        id: target.workerServiceId,
        deploymentId: target.workerDeploymentId,
        status: statusById.get(target.workerServiceId)?.status
      },
      postgres: {
        id: target.postgresServiceId,
        deploymentId: statusById.get(target.postgresServiceId)?.deploymentId,
        status: statusById.get(target.postgresServiceId)?.status
      },
      redis: {
        id: target.redisServiceId,
        deploymentId: statusById.get(target.redisServiceId)?.deploymentId,
        status: statusById.get(target.redisServiceId)?.status
      }
    },
    commitSha: target.commitSha,
    dependencyHostHashes: {
      database: sha256(dependencyHosts.database),
      redis: sha256(dependencyHosts.redis)
    },
    deploymentMetadataHashes: {
      api: sha256(stableJson(deployments.api.meta)),
      worker: sha256(stableJson(deployments.worker.meta))
    }
  };
}

export async function inspectRailwayPreview(target, execRailway = executeRailwayCliJson) {
  const status = await execRailway(['status', '--json']);
  requireCondition(
    status?.id === target.projectId,
    'RAILWAY_PROJECT_MISMATCH',
    'The linked Railway project does not match the explicit preview project.'
  );
  const environment = readEnvironmentNode(status, target.environmentId);
  requireCondition(
    environment.name === target.environmentName
      && environment.canAccess === true
      && environment.deletedAt === null,
    'RAILWAY_ENVIRONMENT_MISMATCH',
    'The explicit Railway environment is not the expected accessible preview environment.'
  );
  const environmentServices = readEnvironmentServices(environment);
  assertExactServiceSet(environmentServices, target, (service) => ({
    id: service.serviceId,
    name: service.serviceName
  }));
  const apiEnvironmentService = environmentServices.find(
    (service) => service.serviceId === target.apiServiceId
  );
  requireCondition(
    readServiceDomainNames(apiEnvironmentService).includes(
      new URL(target.baseUrl).hostname.toLowerCase()
    ),
    'RAILWAY_PUBLIC_DOMAIN_MISMATCH',
    'The preview base URL is not owned by the selected Railway API service.'
  );

  const environmentConfig = await execRailway([
    'environment',
    'config',
    '--environment',
    target.environmentId,
    '--json'
  ]);
  const configuredServices = Object.keys(
    requireJsonObject(
      environmentConfig?.services,
      'RAILWAY_ENVIRONMENT_CONFIG_INVALID',
      'Railway environment configuration omitted services.'
    )
  ).map((id) => ({
    id,
    name: environmentServices.find((service) => service.serviceId === id)?.serviceName
  }));
  assertExactServiceSet(configuredServices, target, (service) => service);

  const serviceStatuses = await Promise.all(
    expectedServices(target).map((service) => execRailway([
      'service',
      'status',
      '--service',
      service.id,
      '--environment',
      target.environmentId,
      '--json'
    ]))
  );
  requireCondition(
    serviceStatuses.every(isObject),
    'RAILWAY_SERVICE_STATUS_INVALID',
    'Railway returned invalid service status metadata.'
  );
  assertExactServiceSet(serviceStatuses, target, (service) => ({
    id: service.id,
    name: service.name
  }));
  for (const service of serviceStatuses) {
    requireCondition(
      service.status === 'SUCCESS' && service.stopped === false,
      'RAILWAY_SERVICE_UNHEALTHY',
      'A selected preview service is not running a successful deployment.'
    );
  }
  for (const service of expectedServices(target).filter((candidate) => candidate.deploymentId)) {
    const statusEntry = serviceStatuses.find((candidate) => candidate.id === service.id);
    requireCondition(
      statusEntry?.deploymentId === service.deploymentId,
      'RAILWAY_DEPLOYMENT_MISMATCH',
      `The ${service.role} service status does not match the explicit deployment.`
    );
  }

  const [apiDeployments, workerDeployments] = await Promise.all(
    expectedServices(target)
      .filter((service) => service.role === 'api' || service.role === 'worker')
      .map((service) => execRailway([
        'deployment',
        'list',
        '--service',
        service.id,
        '--environment',
        target.environmentId,
        '--limit',
        '5',
        '--json'
      ]))
  );
  const services = Object.fromEntries(
    expectedServices(target).map((service) => [service.role, service])
  );
  const deployments = {
    api: assertDeployment(apiDeployments, services.api, target.commitSha),
    worker: assertDeployment(workerDeployments, services.worker, target.commitSha)
  };

  const variableEntries = await Promise.all(
    expectedServices(target).map(async (service) => [
      service.role,
      requireResolvedVariables(
        await execRailway([
          'variable',
          'list',
          '--service',
          service.id,
          '--environment',
          target.environmentId,
          '--json'
        ]),
        service.role
      )
    ])
  );
  const variables = Object.fromEntries(variableEntries);
  for (const service of expectedServices(target)) {
    assertVariableIdentity(variables[service.role], target, service);
  }

  const dependencyHosts = {
    database: assertDependencyUrl(
      readRequiredString(
        variables.api,
        'DATABASE_URL',
        'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
        'The API DATABASE_URL is missing.'
      ),
      variables.postgres,
      ['postgres:', 'postgresql:'],
      '5432',
      'API DATABASE_URL'
    ),
    redis: assertDependencyUrl(
      readRequiredString(
        variables.api,
        'REDIS_URL',
        'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
        'The API REDIS_URL is missing.'
      ),
      variables.redis,
      ['redis:', 'rediss:'],
      '6379',
      'API REDIS_URL'
    )
  };
  assertDependencyUrl(
    readRequiredString(
      variables.worker,
      'DATABASE_URL',
      'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
      'The worker DATABASE_URL is missing.'
    ),
    variables.postgres,
    ['postgres:', 'postgresql:'],
    '5432',
    'worker DATABASE_URL'
  );
  assertDependencyUrl(
    readRequiredString(
      variables.worker,
      'REDIS_URL',
      'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
      'The worker REDIS_URL is missing.'
    ),
    variables.redis,
    ['redis:', 'rediss:'],
    '6379',
    'worker REDIS_URL'
  );
  const publicDependencyHosts = {
    database: assertPublicDependencyUrl(
      readRequiredString(
        variables.postgres,
        'DATABASE_PUBLIC_URL',
        'RAILWAY_DEPENDENCY_IDENTITY_MISSING',
        'The preview Postgres DATABASE_PUBLIC_URL is missing.'
      ),
      variables.postgres,
      ['postgres:', 'postgresql:'],
      'preview Postgres DATABASE_PUBLIC_URL'
    ),
    redis: variables.redis.REDIS_PUBLIC_URL
      ? assertPublicDependencyUrl(
          variables.redis.REDIS_PUBLIC_URL,
          variables.redis,
          ['redis:', 'rediss:'],
          'preview Redis REDIS_PUBLIC_URL'
        )
      : null
  };
  for (const role of ['api', 'worker']) {
    if (variables[role].DATABASE_PUBLIC_URL) {
      assertPublicDependencyUrl(
        variables[role].DATABASE_PUBLIC_URL,
        variables.postgres,
        ['postgres:', 'postgresql:'],
        `${role} DATABASE_PUBLIC_URL`
      );
    }
    if (variables[role].REDIS_PUBLIC_URL) {
      assertPublicDependencyUrl(
        variables[role].REDIS_PUBLIC_URL,
        variables.redis,
        ['redis:', 'rediss:'],
        `${role} REDIS_PUBLIC_URL`
      );
    }
  }

  const allowedRailwayHosts = new Set([
    new URL(target.baseUrl).hostname.toLowerCase(),
    ...Object.values(variables)
      .map((serviceVariables) => serviceVariables.RAILWAY_PRIVATE_DOMAIN?.toLowerCase())
      .filter(Boolean),
    ...Object.values(publicDependencyHosts).filter(Boolean),
    ...environmentServices.flatMap(readServiceDomainNames)
  ]);
  assertNoUnsafeVariableReferences(Object.values(variables), target, allowedRailwayHosts);

  const finalStatus = await execRailway(['status', '--json']);
  const finalEnvironment = readEnvironmentNode(finalStatus, target.environmentId);
  requireCondition(
    finalStatus?.id === target.projectId
      && finalEnvironment.name === target.environmentName,
    'RAILWAY_LINK_CHANGED',
    'The linked Railway target changed during preview verification.'
  );
  assertExactServiceSet(readEnvironmentServices(finalEnvironment), target, (service) => ({
    id: service.serviceId,
    name: service.serviceName
  }));
  const finalApiService = readEnvironmentServices(finalEnvironment).find(
    (service) => service.serviceId === target.apiServiceId
  );
  requireCondition(
    readServiceDomainNames(finalApiService).includes(
      new URL(target.baseUrl).hostname.toLowerCase()
    ),
    'RAILWAY_PUBLIC_DOMAIN_MISMATCH',
    'The preview domain ownership changed during verification.'
  );

  return sanitizedRailwayInspection(
    target,
    serviceStatuses,
    deployments,
    dependencyHosts
  );
}

function assertSafePath(path) {
  requireCondition(
    typeof path === 'string' && path.startsWith('/gpt-access/'),
    'UNSAFE_ROUTE_REJECTED',
    'Only /gpt-access routes are permitted.'
  );
  requireCondition(
    !/^\/gpt\/[^/]+/iu.test(path) && !path.includes('/gpt/:gptId'),
    'LEGACY_GPT_ROUTE_REJECTED',
    'The legacy GPT route is forbidden.'
  );
  requireCondition(!path.includes('..'), 'UNSAFE_ROUTE_REJECTED', 'Path traversal is forbidden.');
}

async function readBoundedJson(response) {
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail('RESPONSE_TOO_LARGE', 'The preview response exceeded the evidence runner limit.');
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('INVALID_JSON_RESPONSE', 'The preview returned invalid JSON.');
  }
}

function buildEvidence(context, details) {
  return {
    schemaVersion: 'arcanos-preview-e2e-evidence-v1',
    recordedAt: context.now().toISOString(),
    target: context.targetEvidence,
    caseId: details.caseId,
    result: details.result ?? 'passed',
    request: {
      method: details.method,
      path: details.path,
      requestId: details.requestId,
      traceId: details.traceId,
      ...(details.capability ? { capability: details.capability } : {}),
      ...(details.action ? { action: details.action } : {}),
      ...(details.payloadSha256 ? { payloadSha256: details.payloadSha256 } : {})
    },
    response: {
      httpStatus: details.httpStatus,
      ...(details.code ? { code: details.code } : {}),
      ...(details.outerOk !== undefined ? { outerOk: details.outerOk } : {}),
      ...(details.innerOk !== undefined ? { innerOk: details.innerOk } : {}),
      ...(details.jobId ? { jobId: details.jobId } : {}),
      ...(details.jobStatus ? { jobStatus: details.jobStatus } : {}),
      ...(details.jobTraceId ? { jobTraceId: details.jobTraceId } : {}),
      ...(details.eventCount !== undefined ? { eventCount: details.eventCount } : {}),
      ...(details.outcome ? { outcome: details.outcome } : {}),
      ...(details.challengeSha256 ? { confirmationChallengeSha256: details.challengeSha256 } : {}),
      ...(details.deploymentId ? { deploymentId: details.deploymentId } : {}),
      ...(details.commitSha ? { commitSha: details.commitSha } : {})
    }
  };
}

function buildTargetEvidence(target) {
  return Object.freeze({
    baseUrlSha256: sha256(target.baseUrl),
    projectId: target.projectId,
    environmentId: target.environmentId,
    apiServiceId: target.apiServiceId,
    apiDeploymentId: target.apiDeploymentId,
    workerServiceId: target.workerServiceId,
    workerDeploymentId: target.workerDeploymentId,
    postgresServiceId: target.postgresServiceId,
    redisServiceId: target.redisServiceId,
    commitSha: target.commitSha
  });
}

function emitRailwayIsolationEvidence(context) {
  const evidence = {
    schemaVersion: 'arcanos-preview-e2e-evidence-v1',
    recordedAt: context.now().toISOString(),
    target: context.targetEvidence,
    caseId: 'railway-preview-isolation',
    result: 'passed',
    response: {
      inspectionSha256: sha256(stableJson(context.railwayInspection)),
      services: context.railwayInspection.services
    }
  };
  context.emit(evidence);
  return evidence;
}

async function requestJson(context, input) {
  assertSafePath(input.path);
  const url = new URL(input.path, `${context.target.baseUrl}/`);
  requireCondition(url.origin === context.target.baseUrl, 'TARGET_ESCAPE_REJECTED', 'Request target escaped.');
  const requestId = `preview-e2e-${context.id()}-${input.caseId}`.slice(0, 120);
  const traceId = `preview-e2e-trace-${context.id()}`.slice(0, 120);
  const headers = new Headers({
    Accept: 'application/json',
    'X-Request-ID': requestId,
    'X-Trace-ID': traceId
  });
  if (input.authorized !== false) {
    headers.set('Authorization', `Bearer ${context.accessCredential}`);
  }
  if (input.idempotencyKey) {
    headers.set('Idempotency-Key', input.idempotencyKey);
  }
  let body;
  if (input.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(input.body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.requestTimeoutMs);
  let response;
  try {
    response = await context.fetchImpl(url, {
      method: input.method,
      headers,
      body,
      redirect: 'error',
      signal: controller.signal
    });
  } catch {
    fail('NETWORK_REQUEST_FAILED', 'A bounded preview request failed.');
  } finally {
    clearTimeout(timeout);
  }
  const responseBody = await readBoundedJson(response);
  return {
    response,
    body: responseBody,
    requestId,
    traceId,
    payloadSha256: input.body === undefined ? undefined : sha256(stableJson(input.body))
  };
}

function emitPass(context, request, details = {}) {
  const evidence = buildEvidence(context, {
    caseId: details.caseId,
    method: details.method,
    path: details.path,
    requestId: request.requestId,
    traceId: request.traceId,
    payloadSha256: request.payloadSha256,
    httpStatus: request.response.status,
    code: responseCode(request.body),
    ...details
  });
  context.emit(evidence);
  return evidence;
}

function assertServedDeploymentMetadata(metadata, context) {
  requireCondition(
    isObject(metadata)
      && metadata.provider === 'railway'
      && metadata.projectId === context.target.projectId
      && metadata.environmentId === context.target.environmentId
      && metadata.environmentName === context.target.environmentName
      && metadata.serviceId === context.target.apiServiceId
      && metadata.serviceName === context.target.apiServiceName
      && metadata.deploymentId === context.target.apiDeploymentId
      && metadata.gitCommitSha === context.target.commitSha
      && metadata.workerServiceId === context.target.workerServiceId
      && metadata.workerServiceName === context.target.workerServiceName
      && metadata.workerDeploymentId === context.target.workerDeploymentId
      && metadata.workerGitCommitSha === context.target.commitSha
      && metadata.deploymentId === context.railwayInspection.services.api.deploymentId
      && metadata.workerDeploymentId === context.railwayInspection.services.worker.deploymentId
      && metadata.gitCommitSha === context.railwayInspection.commitSha
      && metadata.workerGitCommitSha === context.railwayInspection.commitSha,
    'SERVED_DEPLOYMENT_MISMATCH',
    'GPT Access health does not identify the Railway-inspected preview deployment and commit.'
  );
}

async function runDiscovery(context) {
  const evidence = [];
  const openApi = await requestJson(context, {
    caseId: 'openapi',
    method: 'GET',
    path: '/gpt-access/openapi.json',
    authorized: false
  });
  requireCondition(openApi.response.status === 200, 'OPENAPI_FAILED', 'OpenAPI discovery failed.');
  requireCondition(
    isObject(openApi.body)
      && isObject(openApi.body.paths)
      && isObject(openApi.body.paths['/gpt-access/capabilities/v1/{id}/run']),
    'OPENAPI_CONTRACT_MISSING',
    'The GPT Access capability path is missing.'
  );
  const openApiCatalogs = openApi.body['x-arcanos-capability-catalogs'];
  requireCondition(
    isObject(openApiCatalogs)
      && hasExactStrings(Object.keys(openApiCatalogs), [
        PRODUCTIVITY_MODULE,
        LOCAL_AGENT_MODULE
      ])
      && isObject(openApiCatalogs[PRODUCTIVITY_MODULE])
      && isObject(openApiCatalogs[LOCAL_AGENT_MODULE]),
    'OPENAPI_CATALOG_MISSING',
    'OpenAPI does not publish the exact protected capability catalogs.'
  );
  assertExactActionCatalog(
    openApiCatalogs[PRODUCTIVITY_MODULE].actions,
    PRODUCTIVITY_ACTIONS,
    'OPENAPI_CATALOG_MISMATCH',
    'OpenAPI publishes an unexpected productivity action catalog.'
  );
  assertExactActionCatalog(
    openApiCatalogs[LOCAL_AGENT_MODULE].actions,
    LOCAL_AGENT_ACTIONS,
    'OPENAPI_CATALOG_MISMATCH',
    'OpenAPI publishes an unexpected local-agent action catalog.'
  );
  const openApiContracts = openApiCatalogs[LOCAL_AGENT_MODULE].contracts;
  requireCondition(
    Array.isArray(openApiContracts)
      && openApiContracts.length === LOCAL_AGENT_ACTIONS.length
      && openApiContracts.every((contract) => isObject(contract) && typeof contract.id === 'string'),
    'OPENAPI_CATALOG_MISMATCH',
    'OpenAPI does not publish the complete local-agent contract catalog.'
  );
  const openApiLocalAgentContracts = Object.fromEntries(
    openApiContracts.map((contract) => [contract.id, contract])
  );
  assertLocalAgentContractMetadata(openApiLocalAgentContracts);
  const servers = Array.isArray(openApi.body.servers) ? openApi.body.servers : [];
  requireCondition(
    servers.some((server) => {
      try {
        return isObject(server) && new URL(server.url).origin === context.target.baseUrl;
      } catch {
        return false;
      }
    }),
    'OPENAPI_TARGET_MISMATCH',
    'OpenAPI does not identify the expected preview origin.'
  );
  evidence.push(emitPass(context, openApi, {
    caseId: 'openapi',
    method: 'GET',
    path: '/gpt-access/openapi.json',
    outerOk: true
  }));

  const unauthorized = await requestJson(context, {
    caseId: 'unauthorized-capabilities',
    method: 'GET',
    path: '/gpt-access/capabilities/v1',
    authorized: false
  });
  requireCondition(
    unauthorized.response.status === 401
      && responseCode(unauthorized.body) === 'UNAUTHORIZED_GPT_ACCESS',
    'AUTH_FAIL_OPEN',
    'The protected capability list did not reject an unauthenticated request.'
  );
  evidence.push(emitPass(context, unauthorized, {
    caseId: 'unauthorized-capabilities',
    method: 'GET',
    path: '/gpt-access/capabilities/v1'
  }));

  const health = await requestJson(context, {
    caseId: 'gpt-access-health',
    method: 'GET',
    path: '/gpt-access/health'
  });
  requireCondition(
    health.response.status === 200
      && health.body?.ok === true
      && health.body?.status === 'healthy'
      && health.body?.startup?.phase === 'READY'
      && health.body?.startup?.ready === true
      && health.body?.dependencies?.redis?.configured === true
      && health.body?.dependencies?.redis?.ready === true
      && health.body?.dependencies?.redis?.status === 'ready'
      && health.body?.dependencies?.redis?.code === null
      && health.body?.dependencies?.redis?.retryScheduled === false,
    'GPT_ACCESS_HEALTH_FAILED',
    'GPT Access health is not fully ready with its preview Redis dependency.'
  );
  assertServedDeploymentMetadata(health.body.deployment, context);
  evidence.push(emitPass(context, health, {
    caseId: 'gpt-access-health',
    method: 'GET',
    path: '/gpt-access/health',
    outerOk: true,
    deploymentId: context.target.apiDeploymentId,
    commitSha: context.target.commitSha
  }));

  const status = await requestJson(context, {
    caseId: 'gpt-access-status',
    method: 'GET',
    path: '/gpt-access/status'
  });
  requireCondition(
    status.response.status === 200
      && status.body?.status === 'ok'
      && status.body?.startup?.phase === 'READY'
      && status.body?.startup?.ready === true
      && status.body?.startup?.listener_bound === true
      && status.body?.startup?.runtime_initialized === true
      && status.body?.startup?.shutting_down === false
      && status.body?.dependencies?.redis?.configured === true
      && status.body?.dependencies?.redis?.ready === true
      && status.body?.dependencies?.redis?.status === 'ready'
      && status.body?.dependencies?.redis?.code === null
      && status.body?.dependencies?.redis?.retry_scheduled === false,
    'GPT_ACCESS_STATUS_FAILED',
    'GPT Access runtime status is not fully initialized and ready.'
  );
  evidence.push(emitPass(context, status, {
    caseId: 'gpt-access-status',
    method: 'GET',
    path: '/gpt-access/status'
  }));

  const deniedScope = await requestJson(context, {
    caseId: 'scope-denied-workers',
    method: 'GET',
    path: '/gpt-access/workers/status'
  });
  requireCondition(
    deniedScope.response.status === 403
      && responseCode(deniedScope.body) === 'GPT_ACCESS_SCOPE_DENIED',
    'SCOPE_FAIL_OPEN',
    'A deliberately unconfigured GPT Access scope did not fail closed.'
  );
  evidence.push(emitPass(context, deniedScope, {
    caseId: 'scope-denied-workers',
    method: 'GET',
    path: '/gpt-access/workers/status'
  }));

  const list = await requestJson(context, {
    caseId: 'capability-list',
    method: 'GET',
    path: '/gpt-access/capabilities/v1'
  });
  requireCondition(list.response.status === 200 && list.body?.ok === true, 'DISCOVERY_FAILED', 'Capability discovery failed.');
  const capabilities = Array.isArray(list.body.capabilities) ? list.body.capabilities : [];
  for (const [id, expectedActions] of [
    [PRODUCTIVITY_MODULE, PRODUCTIVITY_ACTIONS],
    [LOCAL_AGENT_MODULE, LOCAL_AGENT_ACTIONS]
  ]) {
    const capability = capabilities.find((candidate) => candidate?.id === id);
    requireCondition(
      capability && hasExactStrings(capability.actions, expectedActions),
      'CAPABILITY_CATALOG_MISMATCH',
      'The preview capability catalog does not match the expected protected modules.'
    );
  }
  evidence.push(emitPass(context, list, {
    caseId: 'capability-list',
    method: 'GET',
    path: '/gpt-access/capabilities/v1',
    outerOk: true
  }));

  for (const id of [PRODUCTIVITY_MODULE, LOCAL_AGENT_MODULE]) {
    const path = `/gpt-access/capabilities/v1/${encodeURIComponent(id)}`;
    const detail = await requestJson(context, {
      caseId: `capability-detail-${id.toLowerCase().replace(/[^a-z]+/gu, '-')}`,
      method: 'GET',
      path
    });
    requireCondition(
      detail.response.status === 200
        && detail.body?.ok === true
        && detail.body?.exists === true
        && detail.body?.capability?.id === id
        && hasExactStrings(
          detail.body?.capability?.actions,
          id === PRODUCTIVITY_MODULE ? PRODUCTIVITY_ACTIONS : LOCAL_AGENT_ACTIONS
        ),
      'CAPABILITY_DETAIL_MISMATCH',
      'Capability detail did not match discovery.'
    );
    if (id === LOCAL_AGENT_MODULE) {
      assertLocalAgentContractMetadata(
        detail.body.capability.actionMetadata,
        openApiLocalAgentContracts
      );
    }
    evidence.push(emitPass(context, detail, {
      caseId: `capability-detail-${id.toLowerCase().replace(/[^a-z]+/gu, '-')}`,
      method: 'GET',
      path,
      capability: id,
      outerOk: true
    }));
  }

  const invalidCapabilityPath = '/gpt-access/capabilities/v1/__preview_e2e_missing__';
  const invalidCapability = await requestJson(context, {
    caseId: 'invalid-capability',
    method: 'GET',
    path: invalidCapabilityPath
  });
  requireCondition(
    invalidCapability.response.status === 200
      && invalidCapability.body?.ok === true
      && invalidCapability.body?.exists === false
      && invalidCapability.body?.capability === null,
    'INVALID_CAPABILITY_FAIL_OPEN',
    'An unknown capability did not return the bounded not-found contract.'
  );
  evidence.push(emitPass(context, invalidCapability, {
    caseId: 'invalid-capability',
    method: 'GET',
    path: invalidCapabilityPath,
    outerOk: true
  }));

  return evidence;
}

async function runProductivityReads(context) {
  const evidence = [];
  const path = `/gpt-access/capabilities/v1/${encodeURIComponent(PRODUCTIVITY_MODULE)}/run`;
  for (const [action, payload] of PRODUCTIVITY_READ_ACTIONS) {
    const request = await requestJson(context, {
      caseId: `productivity-${action}`,
      method: 'POST',
      path,
      body: { action, payload }
    });
    requireCondition(
      request.response.status === 200
        && request.body?.ok === true
        && request.body?.result?.ok === true
        && request.body?.result?.action === action
        && request.body?.result?.persisted === false,
      'PRODUCTIVITY_READ_FAILED',
      'A read-only productivity action failed its protocol invariant.'
    );
    evidence.push(emitPass(context, request, {
      caseId: `productivity-${action}`,
      method: 'POST',
      path,
      capability: PRODUCTIVITY_MODULE,
      action,
      outerOk: true,
      innerOk: true
    }));
  }
  return evidence;
}

async function pollLocalAgentJob(context, action, jobId, traceId) {
  const deadline = Date.now() + context.pollTimeoutMs;
  while (Date.now() < deadline) {
    const request = await requestJson(context, {
      caseId: `local-agent-poll-${action}`,
      method: 'POST',
      path: '/gpt-access/jobs/result',
      body: { jobId, traceId }
    });
    requireCondition(
      request.response.status === 200 && request.body?.ok === true,
      'LOCAL_AGENT_POLL_FAILED',
      'Local-agent result polling failed.'
    );
    if (request.body.status === 'completed') {
      requireCondition(
        request.body.result?.outcome === 'succeeded',
        'LOCAL_AGENT_JOB_FAILED',
        'The local-agent job did not succeed.'
      );
      return request;
    }
    requireCondition(
      request.body.status === 'pending',
      'LOCAL_AGENT_JOB_TERMINAL',
      'The local-agent job reached an unexpected terminal state.'
    );
    await context.sleep(context.pollIntervalMs);
  }
  fail('LOCAL_AGENT_POLL_TIMEOUT', 'Local-agent result polling reached its bounded deadline.');
}

function containsUnsafeTimelineField(value) {
  if (Array.isArray(value)) {
    return value.some(containsUnsafeTimelineField);
  }
  if (!isObject(value)) {
    return false;
  }
  const deniedKeys = new Set([
    'confirmationtoken',
    'idempotencykey',
    'input',
    'output',
    'patch',
    'payload',
    'secret',
    'token'
  ]);
  return Object.entries(value).some(([key, entry]) => (
    deniedKeys.has(key.replaceAll('_', '').toLowerCase())
      || containsUnsafeTimelineField(entry)
  ));
}

async function verifyLocalAgentJobTimeline(
  context,
  action,
  jobId,
  jobTraceId,
  caseId
) {
  const request = await requestJson(context, {
    caseId: `${caseId}-timeline`,
    method: 'POST',
    path: '/gpt-access/jobs/timeline',
    body: { job_id: jobId, limit: 100 }
  });
  const events = Array.isArray(request.body?.events) ? request.body.events : [];
  requireCondition(
    request.response.status === 200
      && request.body?.ok === true
      && request.body?.count === events.length
      && events.length >= 3
      && request.body?.summary?.eventCount === events.length
      && request.body?.summary?.terminalState === 'completed'
      && hasExactStrings(request.body?.summary?.traceIds, [jobTraceId])
      && events.every((event) => (
        event?.jobId === jobId
        && event?.traceId === jobTraceId
        && event?.metadata?.action === action
        && typeof event?.metadata?.principal === 'string'
        && event.metadata.principal.length > 0
        && typeof event?.metadata?.workspace === 'string'
        && event.metadata.workspace.length > 0
        && typeof event?.metadata?.deviceId === 'string'
        && event.metadata.deviceId.length > 0
        && typeof event?.metadata?.requestId === 'string'
        && event.metadata.requestId.length > 0
        && event?.metadata?.authorizationDecision === 'allow'
        && !containsUnsafeTimelineField(event.metadata)
      )),
    'LOCAL_AGENT_TIMELINE_MISMATCH',
    'The local-agent lifecycle timeline did not preserve safe job, trace, action, and authority correlation.'
  );
  return emitPass(context, request, {
    caseId: `${caseId}-timeline`,
    method: 'POST',
    path: '/gpt-access/jobs/timeline',
    capability: LOCAL_AGENT_MODULE,
    action,
    outerOk: true,
    jobId,
    jobStatus: 'completed',
    jobTraceId,
    eventCount: events.length
  });
}

async function submitLocalAgentAction(
  context,
  action,
  payload,
  { idempotencyKey, caseId = `local-agent-${action}` } = {}
) {
  const path = `/gpt-access/capabilities/v1/${encodeURIComponent(LOCAL_AGENT_MODULE)}/run`;
  const submitted = await requestJson(context, {
    caseId,
    method: 'POST',
    path,
    body: { action, payload },
    idempotencyKey
  });
  const accepted = submitted.body?.result;
  requireCondition(
    submitted.response.status === 200
      && submitted.body?.ok === true
      && accepted?.ok === true
      && accepted?.accepted === true
      && accepted?.action === action
      && typeof accepted?.jobId === 'string'
      && accepted?.traceId === submitted.traceId
      && accepted?.requestId === submitted.requestId,
    'LOCAL_AGENT_SUBMISSION_FAILED',
    'The read-only local-agent job was not accepted with request and trace correlation.'
  );
  emitPass(context, submitted, {
    caseId,
    method: 'POST',
    path,
    capability: LOCAL_AGENT_MODULE,
    action,
    outerOk: true,
    innerOk: true,
    jobId: accepted.jobId,
    jobStatus: accepted.status
  });
  return { accepted, path, submitted };
}

async function runLocalAgentAction(
  context,
  action,
  payload,
  { caseId = `local-agent-${action}` } = {}
) {
  const { accepted } = await submitLocalAgentAction(
    context,
    action,
    payload,
    { caseId }
  );
  const completed = await pollLocalAgentJob(context, action, accepted.jobId, accepted.traceId);
  const evidence = emitPass(context, completed, {
    caseId: `${caseId}-result`,
    method: 'POST',
    path: '/gpt-access/jobs/result',
    capability: LOCAL_AGENT_MODULE,
    action,
    outerOk: true,
    jobId: accepted.jobId,
    jobStatus: completed.body.status,
    outcome: completed.body.result.outcome
  });
  await verifyLocalAgentJobTimeline(
    context,
    action,
    accepted.jobId,
    accepted.traceId,
    caseId
  );
  return {
    accepted,
    completed,
    evidence,
    output: completed.body.result.output
  };
}

async function runLocalAgentIdempotencyChecks(context) {
  const replayKey = `preview-e2e-replay-${context.id()}`;
  const first = await submitLocalAgentAction(
    context,
    'git.status',
    {},
    { idempotencyKey: replayKey, caseId: 'local-agent-idempotency-first' }
  );
  const replay = await submitLocalAgentAction(
    context,
    'git.status',
    {},
    { idempotencyKey: replayKey, caseId: 'local-agent-idempotency-replay' }
  );
  requireCondition(
    replay.accepted.jobId === first.accepted.jobId
      && replay.accepted.deduped === true,
    'LOCAL_AGENT_IDEMPOTENCY_REPLAY_FAILED',
    'Identical local-agent submissions did not reuse the original job.'
  );
  await pollLocalAgentJob(
    context,
    'git.status',
    first.accepted.jobId,
    first.accepted.traceId
  );
  await verifyLocalAgentJobTimeline(
    context,
    'git.status',
    first.accepted.jobId,
    first.accepted.traceId,
    'local-agent-idempotency-replay'
  );

  const conflictKey = `preview-e2e-conflict-${context.id()}`;
  const conflictFirst = await submitLocalAgentAction(
    context,
    'repo.search',
    { query: context.searchQuery, options: { limit: 1 } },
    { idempotencyKey: conflictKey, caseId: 'local-agent-idempotency-conflict-first' }
  );
  await pollLocalAgentJob(
    context,
    'repo.search',
    conflictFirst.accepted.jobId,
    conflictFirst.accepted.traceId
  );
  await verifyLocalAgentJobTimeline(
    context,
    'repo.search',
    conflictFirst.accepted.jobId,
    conflictFirst.accepted.traceId,
    'local-agent-idempotency-conflict-first'
  );
  const conflictQuery = `${context.searchQuery}_changed`.slice(0, 256);
  const conflict = await requestJson(context, {
    caseId: 'local-agent-idempotency-conflict',
    method: 'POST',
    path: `/gpt-access/capabilities/v1/${encodeURIComponent(LOCAL_AGENT_MODULE)}/run`,
    body: {
      action: 'repo.search',
      payload: { query: conflictQuery, options: { limit: 1 } }
    },
    idempotencyKey: conflictKey
  });
  requireCondition(
    conflict.response.status === 200
      && conflict.body?.ok === true
      && conflict.body?.result?.ok === false
      && conflict.body?.result?.error?.code === 'LOCAL_AGENT_IDEMPOTENCY_CONFLICT'
      && !conflict.body?.result?.jobId,
    'LOCAL_AGENT_IDEMPOTENCY_CONFLICT_FAILED',
    'A changed local-agent payload reused an existing idempotency key.'
  );
  return emitPass(context, conflict, {
    caseId: 'local-agent-idempotency-conflict',
    method: 'POST',
    path: `/gpt-access/capabilities/v1/${encodeURIComponent(LOCAL_AGENT_MODULE)}/run`,
    capability: LOCAL_AGENT_MODULE,
    action: 'repo.search',
    outerOk: true,
    innerOk: false
  });
}

async function runLocalAgentReads(context) {
  const evidence = [];
  const status = await runLocalAgentAction(context, 'local_agent.status', {});
  requireCondition(
    isObject(status.output)
      && status.output.status === 'ready'
      && hasExactStrings(status.output.capabilities, LOCAL_AGENT_ACTIONS)
      && status.output.workspaceRegistered === true
      && status.output.testExecutionMode === context.expectedTestMode
      && (
        context.expectedTestMode === 'sandboxed'
          ? (
              status.output.testSandboxAvailable === true
              && ['docker', 'podman'].includes(status.output.testSandboxRuntime)
            )
          : (
              status.output.testSandboxAvailable === false
              && status.output.testSandboxRuntime === null
            )
      ),
    'LOCAL_AGENT_STATUS_MISMATCH',
    'The local agent is not ready with the registered workspace and expected test execution mode.'
  );
  evidence.push(status.evidence);

  const search = await runLocalAgentAction(context, 'repo.search', {
    query: context.searchQuery,
    options: { limit: 10 }
  });
  evidence.push(search.evidence);

  const statusBeforePreview = await runLocalAgentAction(
    context,
    'git.status',
    {},
    { caseId: 'local-agent-git-status-before-patch-preview' }
  );
  evidence.push(statusBeforePreview.evidence);

  const diff = await runLocalAgentAction(context, 'git.diff', {
    base: 'HEAD',
    head: 'HEAD',
    contextLines: 3,
    maxBytes: 32_768
  });
  evidence.push(diff.evidence);

  const preview = await runLocalAgentAction(context, 'patch.preview', {
    patch: context.patchText
  });
  requireCondition(
    isObject(preview.output)
      && preview.output.patchSha256 === sha256(context.patchText)
      && Array.isArray(preview.output.files)
      && preview.output.files.length > 0
      && preview.output.applicable === true
      && preview.output.check?.exitCode === 0
      && preview.output.check?.truncated === false,
    'PATCH_PREVIEW_FAILED',
    'The required patch fixture was not reported as safely applicable.'
  );
  evidence.push(preview.evidence);

  const statusAfterPreview = await runLocalAgentAction(
    context,
    'git.status',
    {},
    { caseId: 'local-agent-git-status-after-patch-preview' }
  );
  requireCondition(
    stableJson(statusAfterPreview.output) === stableJson(statusBeforePreview.output),
    'PATCH_PREVIEW_MUTATED_WORKSPACE',
    'Git status changed while exercising the read-only patch preview.'
  );
  evidence.push(statusAfterPreview.evidence);

  evidence.push(await runLocalAgentIdempotencyChecks(context));
  return evidence;
}

async function runConfirmationChallenge(context) {
  requireCondition(
    typeof context.patchText === 'string' && context.patchText.length > 0,
    'PATCH_FIXTURE_REQUIRED',
    'Confirmation-challenge mode requires a non-empty patch fixture file.'
  );
  const path = `/gpt-access/capabilities/v1/${encodeURIComponent(LOCAL_AGENT_MODULE)}/run`;
  const request = await requestJson(context, {
    caseId: 'patch-apply-confirmation-challenge',
    method: 'POST',
    path,
    body: {
      action: 'patch.apply',
      payload: {
        patch: context.patchText,
        expectedPatchSha256: sha256(context.patchText)
      }
    }
  });
  const challengeId = request.body?.confirmationChallenge?.id;
  requireCondition(
    request.response.status === 403
      && responseCode(request.body) === 'CONFIRMATION_REQUIRED'
      && typeof challengeId === 'string'
      && challengeId.length > 0
      && !request.body?.jobId
      && !request.body?.result?.jobId,
    'CONFIRMATION_FAIL_OPEN',
    'patch.apply did not stop at the confirmation challenge.'
  );
  return [emitPass(context, request, {
    caseId: 'patch-apply-confirmation-challenge',
    method: 'POST',
    path,
    capability: LOCAL_AGENT_MODULE,
    action: 'patch.apply',
    challengeSha256: sha256(challengeId)
  })];
}

export async function runPreviewE2E(input, dependencies = {}) {
  requireCondition(MODES.has(input.mode), 'INVALID_MODE', 'Unsupported preview E2E mode.');
  const expectedTestMode = input.expectedTestMode ?? 'disabled';
  requireCondition(
    TEST_EXECUTION_MODES.has(expectedTestMode),
    'INVALID_TEST_EXECUTION_MODE',
    'The expected local-agent test execution mode is invalid.'
  );
  requireCondition(
    input.mode !== 'readonly'
      || (typeof input.patchText === 'string' && input.patchText.length > 0),
    'PATCH_FIXTURE_REQUIRED',
    'Read-only mode requires a non-empty patch fixture for patch.preview.'
  );
  const target = validatePreviewTarget(input);
  const accessCredential = input.accessCredential;
  requireCondition(
    typeof accessCredential === 'string'
      && accessCredential.length >= 16
      && !/[\r\n]/u.test(accessCredential),
    'PREVIEW_TOKEN_REQUIRED',
    `A preview-only bearer is required through ${TOKEN_ENV}.`
  );
  const pollTimeoutMs = boundedInteger(
    input.pollTimeoutMs,
    DEFAULT_POLL_TIMEOUT_MS,
    1_000,
    120_000,
    'poll-timeout-ms'
  );
  const pollIntervalMs = boundedInteger(
    input.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    100,
    5_000,
    'poll-interval-ms'
  );
  requireCondition(
    input.patchText === undefined
      || (
        typeof input.patchText === 'string'
        && Buffer.byteLength(input.patchText, 'utf8') <= MAX_PATCH_BYTES
      ),
    'PATCH_FIXTURE_TOO_LARGE',
    'The patch fixture exceeds the preview runner limit.'
  );
  requireCondition(
    input.searchQuery === undefined
      || (
        typeof input.searchQuery === 'string'
        && input.searchQuery.length > 0
        && input.searchQuery.length <= 256
        && !/[\r\n\0]/u.test(input.searchQuery)
      ),
    'INVALID_SEARCH_QUERY',
    'The repository search fixture is invalid.'
  );
  const railwayInspection = await inspectRailwayPreview(
    target,
    dependencies.execRailway ?? executeRailwayCliJson
  );
  const emitted = [];
  const context = {
    target,
    targetEvidence: buildTargetEvidence(target),
    railwayInspection,
    accessCredential,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    emit: dependencies.emit ?? ((record) => console.log(JSON.stringify(record))),
    now: dependencies.now ?? (() => new Date()),
    id: dependencies.id ?? (() => randomUUID().replaceAll('-', '').slice(0, 12)),
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    requestTimeoutMs: pollTimeoutMs,
    pollTimeoutMs,
    pollIntervalMs,
    searchQuery: input.searchQuery ?? 'LOCAL_AGENT_E2E_MARKER',
    patchText: input.patchText,
    expectedTestMode
  };
  const originalEmit = context.emit;
  context.emit = (record) => {
    emitted.push(record);
    originalEmit(record);
  };

  emitRailwayIsolationEvidence(context);
  emitted.push(...(await runDiscovery(context)).filter((record) => !emitted.includes(record)));
  if (input.mode === 'readonly') {
    emitted.push(...(await runProductivityReads(context)).filter((record) => !emitted.includes(record)));
    emitted.push(...(await runLocalAgentReads(context)).filter((record) => !emitted.includes(record)));
  } else if (input.mode === 'confirmation-challenge') {
    emitted.push(...(await runConfirmationChallenge(context)).filter((record) => !emitted.includes(record)));
  }
  return emitted;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const patchText = args.patchFile
      ? await readFile(args.patchFile, { encoding: 'utf8' })
      : undefined;
    await runPreviewE2E({
      ...args,
      accessCredential: process.env[TOKEN_ENV],
      searchQuery: process.env[SEARCH_ENV],
      patchText
    });
  } catch (error) {
    const safeError = error instanceof PreviewE2EError
      ? error
      : new PreviewE2EError('PREVIEW_E2E_FAILED', 'The preview E2E runner failed safely.');
    console.error(JSON.stringify({
      schemaVersion: 'arcanos-preview-e2e-evidence-v1',
      result: 'failed',
      error: {
        code: safeError.code,
        message: safeError.message
      }
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
