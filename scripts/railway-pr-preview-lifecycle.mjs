#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const GITHUB_OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/iu;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const GITHUB_HEAD_REF_PREFIX = 'refs/heads/';
const GITHUB_REF_LIMIT_BYTES = 255;
const GIT_REF_FORBIDDEN_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const GITHUB_API_URL = 'https://api.github.com';
const API_TIMEOUT_MS = 10_000;
const API_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const GITHUB_RESPONSE_LIMIT_BYTES = 512 * 1024;
const READINESS_RESPONSE_LIMIT_BYTES = 64 * 1024;
const DEPLOYMENT_POLL_INTERVAL_MS = 10_000;
const DEPLOYMENT_POLL_ATTEMPTS = 270;
const PROJECTION_POLL_INTERVAL_MS = 5_000;
const PROJECTION_POLL_ATTEMPTS = 24;
const READINESS_POLL_INTERVAL_MS = 2_000;
const READINESS_POLL_ATTEMPTS = 15;
const DELETE_POLL_INTERVAL_MS = 5_000;
const DELETE_POLL_ATTEMPTS = 12;
const TRIGGER_QUIESCENCE_INTERVAL_MS = 2_000;
const PREVIEW_REGION = 'us-east4-eqdc4a';

const services = Object.freeze({
  worker: Object.freeze({
    baseInstanceId: '40b099b2-e883-4fd1-969b-17a5bf5706e5',
    id: '1765befb-b805-4051-9af9-28634e986886',
    name: 'ARCANOS Worker',
    role: 'worker',
  }),
  web: Object.freeze({
    baseInstanceId: '83a7bff0-b5a7-45b0-bdec-277da4d0a2c2',
    id: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
    name: 'ARCANOS V2',
    role: 'web',
  }),
});

export const RAILWAY_PR_PREVIEW_CONTRACT = Object.freeze({
  repository: 'pbjustin/Arcanos',
  baseBranch: 'main',
  optInLabel: 'railway-preview',
  statusContext: 'Railway PR Preview E2E',
  workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039',
  projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  baseEnvironmentId: '8d5594c5-075e-4ad5-8fad-9e6e0866032d',
  baseEnvironmentName: 'pr-preview-base-20260812',
  baseSourceEnvironmentId: '4800907a-2c12-4739-b384-4f3ac06a9620',
  productionEnvironmentId: 'fb583147-6c39-4343-9267-500f357d25ab',
  environmentPrefix: 'pr-676861-',
  serviceGroupId: '6f8cef49-8ec0-4e31-8205-c93c266ba439',
  baseStartCommand:
    'node scripts/start-railway-service-with-integrity.mjs --pr-preview-safe',
  previewStartCommand:
    'node scripts/start-railway-service-with-integrity.mjs --pr-preview-app-safe-v1',
  buildCommand: 'npm ci --include=dev --no-audit --no-fund && npm run build',
  services,
});

const CONTRACT = RAILWAY_PR_PREVIEW_CONTRACT;
const ENVIRONMENT_PREFIX_PATTERN = escapeRegex(CONTRACT.environmentPrefix);
const PROTECTED_ENVIRONMENT_IDS = new Set([
  CONTRACT.baseEnvironmentId,
  CONTRACT.productionEnvironmentId,
]);
const SERVICE_IDS = new Set(Object.values(CONTRACT.services).map(({ id }) => id));
const PENDING_DEPLOYMENT_STATUSES = new Set([
  'INITIALIZING',
  'QUEUED',
  'BUILDING',
  'DEPLOYING',
  'WAITING',
  'NEEDS_APPROVAL',
]);
const FAILED_DEPLOYMENT_STATUSES = new Set([
  'FAILED',
  'CRASHED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
]);
const EXPECTED_PROPERTY_MAPPINGS = Object.freeze({
  'build.buildCommand': '$.build.buildCommand',
  'build.builder': '$.build.builder',
  'build.cache': '$.build.cache',
  'build.env': '$.build.env',
  'deploy.startCommand': '$.environments.pr.deploy.startCommand',
  'deploy.healthcheckPath': '$.environments.pr.deploy.healthcheckPath',
  'deploy.healthcheckTimeout': '$.environments.pr.deploy.healthcheckTimeout',
  'deploy.restartPolicyType': '$.environments.pr.deploy.restartPolicyType',
  'deploy.restartPolicyMaxRetries': '$.environments.pr.deploy.restartPolicyMaxRetries',
  'deploy.preDeployCommand': '$.environments.pr.deploy.preDeployCommand',
  'deploy.cronSchedule': '$.environments.pr.deploy.cronSchedule',
  'deploy.drainingSeconds': '$.deploy.drainingSeconds',
  'deploy.env': '$.deploy.env',
});

const TOKEN_TYPE_QUERY = `
  query PreviewLifecycleTokenType {
    me {
      id
    }
  }
`;

const AUTHORITY_QUERY = `
  query PreviewLifecycleAuthority($projectId: String!) {
    apiToken {
      workspaces {
        id
      }
    }
    project(id: $projectId) {
      id
      workspaceId
      baseEnvironmentId
      primaryEnvironmentId
      prDeploys
      botPrEnvironments
      focusedPrEnvironments
    }
  }
`;

const ENVIRONMENTS_QUERY = `
  query PreviewLifecycleEnvironments($projectId: String!, $after: String) {
    environments(projectId: $projectId, first: 100, after: $after) {
      edges {
        cursor
        node {
          id
          name
          projectId
          isEphemeral
          deletedAt
          sourceEnvironment {
            id
          }
          meta {
            prNumber
            prRepo
            branch
            baseBranch
          }
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

const ENVIRONMENT_QUERY = `
  query PreviewLifecycleEnvironment($projectId: String!, $environmentId: String!) {
    environment(id: $environmentId, projectId: $projectId) {
      id
      name
      projectId
      isEphemeral
      deletedAt
      sourceEnvironment {
        id
      }
      meta {
        prNumber
        prRepo
        branch
        baseBranch
      }
      config(decryptVariables: true)
      deploymentTriggers(first: 100) {
        edges {
          node {
            id
            projectId
            environmentId
            serviceId
            repository
            branch
            provider
            checkSuites
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
      serviceInstances(first: 100) {
        edges {
          node {
            id
            serviceId
            serviceName
            environmentId
            deletedAt
            source {
              repo
              image
            }
            railwayConfigFile
            rootDirectory
            dockerfilePath
            startCommand
            healthcheckPath
            healthcheckTimeout
            drainingSeconds
            restartPolicyType
            restartPolicyMaxRetries
            latestDeployment {
              id
              projectId
              environmentId
              serviceId
              status
              deploymentStopped
              meta
            }
            activeDeployments {
              id
              projectId
              environmentId
              serviceId
              status
              deploymentStopped
              meta
            }
            domains {
              serviceDomains {
                id
                domain
                environmentId
                serviceId
                deletedAt
                syncStatus
              }
              customDomains {
                id
                domain
                environmentId
                serviceId
                deletedAt
                isRailwayDomain
              }
            }
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
      volumeInstances(first: 100) {
        edges {
          node {
            id
            environmentId
            serviceId
            volumeId
            mountPath
            deletedAt
            state
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
`;

const CREATE_ENVIRONMENT_MUTATION = `
  mutation CreatePreviewLifecycleEnvironment($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) {
      id
      name
      projectId
      isEphemeral
      sourceEnvironment {
        id
      }
    }
  }
`;

const DELETE_TRIGGER_MUTATION = `
  mutation DeletePreviewLifecycleTrigger($id: String!) {
    deploymentTriggerDelete(id: $id)
  }
`;

const DEPLOY_SERVICE_MUTATION = `
  mutation DeployPreviewLifecycleService(
    $environmentId: String!
    $serviceId: String!
    $commitSha: String!
  ) {
    serviceInstanceDeployV2(
      environmentId: $environmentId
      serviceId: $serviceId
      commitSha: $commitSha
    )
  }
`;

const DEPLOYMENT_QUERY = `
  query PreviewLifecycleDeployment($id: String!) {
    deployment(id: $id) {
      id
      projectId
      environmentId
      serviceId
      status
      deploymentStopped
      createdAt
      statusUpdatedAt
      meta
    }
  }
`;

const DELETE_ENVIRONMENT_MUTATION = `
  mutation DeletePreviewLifecycleEnvironment($id: String!) {
    environmentDelete(id: $id)
  }
`;

export class RailwayPrPreviewLifecycleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RailwayPrPreviewLifecycleError';
    this.code = code;
  }
}

function fail(code) {
  throw new RailwayPrPreviewLifecycleError(code);
}

function requireCondition(condition, code) {
  if (!condition) {
    fail(code);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasExactPreviewRegionConfig(value) {
  return hasExactKeys(value, [PREVIEW_REGION])
    && hasExactKeys(value[PREVIEW_REGION], ['numReplicas'])
    && value[PREVIEW_REGION].numReplicas === 1;
}

function isValidGitHubHeadRef(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (
    Buffer.byteLength(`${GITHUB_HEAD_REF_PREFIX}${value}`, 'utf8') > GITHUB_REF_LIMIT_BYTES
    || value.startsWith('refs/')
    || GITHUB_OBJECT_ID_PATTERN.test(value)
    || value.includes('..')
    || value.includes('@{')
    || value.endsWith('.')
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 0x20
      || codePoint === 0x7f
      || GIT_REF_FORBIDDEN_CHARACTERS.has(character)
    ) {
      return false;
    }
  }
  return value.split('/').every(component =>
    component.length > 0
    && !component.startsWith('.')
    && !component.endsWith('.lock'));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireUuid(value, code) {
  requireCondition(isUuid(value), code);
  return value;
}

function requireCommit(value, code) {
  requireCondition(typeof value === 'string' && COMMIT_PATTERN.test(value), code);
  return value;
}

function readConnection(connection, code) {
  requireCondition(
    isRecord(connection)
      && Array.isArray(connection.edges)
      && isRecord(connection.pageInfo)
      && connection.pageInfo.hasNextPage === false,
    code
  );
  const nodes = connection.edges.map((edge) => edge?.node);
  requireCondition(nodes.every(isRecord), code);
  return nodes;
}

function readLabels(rawLabels) {
  requireCondition(Array.isArray(rawLabels), 'RAILWAY_PR_PREVIEW_GITHUB_PR_INVALID');
  const labels = rawLabels.map((label) =>
    typeof label === 'string' ? label : label?.name);
  requireCondition(
    labels.every((label) =>
      typeof label === 'string'
      && label.length > 0
      && label.length <= 100
      && label.trim() === label),
    'RAILWAY_PR_PREVIEW_GITHUB_PR_INVALID'
  );
  return [...new Set(labels)];
}

export function validateLifecyclePullRequest(rawPullRequest, expectedPrNumber) {
  requireCondition(
    Number.isSafeInteger(expectedPrNumber) && expectedPrNumber > 0,
    'RAILWAY_PR_PREVIEW_PR_NUMBER_INVALID'
  );
  requireCondition(
    isRecord(rawPullRequest)
      && rawPullRequest.number === expectedPrNumber
      && (rawPullRequest.state === 'open' || rawPullRequest.state === 'closed')
      && typeof rawPullRequest.draft === 'boolean'
      && typeof rawPullRequest.base?.ref === 'string'
      && isValidGitHubHeadRef(rawPullRequest.base.ref)
      && rawPullRequest.base?.repo?.full_name === CONTRACT.repository
      && rawPullRequest.head?.repo?.full_name === CONTRACT.repository
      && typeof rawPullRequest.head?.ref === 'string'
      && isValidGitHubHeadRef(rawPullRequest.head.ref)
      && typeof rawPullRequest.head?.sha === 'string'
      && COMMIT_PATTERN.test(rawPullRequest.head.sha.toLowerCase()),
    'RAILWAY_PR_PREVIEW_GITHUB_PR_INVALID'
  );
  return Object.freeze({
    number: expectedPrNumber,
    state: rawPullRequest.state,
    draft: rawPullRequest.draft,
    baseRef: rawPullRequest.base.ref,
    headRef: rawPullRequest.head.ref,
    headSha: rawPullRequest.head.sha.toLowerCase(),
    repository: rawPullRequest.head.repo.full_name,
    labels: Object.freeze(readLabels(rawPullRequest.labels)),
  });
}

export function decideLifecycleAction({
  eventAction,
  eventLabelName = '',
  pullRequest,
}) {
  requireCondition(isRecord(pullRequest), 'RAILWAY_PR_PREVIEW_GITHUB_PR_INVALID');
  const optedIn = pullRequest.labels.includes(CONTRACT.optInLabel);
  const eligible = pullRequest.state === 'open'
    && !pullRequest.draft
    && pullRequest.baseRef === CONTRACT.baseBranch
    && optedIn;

  requireCondition([
    'manual',
    'closed',
    'converted_to_draft',
    'edited',
    'unlabeled',
    'labeled',
    'opened',
    'reopened',
    'ready_for_review',
    'synchronize',
  ].includes(eventAction), 'RAILWAY_PR_PREVIEW_EVENT_ACTION_INVALID');
  if (eligible) {
    return 'reconcile';
  }
  const canOwnAControllerPreview = eventAction === 'closed'
    || eventAction === 'converted_to_draft'
    || eventAction === 'manual'
    || (eventAction === 'edited' && pullRequest.baseRef !== CONTRACT.baseBranch)
    || (eventAction === 'unlabeled' && eventLabelName === CONTRACT.optInLabel);
  return canOwnAControllerPreview ? 'cleanup' : 'noop';
}

export function validateLifecycleAuthority(authority, {
  requireNativeDisabled = false,
} = {}) {
  const workspaces = authority?.apiToken?.workspaces;
  const project = authority?.project;
  requireCondition(
    Array.isArray(workspaces)
      && workspaces.length === 1
      && workspaces[0]?.id === CONTRACT.workspaceId,
    'RAILWAY_PR_PREVIEW_AUTHORITY_MISMATCH'
  );
  requireCondition(
    isRecord(project)
      && project.id === CONTRACT.projectId
      && project.workspaceId === CONTRACT.workspaceId
      && project.baseEnvironmentId === CONTRACT.baseEnvironmentId
      && project.primaryEnvironmentId === CONTRACT.productionEnvironmentId,
    'RAILWAY_PR_PREVIEW_AUTHORITY_MISMATCH'
  );
  if (requireNativeDisabled) {
    requireCondition(
      project.prDeploys === false,
      'RAILWAY_PR_PREVIEW_NATIVE_LIFECYCLE_ENABLED'
    );
  }
  return project;
}

function validateEnvironmentConfig(config, {
  allowAnyBranch = false,
  expectedBranches,
  allowCheckSuites,
  errorCode = 'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH',
} = {}) {
  const expectedGroup = {
    color: 'blue',
    icon: null,
    isCollapsed: false,
    name: 'arcanos',
  };
  requireCondition(
    hasExactKeys(config, [
      'groups',
      'privateNetworkDisabled',
      'services',
      'sharedVariables',
    ])
      && isRecord(config.groups)
      && hasExactKeys(config.groups, [CONTRACT.serviceGroupId])
      && hasExactKeys(config.groups[CONTRACT.serviceGroupId], Object.keys(expectedGroup))
      && Object.entries(expectedGroup).every(
        ([key, value]) => config.groups[CONTRACT.serviceGroupId][key] === value
      )
      && config.privateNetworkDisabled === false
      && isRecord(config.services)
      && isRecord(config.sharedVariables)
      && Object.keys(config.sharedVariables).length === 0
      && hasExactKeys(config.services, [...SERVICE_IDS]),
    errorCode
  );
  for (const [role, service] of Object.entries(CONTRACT.services)) {
    const serviceConfig = config.services[service.id];
    const sourceHasExpectedKeys = hasExactKeys(
      serviceConfig?.source,
      ['branch', 'repo']
    ) || (allowCheckSuites && hasExactKeys(
      serviceConfig?.source,
      ['branch', 'checkSuites', 'repo']
    ));
    requireCondition(
      hasExactKeys(serviceConfig, [
        'build',
        'deploy',
        'groupId',
        'networking',
        'source',
        'variables',
      ])
        && isRecord(serviceConfig.build)
        && isRecord(serviceConfig.deploy)
        && hasExactPreviewRegionConfig(serviceConfig.deploy.multiRegionConfig)
        && serviceConfig.groupId === CONTRACT.serviceGroupId
        && isRecord(serviceConfig.networking)
        && sourceHasExpectedKeys
        && typeof serviceConfig.source.branch === 'string'
        && (allowAnyBranch
          ? isValidGitHubHeadRef(serviceConfig.source.branch)
          : expectedBranches.includes(serviceConfig.source.branch))
        && serviceConfig.source.repo === CONTRACT.repository
        && (serviceConfig.source.checkSuites === undefined
          || serviceConfig.source.checkSuites === false)
        && hasExactKeys(serviceConfig.variables, ['ARCANOS_PROCESS_KIND'])
        && hasExactKeys(
          serviceConfig.variables.ARCANOS_PROCESS_KIND,
          ['value']
        )
        && serviceConfig.variables.ARCANOS_PROCESS_KIND.value === role,
      errorCode
    );
  }
}

function validatePreviewDomain(domain, {
  environmentId,
  requireActive,
  serviceId,
  prNumber,
}) {
  const hostname = domain?.domain;
  const marker = new RegExp(
    `(?:^|[.-])${ENVIRONMENT_PREFIX_PATTERN}${prNumber}(?:[.-]|$)`,
    'iu'
  );
  requireCondition(
    isRecord(domain)
      && isUuid(domain.id)
      && domain.environmentId === environmentId
      && domain.serviceId === serviceId
      && domain.deletedAt === null
      && (requireActive
        ? domain.syncStatus === 'ACTIVE'
        : ['CREATING', 'UPDATING', 'ACTIVE'].includes(domain.syncStatus))
      && typeof hostname === 'string'
      && hostname === hostname.toLowerCase()
      && hostname.endsWith('.up.railway.app')
      && marker.test(hostname)
      && !/(?:^|[.-])production(?:[.-]|$)/iu.test(hostname),
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  return hostname;
}

function validateServiceNode(node, {
  environmentId,
  prNumber,
  requireActiveDomains,
  role,
}) {
  const service = CONTRACT.services[role];
  requireCondition(
    isRecord(node)
      && isUuid(node.id)
      && node.serviceId === service.id
      && node.serviceName === service.name
      && node.environmentId === environmentId
      && node.deletedAt === null
      && node.source?.repo === CONTRACT.repository
      && node.source?.image === null
      && node.rootDirectory === null
      && node.startCommand === CONTRACT.baseStartCommand
      && node.healthcheckPath === '/readyz'
      && node.healthcheckTimeout === 300
      && node.drainingSeconds === null
      && node.restartPolicyType === 'NEVER'
      && node.restartPolicyMaxRetries === 10
      && (node.latestDeployment === null || isRecord(node.latestDeployment))
      && Array.isArray(node.activeDeployments)
      && node.activeDeployments.length <= 1
      && node.activeDeployments.every(isRecord)
      && isRecord(node.domains)
      && Array.isArray(node.domains.serviceDomains)
      && Array.isArray(node.domains.customDomains)
      && node.domains.customDomains.length === 0,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  const domains = node.domains.serviceDomains;
  requireCondition(
    requireActiveDomains ? domains.length === 1 : domains.length <= 1,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  const hostname = domains.length === 1
    ? validatePreviewDomain(domains[0], {
        environmentId,
        requireActive: requireActiveDomains,
        serviceId: service.id,
        prNumber,
      })
    : null;
  return { hostname, node };
}

export function validateOwnedPreviewEnvironment(environment, {
  allowAnyHeadRef = false,
  headRef = undefined,
  prNumber,
  requireActiveDomains = false,
} = {}) {
  requireCondition(
    Number.isSafeInteger(prNumber) && prNumber > 0,
    'RAILWAY_PR_PREVIEW_PR_NUMBER_INVALID'
  );
  const expectedName = `${CONTRACT.environmentPrefix}${prNumber}`;
  requireCondition(
    isRecord(environment)
      && isUuid(environment.id)
      && !PROTECTED_ENVIRONMENT_IDS.has(environment.id)
      && environment.name === expectedName
      && environment.projectId === CONTRACT.projectId
      && environment.isEphemeral === true
      && environment.deletedAt === null
      && environment.sourceEnvironment?.id === CONTRACT.baseEnvironmentId
      && environment.meta === null,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  validateEnvironmentConfig(environment.config, {
    allowAnyBranch: allowAnyHeadRef,
    allowCheckSuites: true,
    expectedBranches: [CONTRACT.baseBranch, headRef],
  });
  const serviceNodes = readConnection(
    environment.serviceInstances,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  const volumeNodes = readConnection(
    environment.volumeInstances,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  const triggerNodes = readConnection(
    environment.deploymentTriggers,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  requireCondition(
    volumeNodes.length === 0
      && serviceNodes.length === 2
      && new Set(serviceNodes.map((node) => node.id)).size === 2
      && new Set(serviceNodes.map((node) => node.serviceId)).size === 2
      && serviceNodes.every((node) => SERVICE_IDS.has(node.serviceId)),
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  const triggerIds = new Set();
  for (const trigger of triggerNodes) {
    requireCondition(
      isUuid(trigger.id)
        && !triggerIds.has(trigger.id)
        && trigger.projectId === CONTRACT.projectId
        && trigger.environmentId === environment.id
        && SERVICE_IDS.has(trigger.serviceId)
        && trigger.repository === CONTRACT.repository
        && typeof trigger.branch === 'string'
        && (allowAnyHeadRef
          ? isValidGitHubHeadRef(trigger.branch)
          : trigger.branch === CONTRACT.baseBranch
          || (headRef !== undefined && trigger.branch === headRef))
        && trigger.provider === 'github'
        && trigger.checkSuites === false,
      'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
    );
    triggerIds.add(trigger.id);
  }
  const byServiceId = new Map(serviceNodes.map((node) => [node.serviceId, node]));
  const worker = validateServiceNode(byServiceId.get(CONTRACT.services.worker.id), {
    environmentId: environment.id,
    prNumber,
    requireActiveDomains,
    role: 'worker',
  });
  const web = validateServiceNode(byServiceId.get(CONTRACT.services.web.id), {
    environmentId: environment.id,
    prNumber,
    requireActiveDomains,
    role: 'web',
  });
  return Object.freeze({
    environmentId: environment.id,
    worker,
    web,
  });
}

export function validateBasePreviewEnvironment(environment) {
  requireCondition(
    isRecord(environment)
      && environment.id === CONTRACT.baseEnvironmentId
      && environment.name === CONTRACT.baseEnvironmentName
      && environment.projectId === CONTRACT.projectId
      && environment.isEphemeral === false
      && environment.deletedAt === null
      && environment.sourceEnvironment?.id === CONTRACT.baseSourceEnvironmentId
      && environment.meta === null,
    'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
  );
  validateEnvironmentConfig(environment.config, {
    allowCheckSuites: false,
    errorCode: 'RAILWAY_PR_PREVIEW_BASE_MISMATCH',
    expectedBranches: [CONTRACT.baseBranch],
  });
  const triggers = readConnection(
    environment.deploymentTriggers,
    'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
  );
  const servicesForBase = readConnection(
    environment.serviceInstances,
    'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
  );
  const volumes = readConnection(
    environment.volumeInstances,
    'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
  );
  requireCondition(
    triggers.length === 0
      && volumes.length === 0
      && servicesForBase.length === 2
      && new Set(servicesForBase.map((node) => node.serviceId)).size === 2,
    'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
  );
  for (const [role, service] of Object.entries(CONTRACT.services)) {
    const nodes = servicesForBase.filter((node) => node.serviceId === service.id);
    requireCondition(nodes.length === 1, 'RAILWAY_PR_PREVIEW_BASE_MISMATCH');
    const node = nodes[0];
    const expectedDomain = role === 'worker'
      ? 'arcanos-worker-pr-preview-base-20260812.up.railway.app'
      : 'arcanos-v2-pr-preview-base-20260812.up.railway.app';
    requireCondition(
      node.id === service.baseInstanceId
        && node.environmentId === CONTRACT.baseEnvironmentId
        && node.serviceName === service.name
        && node.deletedAt === null
        && node.source?.repo === CONTRACT.repository
        && node.source?.image === null
        && node.railwayConfigFile === null
        && node.rootDirectory === null
        && node.dockerfilePath === null
        && node.startCommand === CONTRACT.baseStartCommand
        && node.healthcheckPath === '/readyz'
        && node.healthcheckTimeout === 300
        && node.restartPolicyType === 'NEVER'
        && node.restartPolicyMaxRetries === 10
        && node.drainingSeconds === null
        && node.latestDeployment === null
        && Array.isArray(node.activeDeployments)
        && node.activeDeployments.length === 0
        && Array.isArray(node.domains?.serviceDomains)
        && node.domains.serviceDomains.length === 1
        && isUuid(node.domains.serviceDomains[0]?.id)
        && node.domains.serviceDomains[0]?.domain === expectedDomain
        && node.domains.serviceDomains[0]?.environmentId === CONTRACT.baseEnvironmentId
        && node.domains.serviceDomains[0]?.serviceId === service.id
        && node.domains.serviceDomains[0]?.deletedAt === null
        && node.domains.serviceDomains[0]?.syncStatus === 'ACTIVE'
        && Array.isArray(node.domains?.customDomains)
        && node.domains.customDomains.length === 0
        && role === service.role,
      'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
    );
  }
  return environment;
}

export function validatePreviewDeployment(deployment, {
  deploymentId,
  environmentId,
  serviceId,
  commitSha,
}) {
  requireUuid(deploymentId, 'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  requireUuid(environmentId, 'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  requireCondition(SERVICE_IDS.has(serviceId), 'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  requireCommit(commitSha, 'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  const meta = deployment?.meta;
  const manifest = meta?.serviceManifest;
  const build = manifest?.build;
  const deploy = manifest?.deploy;
  const mappings = meta?.propertyFileMapping;
  requireCondition(
    isRecord(deployment)
      && deployment.id === deploymentId
      && deployment.projectId === CONTRACT.projectId
      && deployment.environmentId === environmentId
      && deployment.serviceId === serviceId
      && deployment.status === 'SUCCESS'
      && deployment.deploymentStopped === false
      && isRecord(meta)
      && meta.repo === CONTRACT.repository
      && meta.commitHash?.toLowerCase() === commitSha
      && meta.configFile === '/railway.json'
      && meta.buildOnly === false
      && meta.reason === 'deploy'
      && meta.rootDirectory === null
      && Array.isArray(meta.volumeMounts)
      && meta.volumeMounts.length === 0
      && hasExactKeys(mappings, Object.keys(EXPECTED_PROPERTY_MAPPINGS))
      && Object.entries(EXPECTED_PROPERTY_MAPPINGS).every(
        ([key, value]) => mappings[key] === value
      )
      && isRecord(build)
      && build.builder === 'DOCKERFILE'
      && build.dockerfilePath === '/Dockerfile'
      && build.buildCommand === CONTRACT.buildCommand
      && build.buildEnvironment === 'V3'
      && Array.isArray(build.watchPatterns)
      && build.watchPatterns.length === 0
      && isRecord(deploy)
      && deploy.startCommand === CONTRACT.previewStartCommand
      && deploy.healthcheckPath === '/readyz'
      && deploy.healthcheckTimeout === 300
      && deploy.drainingSeconds === 60
      && deploy.restartPolicyType === 'NEVER'
      && deploy.restartPolicyMaxRetries === null
      && deploy.preDeployCommand === null
      && deploy.cronSchedule === null
      && deploy.runtime === 'V2'
      && deploy.numReplicas === 1
      && hasExactPreviewRegionConfig(deploy.multiRegionConfig)
      && deploy.requiredMountPath === null,
    'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH'
  );
  return deployment;
}

function readRoleNode(environment, role) {
  const serviceId = CONTRACT.services[role].id;
  const servicesInEnvironment = readConnection(
    environment.serviceInstances,
    'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH'
  );
  const matches = servicesInEnvironment.filter((node) => node.serviceId === serviceId);
  requireCondition(matches.length === 1, 'RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');
  return matches[0];
}

function validateObservedDeploymentIdentity(deployment, {
  environmentId,
  serviceId,
  code = 'RAILWAY_PR_PREVIEW_ACTIVE_DEPLOYMENT_AMBIGUOUS',
}) {
  requireCondition(
    isRecord(deployment)
      && isUuid(deployment.id)
      && deployment.projectId === CONTRACT.projectId
      && deployment.environmentId === environmentId
      && deployment.serviceId === serviceId
      && deployment.meta?.repo === CONTRACT.repository
      && typeof deployment.meta?.commitHash === 'string'
      && COMMIT_PATTERN.test(deployment.meta.commitHash.toLowerCase()),
    code
  );
  return deployment;
}

function validatePriorActiveDeployment(deployment, options) {
  validateObservedDeploymentIdentity(deployment, options);
  requireCondition(
    deployment.status === 'SUCCESS' && deployment.deploymentStopped === false,
    'RAILWAY_PR_PREVIEW_ACTIVE_DEPLOYMENT_AMBIGUOUS'
  );
}

function selectRoleDeployment(environment, role, commitSha) {
  const node = readRoleNode(environment, role);
  const active = node.activeDeployments;
  requireCondition(
    Array.isArray(active) && active.length <= 1,
    'RAILWAY_PR_PREVIEW_ACTIVE_DEPLOYMENT_AMBIGUOUS'
  );
  const serviceId = CONTRACT.services[role].id;
  const activeDeployment = active[0] ?? null;
  if (activeDeployment) {
    validatePriorActiveDeployment(activeDeployment, {
      environmentId: environment.id,
      serviceId,
    });
  }
  const latest = node.latestDeployment;
  if (latest !== null) {
    validateObservedDeploymentIdentity(latest, {
      environmentId: environment.id,
      serviceId,
      code: 'RAILWAY_PR_PREVIEW_DEPLOYMENT_CONFLICT',
    });
    const latestCommit = latest.meta.commitHash.toLowerCase();
    if (latest.id !== activeDeployment?.id) {
      if (PENDING_DEPLOYMENT_STATUSES.has(latest.status)) {
        requireCondition(
          latestCommit === commitSha,
          'RAILWAY_PR_PREVIEW_DEPLOYMENT_CONFLICT'
        );
        return { deployment: latest, state: 'pending' };
      }
      if (latest.status === 'SUCCESS') {
        requireCondition(
          latestCommit === commitSha && latest.deploymentStopped === false,
          'RAILWAY_PR_PREVIEW_DEPLOYMENT_CONFLICT'
        );
        return { deployment: latest, state: 'pending' };
      }
      requireCondition(
        FAILED_DEPLOYMENT_STATUSES.has(latest.status),
        'RAILWAY_PR_PREVIEW_DEPLOYMENT_STATUS_UNKNOWN'
      );
    }
  }
  if (activeDeployment?.meta.commitHash.toLowerCase() !== commitSha) {
    return null;
  }
  validatePreviewDeployment(activeDeployment, {
    deploymentId: activeDeployment.id,
    environmentId: environment.id,
    serviceId,
    commitSha,
  });
  return { deployment: activeDeployment, state: 'active' };
}

function assertWorkerFirstState(environment, commitSha) {
  const worker = selectRoleDeployment(environment, 'worker', commitSha);
  const web = selectRoleDeployment(environment, 'web', commitSha);
  if (web !== null) {
    requireCondition(
      worker?.state === 'active',
      'RAILWAY_PR_PREVIEW_WORKER_FIRST_CONFLICT'
    );
  }
}

function validateReadiness(readiness, {
  role,
  prNumber,
  commitSha,
}) {
  const shared = isRecord(readiness)
    && readiness.ready === true
    && readiness.processKind === role
    && readiness.prNumber === prNumber
    && readiness.sourceCommit === commitSha;
  if (role === 'worker') {
    requireCondition(
      shared && readiness.mode === 'passive-pr-preview',
      'RAILWAY_PR_PREVIEW_READINESS_MISMATCH'
    );
    return;
  }
  requireCondition(
    shared
      && readiness.mode === 'native-pr-application-e2e-v1'
      && readiness.applicationImported === true
      && readiness.fixturesSealed === true
      && readiness.protectedEffectsEnabled === false
      && readiness.protectsMaliciousPr === false
      && readiness.requiresPlatformSecretIsolationForUntrustedCode === true,
    'RAILWAY_PR_PREVIEW_READINESS_MISMATCH'
  );
}

async function requireCurrentPullRequest({
  expected,
  verifyCurrentPullRequest,
}) {
  requireCondition(
    typeof verifyCurrentPullRequest === 'function',
    'RAILWAY_PR_PREVIEW_GITHUB_REVALIDATION_REQUIRED'
  );
  const current = await verifyCurrentPullRequest();
  requireCondition(
    current.number === expected.number
      && current.state === 'open'
      && current.draft === false
      && expected.baseRef === CONTRACT.baseBranch
      && current.baseRef === CONTRACT.baseBranch
      && current.repository === CONTRACT.repository
      && current.headRef === expected.headRef
      && current.headSha === expected.headSha
      && current.labels.includes(CONTRACT.optInLabel),
    'RAILWAY_PR_PREVIEW_GITHUB_STATE_CHANGED'
  );
  return current;
}

function previewMatches(environments, expectedName) {
  requireCondition(Array.isArray(environments), 'RAILWAY_PR_PREVIEW_INVENTORY_INVALID');
  return environments.filter((environment) => environment?.name === expectedName);
}

function assertNoInitialDeploymentRace(environment) {
  for (const role of ['worker', 'web']) {
    const node = readRoleNode(environment, role);
    requireCondition(
      node.latestDeployment === null
        && Array.isArray(node.activeDeployments)
        && node.activeDeployments.length === 0,
      'RAILWAY_PR_PREVIEW_TRIGGER_RACE'
    );
  }
}

function readObservedDeploymentIds(environment) {
  const ids = new Set();
  for (const role of ['worker', 'web']) {
    const node = readRoleNode(environment, role);
    const observed = [
      node.latestDeployment,
      ...(Array.isArray(node.activeDeployments) ? node.activeDeployments : []),
    ].filter((deployment) => deployment !== null);
    for (const deployment of observed) {
      requireCondition(
        isRecord(deployment) && isUuid(deployment.id),
        'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH'
      );
      ids.add(deployment.id);
    }
  }
  return ids;
}

async function sleepProjection(railway, milliseconds) {
  if (typeof railway.sleep === 'function') {
    await railway.sleep(milliseconds);
  }
}

async function waitForOwnedEnvironment({
  environmentId,
  headRef,
  prNumber,
  railway,
  requireActiveDomains = false,
  expectedDeployments = undefined,
  commitSha = undefined,
}) {
  let lastProjectionError;
  for (let attempt = 0; attempt < PROJECTION_POLL_ATTEMPTS; attempt += 1) {
    try {
      const environment = await railway.readEnvironment(environmentId);
      const ownership = validateOwnedPreviewEnvironment(environment, {
        headRef,
        prNumber,
        requireActiveDomains,
      });
      if (expectedDeployments) {
        for (const [role, deploymentId] of Object.entries(expectedDeployments)) {
          assertExactActiveRole(environment, {
            role,
            deploymentId,
            commitSha,
          });
        }
      }
      return { environment, ownership };
    } catch (error) {
      if (!(error instanceof RailwayPrPreviewLifecycleError)) {
        throw error;
      }
      lastProjectionError = error;
    }
    await sleepProjection(railway, PROJECTION_POLL_INTERVAL_MS);
  }
  throw lastProjectionError
    ?? new RailwayPrPreviewLifecycleError('RAILWAY_PR_PREVIEW_PROJECTION_TIMEOUT');
}

async function waitForEnvironmentInventory({
  environmentId,
  expectedName,
  railway,
}) {
  let lastReadError;
  for (let attempt = 0; attempt < PROJECTION_POLL_ATTEMPTS; attempt += 1) {
    try {
      const matches = previewMatches(await railway.listEnvironments(), expectedName);
      requireCondition(matches.length <= 1, 'RAILWAY_PR_PREVIEW_ENVIRONMENT_AMBIGUOUS');
      if (matches.length === 1) {
        requireCondition(
          matches[0].id === environmentId,
          'RAILWAY_PR_PREVIEW_CREATE_MISMATCH'
        );
        return matches[0];
      }
    } catch (error) {
      if (!(error instanceof RailwayPrPreviewLifecycleError)) {
        throw error;
      }
      lastReadError = error;
    }
    await sleepProjection(railway, PROJECTION_POLL_INTERVAL_MS);
  }
  throw lastReadError
    ?? new RailwayPrPreviewLifecycleError(
      'RAILWAY_PR_PREVIEW_CREATE_VISIBILITY_TIMEOUT'
    );
}

async function quiesceTriggers({ environment, pullRequest, railway }) {
  const before = readObservedDeploymentIds(environment);
  await railway.removeAndVerifyTriggers(environment, pullRequest);
  const { environment: latest } = await waitForOwnedEnvironment({
    environmentId: environment.id,
    headRef: pullRequest.headRef,
    prNumber: pullRequest.number,
    railway,
  });
  const triggers = readConnection(
    latest.deploymentTriggers,
    'RAILWAY_PR_PREVIEW_TRIGGER_MISMATCH'
  );
  requireCondition(triggers.length === 0, 'RAILWAY_PR_PREVIEW_TRIGGER_REAPPEARED');
  const after = readObservedDeploymentIds(latest);
  requireCondition(
    [...after].every((deploymentId) => before.has(deploymentId)),
    'RAILWAY_PR_PREVIEW_TRIGGER_RACE'
  );
  return latest;
}

async function waitForReadiness({
  baseUrl,
  commitSha,
  prNumber,
  railway,
  role,
}) {
  let lastError;
  for (let attempt = 0; attempt < READINESS_POLL_ATTEMPTS; attempt += 1) {
    try {
      const readiness = await railway.readReadiness({
        baseUrl,
        commitSha,
        prNumber,
        role,
      });
      validateReadiness(readiness, { role, prNumber, commitSha });
      return readiness;
    } catch (error) {
      if (!(error instanceof RailwayPrPreviewLifecycleError)) {
        throw error;
      }
      lastError = error;
    }
    await sleepProjection(railway, READINESS_POLL_INTERVAL_MS);
  }
  throw lastError
    ?? new RailwayPrPreviewLifecycleError('RAILWAY_PR_PREVIEW_READINESS_TIMEOUT');
}

async function ensureRoleDeployment({
  environment,
  role,
  pullRequest,
  railway,
  verifyCurrentPullRequest,
}) {
  const existing = selectRoleDeployment(
    environment,
    role,
    pullRequest.headSha
  );
  const serviceId = CONTRACT.services[role].id;
  if (existing?.state === 'active') {
    return existing.deployment.id;
  }
  if (existing?.state === 'pending') {
    const observed = await railway.waitForDeployment({
      commitSha: pullRequest.headSha,
      deploymentId: existing.deployment.id,
      environmentId: environment.id,
      serviceId,
    });
    validatePreviewDeployment(observed, {
      deploymentId: existing.deployment.id,
      environmentId: environment.id,
      serviceId,
      commitSha: pullRequest.headSha,
    });
    return existing.deployment.id;
  }
  await requireCurrentPullRequest({ expected: pullRequest, verifyCurrentPullRequest });
  const deploymentId = await railway.deployExact({
    commitSha: pullRequest.headSha,
    environmentId: environment.id,
    serviceId,
  });
  requireUuid(deploymentId, 'RAILWAY_PR_PREVIEW_DEPLOYMENT_ID_INVALID');
  const observed = await railway.waitForDeployment({
    commitSha: pullRequest.headSha,
    deploymentId,
    environmentId: environment.id,
    serviceId,
  });
  validatePreviewDeployment(observed, {
    deploymentId,
    environmentId: environment.id,
    serviceId,
    commitSha: pullRequest.headSha,
  });
  return deploymentId;
}

function assertExactActiveRole(environment, {
  role,
  deploymentId,
  commitSha,
}) {
  const node = readRoleNode(environment, role);
  requireCondition(
    Array.isArray(node.activeDeployments)
      && node.activeDeployments.length === 1
      && node.activeDeployments[0]?.id === deploymentId,
    'RAILWAY_PR_PREVIEW_ACTIVE_DEPLOYMENT_AMBIGUOUS'
  );
  validatePreviewDeployment(node.activeDeployments[0], {
    deploymentId,
    environmentId: environment.id,
    serviceId: CONTRACT.services[role].id,
    commitSha,
  });
  if (node.latestDeployment !== null && node.latestDeployment.id !== deploymentId) {
    validateObservedDeploymentIdentity(node.latestDeployment, {
      environmentId: environment.id,
      serviceId: CONTRACT.services[role].id,
      code: 'RAILWAY_PR_PREVIEW_DEPLOYMENT_CONFLICT',
    });
    requireCondition(
      FAILED_DEPLOYMENT_STATUSES.has(node.latestDeployment.status),
      'RAILWAY_PR_PREVIEW_DEPLOYMENT_CONFLICT'
    );
  }
}

export async function reconcileRailwayPrPreview({
  pullRequest,
  railway,
  verifyCurrentPullRequest,
}) {
  requireCondition(isRecord(railway), 'RAILWAY_PR_PREVIEW_ADAPTER_INVALID');
  await railway.validateAuthority({ requireNativeDisabled: true });
  const base = await railway.readBaseEnvironment();
  if (typeof railway.validateBaseEnvironment === 'function') {
    railway.validateBaseEnvironment(base);
  } else {
    validateBasePreviewEnvironment(base);
  }

  const expectedName = `${CONTRACT.environmentPrefix}${pullRequest.number}`;
  let matches = previewMatches(await railway.listEnvironments(), expectedName);
  requireCondition(matches.length <= 1, 'RAILWAY_PR_PREVIEW_ENVIRONMENT_AMBIGUOUS');
  let target;
  if (matches.length === 0) {
    await requireCurrentPullRequest({ expected: pullRequest, verifyCurrentPullRequest });
    const created = await railway.createEnvironment({
      projectId: CONTRACT.projectId,
      name: expectedName,
      sourceEnvironmentId: CONTRACT.baseEnvironmentId,
      ephemeral: true,
      skipInitialDeploys: true,
      stageInitialChanges: false,
      applyChangesInBackground: false,
    });
    requireCondition(
      isRecord(created)
        && isUuid(created.id)
        && created.name === expectedName
        && created.projectId === CONTRACT.projectId
        && created.isEphemeral === true
        && created.sourceEnvironment?.id === CONTRACT.baseEnvironmentId,
      'RAILWAY_PR_PREVIEW_CREATE_MISMATCH'
    );
    try {
      await waitForEnvironmentInventory({
        environmentId: created.id,
        expectedName,
        railway,
      });
      ({ environment: target } = await waitForOwnedEnvironment({
        environmentId: created.id,
        headRef: pullRequest.headRef,
        prNumber: pullRequest.number,
        railway,
      }));
      assertNoInitialDeploymentRace(target);
      target = await quiesceTriggers({ environment: target, pullRequest, railway });
      assertNoInitialDeploymentRace(target);
    } catch (error) {
      if (typeof railway.deleteAndVerifyEnvironment === 'function') {
        await railway.deleteAndVerifyEnvironment(created);
      }
      throw error;
    }
  } else {
    ({ environment: target } = await waitForOwnedEnvironment({
      environmentId: matches[0].id,
      headRef: pullRequest.headRef,
      prNumber: pullRequest.number,
      railway,
    }));
    target = await quiesceTriggers({ environment: target, pullRequest, railway });
  }

  assertWorkerFirstState(target, pullRequest.headSha);

  const workerDeploymentId = await ensureRoleDeployment({
    environment: target,
    role: 'worker',
    pullRequest,
    railway,
    verifyCurrentPullRequest,
  });
  ({ environment: target } = await waitForOwnedEnvironment({
    commitSha: pullRequest.headSha,
    environmentId: target.id,
    expectedDeployments: { worker: workerDeploymentId },
    headRef: pullRequest.headRef,
    prNumber: pullRequest.number,
    railway,
  }));
  target = await quiesceTriggers({ environment: target, pullRequest, railway });
  assertExactActiveRole(target, {
    commitSha: pullRequest.headSha,
    deploymentId: workerDeploymentId,
    role: 'worker',
  });

  await requireCurrentPullRequest({ expected: pullRequest, verifyCurrentPullRequest });
  const webDeploymentId = await ensureRoleDeployment({
    environment: target,
    role: 'web',
    pullRequest,
    railway,
    verifyCurrentPullRequest,
  });
  await requireCurrentPullRequest({ expected: pullRequest, verifyCurrentPullRequest });
  let readyProjection = await waitForOwnedEnvironment({
    commitSha: pullRequest.headSha,
    environmentId: target.id,
    expectedDeployments: {
      web: webDeploymentId,
      worker: workerDeploymentId,
    },
    headRef: pullRequest.headRef,
    prNumber: pullRequest.number,
    railway,
    requireActiveDomains: true,
  });
  target = await quiesceTriggers({
    environment: readyProjection.environment,
    pullRequest,
    railway,
  });
  await requireCurrentPullRequest({ expected: pullRequest, verifyCurrentPullRequest });
  readyProjection = await waitForOwnedEnvironment({
    commitSha: pullRequest.headSha,
    environmentId: target.id,
    expectedDeployments: {
      web: webDeploymentId,
      worker: workerDeploymentId,
    },
    headRef: pullRequest.headRef,
    prNumber: pullRequest.number,
    railway,
    requireActiveDomains: true,
  });
  const ownership = readyProjection.ownership;
  requireCondition(
    readConnection(
      readyProjection.environment.deploymentTriggers,
      'RAILWAY_PR_PREVIEW_TRIGGER_MISMATCH'
    ).length === 0,
    'RAILWAY_PR_PREVIEW_TRIGGER_REAPPEARED'
  );

  await waitForReadiness({
    baseUrl: `https://${ownership.worker.hostname}`,
    commitSha: pullRequest.headSha,
    prNumber: pullRequest.number,
    railway,
    role: 'worker',
  });
  await waitForReadiness({
    baseUrl: `https://${ownership.web.hostname}`,
    commitSha: pullRequest.headSha,
    prNumber: pullRequest.number,
    railway,
    role: 'web',
  });

  return Object.freeze({
    action: 'reconcile',
    environmentId: target.id,
    headSha: pullRequest.headSha,
    prNumber: pullRequest.number,
    webBaseUrl: `https://${ownership.web.hostname}`,
    webDeploymentId,
    workerBaseUrl: `https://${ownership.worker.hostname}`,
    workerDeploymentId,
  });
}

export async function cleanupRailwayPrPreview({
  pullRequest,
  railway,
  verifyCurrentPullRequest = undefined,
}) {
  await railway.validateAuthority({ requireNativeDisabled: false });
  const expectedName = `${CONTRACT.environmentPrefix}${pullRequest.number}`;
  const matches = previewMatches(await railway.listEnvironments(), expectedName);
  requireCondition(matches.length <= 1, 'RAILWAY_PR_PREVIEW_ENVIRONMENT_AMBIGUOUS');
  if (matches.length === 0) {
    return Object.freeze({
      action: 'cleanup',
      deleted: false,
      prNumber: pullRequest.number,
    });
  }
  requireCondition(
    typeof verifyCurrentPullRequest === 'function',
    'RAILWAY_PR_PREVIEW_GITHUB_REVALIDATION_REQUIRED'
  );
  const target = await railway.readEnvironment(matches[0].id);
  validateOwnedPreviewEnvironment(target, {
    allowAnyHeadRef: true,
    headRef: pullRequest.headRef,
    prNumber: pullRequest.number,
  });
  const current = await verifyCurrentPullRequest();
  requireCondition(
    current.number === pullRequest.number
      && current.repository === CONTRACT.repository
      && current.headRef === pullRequest.headRef
      && current.headSha === pullRequest.headSha
      && decideLifecycleAction({
        eventAction: 'manual',
        pullRequest: current,
      }) !== 'reconcile',
    'RAILWAY_PR_PREVIEW_GITHUB_STATE_CHANGED'
  );
  await railway.deleteAndVerifyEnvironment(target);
  return Object.freeze({
    action: 'cleanup',
    deleted: true,
    environmentId: target.id,
    prNumber: pullRequest.number,
  });
}

export async function discoverRailwayPrPreviewNumbers({ github, railway }) {
  requireCondition(
    isRecord(github) && isRecord(railway),
    'RAILWAY_PR_PREVIEW_ADAPTER_INVALID'
  );
  await railway.validateAuthority({ requireNativeDisabled: false });
  const numbers = new Set();
  const prefixPattern = new RegExp(
    `^${ENVIRONMENT_PREFIX_PATTERN}([1-9][0-9]*)$`,
    'u'
  );
  for (const environment of await railway.listEnvironments()) {
    const match = prefixPattern.exec(environment.name);
    if (!match) {
      continue;
    }
    const prNumber = Number.parseInt(match[1], 10);
    requireCondition(
      Number.isSafeInteger(prNumber) && prNumber > 0,
      'RAILWAY_PR_PREVIEW_PR_NUMBER_INVALID'
    );
    numbers.add(prNumber);
  }
  for (const rawPullRequest of await github.listOpenPullRequests()) {
    const inScope = rawPullRequest?.base?.ref === CONTRACT.baseBranch
      && rawPullRequest.base?.repo?.full_name === CONTRACT.repository
      && rawPullRequest.head?.repo?.full_name === CONTRACT.repository
      && Array.isArray(rawPullRequest.labels)
      && rawPullRequest.labels.some((label) => label?.name === CONTRACT.optInLabel);
    if (!inScope) {
      continue;
    }
    const pullRequest = validateLifecyclePullRequest(
      rawPullRequest,
      rawPullRequest.number
    );
    numbers.add(pullRequest.number);
  }
  requireCondition(numbers.size <= 100, 'RAILWAY_PR_PREVIEW_SWEEP_LIMIT_EXCEEDED');
  return Object.freeze([...numbers].sort((left, right) => left - right));
}

async function readBoundedJson(response, maxBytes, code) {
  requireCondition(response?.body && typeof response.body.getReader === 'function', code);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    requireCondition(total <= maxBytes, code);
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
}

export class RailwayGraphqlApi {
  constructor({ token, fetchImpl = globalThis.fetch, sleepImpl = undefined }) {
    requireCondition(
      typeof token === 'string'
        && token.length >= 20
        && token.trim() === token,
      'RAILWAY_PR_PREVIEW_TOKEN_INVALID'
    );
    requireCondition(typeof fetchImpl === 'function', 'RAILWAY_PR_PREVIEW_FETCH_UNAVAILABLE');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async requestRaw(query, variables = {}) {
    let response;
    try {
      response = await this.fetchImpl(RAILWAY_API_URL, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': 'arcanos-railway-pr-preview-lifecycle/1',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      fail('RAILWAY_PR_PREVIEW_API_FAILED');
    }
    const body = await readBoundedJson(
      response,
      API_RESPONSE_LIMIT_BYTES,
      'RAILWAY_PR_PREVIEW_API_FAILED'
    );
    requireCondition(response.ok && isRecord(body), 'RAILWAY_PR_PREVIEW_API_FAILED');
    return body;
  }

  async graphql(query, variables = {}) {
    const body = await this.requestRaw(query, variables);
    requireCondition(
      Array.isArray(body.errors) ? body.errors.length === 0 : body.errors === undefined,
      'RAILWAY_PR_PREVIEW_API_FAILED'
    );
    requireCondition(isRecord(body.data), 'RAILWAY_PR_PREVIEW_API_FAILED');
    return body.data;
  }

  async validateTokenType() {
    const body = await this.requestRaw(TOKEN_TYPE_QUERY);
    requireCondition(
      body.data?.me == null
        && Array.isArray(body.errors)
        && body.errors.length > 0,
      body.data?.me?.id
        ? 'RAILWAY_PR_PREVIEW_ACCOUNT_TOKEN_FORBIDDEN'
        : 'RAILWAY_PR_PREVIEW_WORKSPACE_TOKEN_UNPROVEN'
    );
  }

  async validateAuthority({ requireNativeDisabled }) {
    await this.validateTokenType();
    const data = await this.graphql(AUTHORITY_QUERY, {
      projectId: CONTRACT.projectId,
    });
    return validateLifecycleAuthority(data, { requireNativeDisabled });
  }

  async readBaseEnvironment() {
    return this.readEnvironment(CONTRACT.baseEnvironmentId);
  }

  validateBaseEnvironment(environment) {
    return validateBasePreviewEnvironment(environment);
  }

  async sleep(milliseconds) {
    await this.sleepImpl(milliseconds);
  }

  async listEnvironments() {
    const environments = [];
    const ids = new Set();
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.graphql(ENVIRONMENTS_QUERY, {
        projectId: CONTRACT.projectId,
        after,
      });
      const connection = data.environments;
      requireCondition(
        isRecord(connection)
          && Array.isArray(connection.edges)
          && isRecord(connection.pageInfo),
        'RAILWAY_PR_PREVIEW_INVENTORY_INVALID'
      );
      for (const edge of connection.edges) {
        const node = edge?.node;
        requireCondition(
          isRecord(node)
            && isUuid(node.id)
            && typeof node.name === 'string'
            && node.name.length > 0
            && node.projectId === CONTRACT.projectId
            && !ids.has(node.id),
          'RAILWAY_PR_PREVIEW_INVENTORY_INVALID'
        );
        ids.add(node.id);
        environments.push(node);
      }
      if (connection.pageInfo.hasNextPage === false) {
        requireCondition(
          ids.has(CONTRACT.baseEnvironmentId)
            && ids.has(CONTRACT.productionEnvironmentId),
          'RAILWAY_PR_PREVIEW_INVENTORY_VISIBILITY_INSUFFICIENT'
        );
        return environments;
      }
      requireCondition(
        connection.pageInfo.hasNextPage === true
          && typeof connection.pageInfo.endCursor === 'string'
          && connection.pageInfo.endCursor.length > 0,
        'RAILWAY_PR_PREVIEW_INVENTORY_INVALID'
      );
      after = connection.pageInfo.endCursor;
    }
    fail('RAILWAY_PR_PREVIEW_INVENTORY_LIMIT_EXCEEDED');
  }

  async readEnvironment(environmentId) {
    requireUuid(environmentId, 'RAILWAY_PR_PREVIEW_ENVIRONMENT_ID_INVALID');
    const data = await this.graphql(ENVIRONMENT_QUERY, {
      projectId: CONTRACT.projectId,
      environmentId,
    });
    requireCondition(isRecord(data.environment), 'RAILWAY_PR_PREVIEW_ENVIRONMENT_INVALID');
    return data.environment;
  }

  async createEnvironment(input) {
    const expectedNamePattern = new RegExp(
      `^${ENVIRONMENT_PREFIX_PATTERN}[1-9][0-9]*$`,
      'u'
    );
    requireCondition(
      isRecord(input)
        && hasExactKeys(input, [
          'applyChangesInBackground',
          'ephemeral',
          'name',
          'projectId',
          'skipInitialDeploys',
          'sourceEnvironmentId',
          'stageInitialChanges',
        ])
        && input.projectId === CONTRACT.projectId
        && input.sourceEnvironmentId === CONTRACT.baseEnvironmentId
        && input.ephemeral === true
        && input.skipInitialDeploys === true
        && input.stageInitialChanges === false
        && input.applyChangesInBackground === false
        && typeof input.name === 'string'
        && expectedNamePattern.test(input.name),
      'RAILWAY_PR_PREVIEW_CREATE_INPUT_INVALID'
    );
    const data = await this.graphql(CREATE_ENVIRONMENT_MUTATION, { input });
    return data.environmentCreate;
  }

  async removeAndVerifyTriggers(environment, pullRequest) {
    const triggerNodes = readConnection(
      environment.deploymentTriggers,
      'RAILWAY_PR_PREVIEW_TRIGGER_MISMATCH'
    );
    const triggerIds = new Set();
    for (const trigger of triggerNodes) {
      requireCondition(
        isUuid(trigger.id)
          && !triggerIds.has(trigger.id)
          && trigger.projectId === CONTRACT.projectId
          && trigger.environmentId === environment.id
          && SERVICE_IDS.has(trigger.serviceId)
          && trigger.repository === CONTRACT.repository
          && (trigger.branch === CONTRACT.baseBranch
            || trigger.branch === pullRequest.headRef)
          && trigger.provider === 'github'
          && trigger.checkSuites === false,
        'RAILWAY_PR_PREVIEW_TRIGGER_MISMATCH'
      );
      triggerIds.add(trigger.id);
      const data = await this.graphql(DELETE_TRIGGER_MUTATION, { id: trigger.id });
      requireCondition(
        data.deploymentTriggerDelete === true,
        'RAILWAY_PR_PREVIEW_TRIGGER_DELETE_FAILED'
      );
    }

    let latest = environment;
    for (let observation = 0; observation < 2; observation += 1) {
      latest = await this.readEnvironment(environment.id);
      validateOwnedPreviewEnvironment(latest, {
        headRef: pullRequest.headRef,
        prNumber: pullRequest.number,
      });
      requireCondition(
        readConnection(
          latest.deploymentTriggers,
          'RAILWAY_PR_PREVIEW_TRIGGER_MISMATCH'
        ).length === 0,
        'RAILWAY_PR_PREVIEW_TRIGGER_REAPPEARED'
      );
      if (observation === 0) {
        await this.sleepImpl(TRIGGER_QUIESCENCE_INTERVAL_MS);
      }
    }
    return latest;
  }

  async deployExact({ commitSha, environmentId, serviceId }) {
    requireCommit(commitSha, 'RAILWAY_PR_PREVIEW_COMMIT_INVALID');
    requireUuid(environmentId, 'RAILWAY_PR_PREVIEW_ENVIRONMENT_ID_INVALID');
    requireCondition(
      !PROTECTED_ENVIRONMENT_IDS.has(environmentId),
      'RAILWAY_PR_PREVIEW_DEPLOY_TARGET_INVALID'
    );
    requireCondition(SERVICE_IDS.has(serviceId), 'RAILWAY_PR_PREVIEW_SERVICE_ID_INVALID');
    const data = await this.graphql(DEPLOY_SERVICE_MUTATION, {
      environmentId,
      serviceId,
      commitSha,
    });
    requireUuid(
      data.serviceInstanceDeployV2,
      'RAILWAY_PR_PREVIEW_DEPLOYMENT_ID_INVALID'
    );
    return data.serviceInstanceDeployV2;
  }

  async waitForDeployment({ deploymentId, environmentId, serviceId, commitSha }) {
    let transientReadFailures = 0;
    for (let attempt = 0; attempt < DEPLOYMENT_POLL_ATTEMPTS; attempt += 1) {
      let data;
      try {
        data = await this.graphql(DEPLOYMENT_QUERY, { id: deploymentId });
      } catch (error) {
        if (!(error instanceof RailwayPrPreviewLifecycleError)
          || error.code !== 'RAILWAY_PR_PREVIEW_API_FAILED') {
          throw error;
        }
        transientReadFailures += 1;
        requireCondition(
          transientReadFailures <= 5,
          'RAILWAY_PR_PREVIEW_DEPLOYMENT_OBSERVATION_FAILED'
        );
        await this.sleepImpl(DEPLOYMENT_POLL_INTERVAL_MS);
        continue;
      }
      transientReadFailures = 0;
      const observed = data.deployment;
      requireCondition(
        isRecord(observed)
          && observed.id === deploymentId
          && observed.projectId === CONTRACT.projectId
          && observed.environmentId === environmentId
          && observed.serviceId === serviceId,
        'RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH'
      );
      if (observed.status === 'SUCCESS') {
        return validatePreviewDeployment(observed, {
          deploymentId,
          environmentId,
          serviceId,
          commitSha,
        });
      }
      if (FAILED_DEPLOYMENT_STATUSES.has(observed.status)) {
        fail('RAILWAY_PR_PREVIEW_DEPLOYMENT_FAILED');
      }
      requireCondition(
        PENDING_DEPLOYMENT_STATUSES.has(observed.status),
        'RAILWAY_PR_PREVIEW_DEPLOYMENT_STATUS_UNKNOWN'
      );
      await this.sleepImpl(DEPLOYMENT_POLL_INTERVAL_MS);
    }
    fail('RAILWAY_PR_PREVIEW_DEPLOYMENT_TIMEOUT');
  }

  async readReadiness({ baseUrl }) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      fail('RAILWAY_PR_PREVIEW_READINESS_TARGET_INVALID');
    }
    requireCondition(
      parsed.protocol === 'https:'
        && !parsed.username
        && !parsed.password
        && !parsed.port
        && (parsed.pathname === '' || parsed.pathname === '/')
        && !parsed.search
        && !parsed.hash
        && parsed.hostname.endsWith('.up.railway.app')
        && !/(?:^|[.-])production(?:[.-]|$)/iu.test(parsed.hostname),
      'RAILWAY_PR_PREVIEW_READINESS_TARGET_INVALID'
    );
    let response;
    try {
      response = await this.fetchImpl(`${parsed.origin}/readyz`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          'user-agent': 'arcanos-railway-pr-preview-lifecycle/1',
        },
      });
    } catch {
      fail('RAILWAY_PR_PREVIEW_READINESS_FAILED');
    }
    requireCondition(
      response.ok
        && response.status === 200
        && response.headers.get('cache-control') === 'no-store'
        && response.headers.get('content-type')?.toLowerCase().startsWith('application/json'),
      'RAILWAY_PR_PREVIEW_READINESS_FAILED'
    );
    return readBoundedJson(
      response,
      READINESS_RESPONSE_LIMIT_BYTES,
      'RAILWAY_PR_PREVIEW_READINESS_FAILED'
    );
  }

  async deleteAndVerifyEnvironment(environment) {
    const ownedNamePattern = new RegExp(
      `^${ENVIRONMENT_PREFIX_PATTERN}[1-9][0-9]*$`,
      'u'
    );
    requireCondition(
      isRecord(environment)
        && isUuid(environment.id)
        && !PROTECTED_ENVIRONMENT_IDS.has(environment.id)
        && typeof environment.name === 'string'
        && ownedNamePattern.test(environment.name)
        && environment.projectId === CONTRACT.projectId
        && environment.isEphemeral === true
        && environment.sourceEnvironment?.id === CONTRACT.baseEnvironmentId
        && (environment.deletedAt === undefined || environment.deletedAt === null),
      'RAILWAY_PR_PREVIEW_DELETE_TARGET_INVALID'
    );
    const data = await this.graphql(DELETE_ENVIRONMENT_MUTATION, {
      id: environment.id,
    });
    requireCondition(
      data.environmentDelete === true,
      'RAILWAY_PR_PREVIEW_DELETE_FAILED'
    );
    for (let attempt = 0; attempt < DELETE_POLL_ATTEMPTS; attempt += 1) {
      const environments = await this.listEnvironments();
      const sameId = environments.some((item) => item.id === environment.id);
      const sameName = environments.filter((item) => item.name === environment.name);
      if (!sameId && sameName.length === 0) {
        return;
      }
      requireCondition(
        sameName.every((item) => item.id === environment.id),
        'RAILWAY_PR_PREVIEW_DELETE_IDENTITY_CHANGED'
      );
      await this.sleepImpl(DELETE_POLL_INTERVAL_MS);
    }
    fail('RAILWAY_PR_PREVIEW_DELETE_TIMEOUT');
  }
}

export class GitHubApi {
  constructor({ token, fetchImpl = globalThis.fetch }) {
    requireCondition(
      typeof token === 'string'
        && token.length >= 20
        && token.trim() === token,
      'RAILWAY_PR_PREVIEW_GITHUB_TOKEN_INVALID'
    );
    requireCondition(typeof fetchImpl === 'function', 'RAILWAY_PR_PREVIEW_FETCH_UNAVAILABLE');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = 'GET', body = undefined } = {}) {
    requireCondition(
      typeof pathname === 'string' && pathname.startsWith('/repos/pbjustin/Arcanos/'),
      'RAILWAY_PR_PREVIEW_GITHUB_REQUEST_INVALID'
    );
    let response;
    try {
      response = await this.fetchImpl(`${GITHUB_API_URL}${pathname}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': 'arcanos-railway-pr-preview-lifecycle/1',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail('RAILWAY_PR_PREVIEW_GITHUB_API_FAILED');
    }
    const parsed = await readBoundedJson(
      response,
      GITHUB_RESPONSE_LIMIT_BYTES,
      'RAILWAY_PR_PREVIEW_GITHUB_API_FAILED'
    );
    requireCondition(
      response.ok && (isRecord(parsed) || Array.isArray(parsed)),
      'RAILWAY_PR_PREVIEW_GITHUB_API_FAILED'
    );
    return parsed;
  }

  async readPullRequest(prNumber) {
    return this.request(`/repos/${CONTRACT.repository}/pulls/${prNumber}`);
  }

  async listOpenPullRequests() {
    const pullRequests = [];
    for (let page = 1; page <= 20; page += 1) {
      const observed = await this.request(
        `/repos/${CONTRACT.repository}/pulls?state=open&per_page=100&page=${page}`
      );
      requireCondition(
        Array.isArray(observed) && observed.every(isRecord),
        'RAILWAY_PR_PREVIEW_GITHUB_API_FAILED'
      );
      pullRequests.push(...observed);
      if (observed.length < 100) {
        return pullRequests;
      }
    }
    fail('RAILWAY_PR_PREVIEW_GITHUB_PAGINATION_LIMIT_EXCEEDED');
  }

  async writeCommitStatus({ sha, state, description, targetUrl }) {
    requireCommit(sha, 'RAILWAY_PR_PREVIEW_COMMIT_INVALID');
    requireCondition(
      ['pending', 'success', 'failure'].includes(state)
        && typeof description === 'string'
        && description.length > 0
        && description.length <= 140
        && typeof targetUrl === 'string'
        && /^https:\/\/github\.com\/pbjustin\/Arcanos\/actions\/runs\/[1-9][0-9]*$/u
          .test(targetUrl),
      'RAILWAY_PR_PREVIEW_STATUS_INVALID'
    );
    const result = await this.request(
      `/repos/${CONTRACT.repository}/statuses/${sha}`,
      {
        method: 'POST',
        body: {
          state,
          context: CONTRACT.statusContext,
          description,
          target_url: targetUrl,
        },
      }
    );
    requireCondition(
      result.sha?.toLowerCase() === sha && result.context === CONTRACT.statusContext,
      'RAILWAY_PR_PREVIEW_STATUS_WRITE_FAILED'
    );
  }
}

function readPrNumber(raw) {
  requireCondition(
    typeof raw === 'string' && POSITIVE_INTEGER_PATTERN.test(raw),
    'RAILWAY_PR_PREVIEW_PR_NUMBER_INVALID'
  );
  const number = Number.parseInt(raw, 10);
  requireCondition(Number.isSafeInteger(number), 'RAILWAY_PR_PREVIEW_PR_NUMBER_INVALID');
  return number;
}

function readEventInput(env) {
  requireCondition(
    env.GITHUB_REPOSITORY === CONTRACT.repository
      && env.EXPECTED_OPT_IN_LABEL === CONTRACT.optInLabel,
    'RAILWAY_PR_PREVIEW_REPOSITORY_MISMATCH'
  );
  const eventAction = env.EVENT_ACTION ?? '';
  const eventLabelName = env.EVENT_LABEL_NAME ?? '';
  const eventHeadSha = (env.EVENT_HEAD_SHA ?? '').toLowerCase();
  requireCondition(
    eventHeadSha === '' || COMMIT_PATTERN.test(eventHeadSha),
    'RAILWAY_PR_PREVIEW_COMMIT_INVALID'
  );
  requireCondition(
    eventLabelName.length <= 100 && eventLabelName.trim() === eventLabelName,
    'RAILWAY_PR_PREVIEW_EVENT_LABEL_INVALID'
  );
  return {
    eventAction,
    eventHeadSha,
    eventLabelName,
    prNumber: readPrNumber(env.PR_NUMBER),
  };
}

function writeGithubOutputs(values, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    return;
  }
  const lines = [];
  for (const [name, rawValue] of Object.entries(values)) {
    const value = String(rawValue ?? '');
    requireCondition(
      /^[a-z_][a-z0-9_]*$/u.test(name)
        && !value.includes('\n')
        && !value.includes('\r'),
      'RAILWAY_PR_PREVIEW_OUTPUT_INVALID'
    );
    lines.push(`${name}=${value}`);
  }
  appendFileSync(outputPath, `${lines.join('\n')}\n`, { encoding: 'utf8' });
}

function lifecycleOutputs(result, pullRequest) {
  return {
    action: result.action,
    preview_ready: result.action === 'reconcile' ? 'true' : 'false',
    pr_number: pullRequest.number,
    head_sha: pullRequest.headSha,
    environment_id: result.environmentId ?? '',
    worker_deployment_id: result.workerDeploymentId ?? '',
    web_deployment_id: result.webDeploymentId ?? '',
    worker_base_url: result.workerBaseUrl ?? '',
    web_base_url: result.webBaseUrl ?? '',
  };
}

async function runEventCli(env = process.env) {
  const input = readEventInput(env);
  const github = new GitHubApi({ token: env.GITHUB_TOKEN });
  const readCurrent = async () => validateLifecyclePullRequest(
    await github.readPullRequest(input.prNumber),
    input.prNumber
  );
  const pullRequest = await readCurrent();
  const action = decideLifecycleAction({
    eventAction: input.eventAction,
    eventLabelName: input.eventLabelName,
    pullRequest,
  });
  if (action === 'noop') {
    const result = { action: 'noop', reason: 'not-opted-in' };
    writeGithubOutputs(lifecycleOutputs(result, pullRequest), env.GITHUB_OUTPUT);
    return result;
  }
  if (action === 'reconcile') {
    await github.writeCommitStatus({
      sha: pullRequest.headSha,
      state: 'pending',
      description: 'Reconciling exact-SHA Railway preview and sealed E2E.',
      targetUrl: env.RUN_URL,
    });
  }
  let result;
  try {
    const railway = new RailwayGraphqlApi({ token: env.RAILWAY_API_TOKEN });
    result = action === 'reconcile'
      ? await reconcileRailwayPrPreview({
          pullRequest,
          railway,
          verifyCurrentPullRequest: readCurrent,
        })
      : await cleanupRailwayPrPreview({
          pullRequest,
          railway,
          verifyCurrentPullRequest: readCurrent,
        });
  } catch (error) {
    if (action === 'reconcile') {
      const current = await readCurrent().catch(() => null);
      if (current?.headSha === pullRequest.headSha) {
        await github.writeCommitStatus({
          sha: pullRequest.headSha,
          state: 'failure',
          description: 'Railway preview lifecycle failed before sealed E2E.',
          targetUrl: env.RUN_URL,
        }).catch(() => undefined);
      }
    }
    throw error;
  }
  writeGithubOutputs(lifecycleOutputs(result, pullRequest), env.GITHUB_OUTPUT);
  return result;
}

async function runReportStatusCli(env = process.env) {
  const input = readEventInput(env);
  const github = new GitHubApi({ token: env.GITHUB_TOKEN });
  const pullRequest = validateLifecyclePullRequest(
    await github.readPullRequest(input.prNumber),
    input.prNumber
  );
  const lifecycleHeadSha = (env.LIFECYCLE_HEAD_SHA ?? '').toLowerCase();
  requireCondition(
    lifecycleHeadSha === '' || COMMIT_PATTERN.test(lifecycleHeadSha),
    'RAILWAY_PR_PREVIEW_COMMIT_INVALID'
  );
  const expectedHeadSha = lifecycleHeadSha || input.eventHeadSha;
  if (!expectedHeadSha || expectedHeadSha !== pullRequest.headSha) {
    return { action: 'status-skipped', reason: 'stale-event' };
  }
  const desired = decideLifecycleAction({
    eventAction: input.eventAction,
    eventLabelName: input.eventLabelName,
    pullRequest,
  });
  if (desired !== 'reconcile') {
    return { action: 'status-skipped', reason: 'not-reconcile' };
  }
  const succeeded = desired === 'reconcile'
    && env.LIFECYCLE_RESULT === 'success'
    && env.PREVIEW_READY === 'true'
    && env.E2E_RESULT === 'success';
  await github.writeCommitStatus({
    sha: pullRequest.headSha,
    state: succeeded ? 'success' : 'failure',
    description: succeeded
      ? 'Exact-SHA Railway preview and sealed E2E passed.'
      : 'Railway preview lifecycle or sealed E2E failed.',
    targetUrl: env.RUN_URL,
  });
  return {
    action: 'status-written',
    headSha: pullRequest.headSha,
    state: succeeded ? 'success' : 'failure',
  };
}

async function runDiscoverCli(env = process.env) {
  requireCondition(
    env.GITHUB_REPOSITORY === CONTRACT.repository,
    'RAILWAY_PR_PREVIEW_REPOSITORY_MISMATCH'
  );
  const github = new GitHubApi({ token: env.GITHUB_TOKEN });
  const railway = new RailwayGraphqlApi({ token: env.RAILWAY_API_TOKEN });
  const prNumbers = await discoverRailwayPrPreviewNumbers({ github, railway });
  writeGithubOutputs({ pr_numbers: JSON.stringify(prNumbers) }, env.GITHUB_OUTPUT);
  return {
    action: 'discover',
    prNumberCount: prNumbers.length,
  };
}

async function runCli() {
  try {
    const command = process.argv[2] ?? 'event';
    const result = command === 'event'
      ? await runEventCli()
      : command === 'report-status'
        ? await runReportStatusCli()
        : command === 'discover'
          ? await runDiscoverCli()
          : fail('RAILWAY_PR_PREVIEW_COMMAND_INVALID');
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'railway_pr_preview_lifecycle',
      summary: {
        status: 'PASS',
        action: result.action,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.prNumber ? { prNumber: result.prNumber } : {}),
        ...(result.headSha ? { headSha: result.headSha } : {}),
      },
    })}\n`);
  } catch (error) {
    const failure = error instanceof RailwayPrPreviewLifecycleError
      ? error
      : new RailwayPrPreviewLifecycleError('RAILWAY_PR_PREVIEW_UNEXPECTED_FAILURE');
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'railway_pr_preview_lifecycle',
      summary: {
        status: 'FAIL',
        code: failure.code,
      },
    })}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
