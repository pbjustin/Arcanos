import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  GitHubApi,
  RAILWAY_PR_PREVIEW_CONTRACT,
  RailwayGraphqlApi,
  RailwayPrPreviewLifecycleError,
  cleanupRailwayPrPreview,
  decideLifecycleAction,
  discoverRailwayPrPreviewNumbers,
  reconcileRailwayPrPreview,
  validateBasePreviewEnvironment,
  validateLifecycleAuthority,
  validateLifecyclePullRequest,
  validateOwnedPreviewEnvironment,
  validatePreviewDeployment,
} from '../scripts/railway-pr-preview-lifecycle.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const workflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'railway-pr-preview-lifecycle.yml'
);
const reusableWorkflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'railway-pr-preview-run.yml'
);

const CONTRACT = RAILWAY_PR_PREVIEW_CONTRACT;
const PR_NUMBER = 1435;
const HEAD_SHA = 'a'.repeat(40);
const HEAD_REF = 'codex/railway-preview-lifecycle-fixture';
const PREVIEW_REGION = 'us-east4-eqdc4a';
const WORKER_DEPLOYMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WEB_DEPLOYMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const PREVIEW_ENVIRONMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const LIFECYCLE_SECRET_NAME = 'RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pullRequest(overrides = {}) {
  return {
    number: PR_NUMBER,
    state: 'open',
    draft: false,
    base: {
      ref: 'main',
      repo: { full_name: CONTRACT.repository },
    },
    head: {
      ref: HEAD_REF,
      sha: HEAD_SHA,
      repo: { full_name: CONTRACT.repository },
    },
    labels: [{ name: CONTRACT.optInLabel }],
    ...overrides,
  };
}

function deployment({
  id,
  serviceId,
  commitSha = HEAD_SHA,
  status = 'SUCCESS',
  stopped = false,
} = {}) {
  return {
    id,
    projectId: CONTRACT.projectId,
    environmentId: PREVIEW_ENVIRONMENT_ID,
    serviceId,
    status,
    deploymentStopped: stopped,
    meta: {
      repo: CONTRACT.repository,
      commitHash: commitSha,
      configFile: '/railway.json',
      buildOnly: false,
      reason: 'deploy',
      rootDirectory: null,
      volumeMounts: [],
      propertyFileMapping: {
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
      },
      serviceManifest: {
        build: {
          builder: 'DOCKERFILE',
          dockerfilePath: '/Dockerfile',
          buildCommand: CONTRACT.buildCommand,
          buildEnvironment: 'V3',
          watchPatterns: [],
        },
        deploy: {
          startCommand: CONTRACT.previewStartCommand,
          healthcheckPath: '/readyz',
          healthcheckTimeout: 300,
          drainingSeconds: 60,
          restartPolicyType: 'NEVER',
          restartPolicyMaxRetries: null,
          preDeployCommand: null,
          cronSchedule: null,
          runtime: 'V2',
          numReplicas: 1,
          multiRegionConfig: {
            [PREVIEW_REGION]: { numReplicas: 1 },
          },
          requiredMountPath: null,
        },
      },
    },
  };
}

function serviceNode({ role, activeDeployments = [], latestDeployment = null } = {}) {
  const service = CONTRACT.services[role];
  return {
    id: role === 'worker'
      ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    serviceId: service.id,
    serviceName: service.name,
    environmentId: PREVIEW_ENVIRONMENT_ID,
    deletedAt: null,
    source: { repo: CONTRACT.repository, image: null },
    railwayConfigFile: '/railway.json',
    rootDirectory: null,
    dockerfilePath: null,
    startCommand: CONTRACT.baseStartCommand,
    healthcheckPath: '/readyz',
    healthcheckTimeout: 300,
    drainingSeconds: null,
    restartPolicyType: 'NEVER',
    restartPolicyMaxRetries: 10,
    latestDeployment,
    activeDeployments,
    domains: {
      serviceDomains: [{
        id: role === 'worker'
          ? 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
          : 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
        domain: role === 'worker'
          ? `arcanos-worker-${CONTRACT.environmentPrefix}${PR_NUMBER}.up.railway.app`
          : `arcanos-v2-${CONTRACT.environmentPrefix}${PR_NUMBER}.up.railway.app`,
        environmentId: PREVIEW_ENVIRONMENT_ID,
        serviceId: service.id,
        deletedAt: null,
        syncStatus: 'ACTIVE',
      }],
      customDomains: [],
    },
  };
}

function environment({
  triggers = [],
  workerActive = [],
  webActive = [],
  workerLatest = null,
  webLatest = null,
  overrides = {},
} = {}) {
  return {
    id: PREVIEW_ENVIRONMENT_ID,
    name: `${CONTRACT.environmentPrefix}${PR_NUMBER}`,
    projectId: CONTRACT.projectId,
    isEphemeral: true,
    deletedAt: null,
    sourceEnvironment: { id: CONTRACT.baseEnvironmentId },
    meta: null,
    config: {
      groups: {
        [CONTRACT.serviceGroupId]: {
          color: 'blue',
          icon: null,
          isCollapsed: false,
          name: 'arcanos',
        },
      },
      privateNetworkDisabled: false,
      services: {
        [CONTRACT.services.worker.id]: {
          build: {},
          deploy: {
            multiRegionConfig: {
              [PREVIEW_REGION]: { numReplicas: 1 },
            },
          },
          groupId: CONTRACT.serviceGroupId,
          networking: {},
          source: {
            branch: HEAD_REF,
            checkSuites: false,
            repo: CONTRACT.repository,
          },
          variables: {
            ARCANOS_PROCESS_KIND: { value: 'worker' },
          },
        },
        [CONTRACT.services.web.id]: {
          build: {},
          deploy: {
            multiRegionConfig: {
              [PREVIEW_REGION]: { numReplicas: 1 },
            },
          },
          groupId: CONTRACT.serviceGroupId,
          networking: {},
          source: {
            branch: HEAD_REF,
            checkSuites: false,
            repo: CONTRACT.repository,
          },
          variables: {
            ARCANOS_PROCESS_KIND: { value: 'web' },
          },
        },
      },
      sharedVariables: {},
    },
    deploymentTriggers: {
      edges: triggers.map(node => ({ node })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    serviceInstances: {
      edges: [
        { node: serviceNode({ role: 'worker', activeDeployments: workerActive, latestDeployment: workerLatest }) },
        { node: serviceNode({ role: 'web', activeDeployments: webActive, latestDeployment: webLatest }) },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    volumeInstances: {
      edges: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  };
}

function baseEnvironment() {
  const base = environment();
  base.id = CONTRACT.baseEnvironmentId;
  base.name = CONTRACT.baseEnvironmentName;
  base.isEphemeral = false;
  base.sourceEnvironment = { id: CONTRACT.baseSourceEnvironmentId };
  for (const [role, service] of Object.entries(CONTRACT.services)) {
    const serviceConfig = base.config.services[service.id];
    serviceConfig.source = { branch: 'main', repo: CONTRACT.repository };
    const node = base.serviceInstances.edges.find(
      edge => edge.node.serviceId === service.id
    ).node;
    node.id = service.baseInstanceId;
    node.environmentId = CONTRACT.baseEnvironmentId;
    node.railwayConfigFile = null;
    node.domains.serviceDomains[0].environmentId = CONTRACT.baseEnvironmentId;
    node.domains.serviceDomains[0].domain = role === 'worker'
      ? 'arcanos-worker-pr-preview-base-20260812.up.railway.app'
      : 'arcanos-v2-pr-preview-base-20260812.up.railway.app';
  }
  return base;
}

describe('Railway PR preview lifecycle workflow', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8').replaceAll('\r\n', '\n');
  const parsed = yaml.load(workflow);
  const reusableWorkflow = fs
    .readFileSync(reusableWorkflowPath, 'utf8')
    .replaceAll('\r\n', '\n');
  const reusable = yaml.load(reusableWorkflow);

  it('uses a trusted event workflow with an exact opt-in and per-PR non-cancelling lock', () => {
    expect(workflow).toContain('pull_request_target:');
    for (const event of [
      'opened',
      'reopened',
      'ready_for_review',
      'synchronize',
      'labeled',
      'unlabeled',
      'converted_to_draft',
      'edited',
      'closed',
    ]) {
      expect(workflow).toContain(`- ${event}`);
    }
    expect(workflow).toContain('repository_dispatch:');
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).toContain('railway_pr_preview_reconcile');
    expect(workflow).toContain("cron: '23 */6 * * *'");
    expect(reusableWorkflow).toContain('railway-preview');
    expect(parsed.concurrency['cancel-in-progress']).toBe(false);
    expect(parsed.concurrency.group).toContain('railway-pr-preview-lifecycle-');
    const eventLifecycle = parsed.jobs['run-event-preview-lifecycle'];
    expect(eventLifecycle.uses).toBe(
      './.github/workflows/railway-pr-preview-run.yml'
    );
    expect(eventLifecycle.secrets).toEqual({
      [LIFECYCLE_SECRET_NAME]: '${{ secrets.RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN }}',
    });
    const scheduled = parsed.jobs['reconcile-scheduled-previews'];
    expect(scheduled.strategy['fail-fast']).toBe(false);
    expect(scheduled.strategy['max-parallel']).toBe(2);
    expect(scheduled.concurrency.group).toContain('matrix.pr_number');
    expect(scheduled.uses).toBe('./.github/workflows/railway-pr-preview-run.yml');
    expect(scheduled.secrets).toEqual({
      [LIFECYCLE_SECRET_NAME]: '${{ secrets.RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN }}',
    });
    expect(reusable.on.workflow_call.secrets[LIFECYCLE_SECRET_NAME]).toEqual({
      required: true,
    });
    expect(workflow).not.toContain('secrets: inherit');
  });

  it('keeps PR code away from the dedicated Railway credential', () => {
    const lifecycle = reusable.jobs.lifecycle;
    const tokenSteps = lifecycle.steps.filter(
      step => step.env?.RAILWAY_API_TOKEN !== undefined
    );
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps[0].env.RAILWAY_API_TOKEN).toBe(
      '${{ secrets.RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN }}'
    );
    expect(lifecycle.environment).toBe('railway-pr-preview-lifecycle');
    expect(lifecycle.env?.RAILWAY_API_TOKEN).toBeUndefined();
    const lifecycleSource = reusableWorkflow.slice(
      reusableWorkflow.indexOf('  lifecycle:\n'),
      reusableWorkflow.indexOf('\n  preview-e2e:', reusableWorkflow.indexOf('  lifecycle:\n'))
    );
    expect(lifecycleSource).toContain('ref: ${{ github.workflow_sha }}');
    expect(lifecycleSource).toContain('persist-credentials: false');
    expect(lifecycleSource).not.toContain('head-evidence');
    expect(lifecycleSource).not.toContain('npm install');
    expect(lifecycleSource).not.toContain('npm ci');
    expect(lifecycleSource).not.toContain('railway up');
    const discovery = parsed.jobs['discover-scheduled-previews'];
    expect(discovery.environment).toBe('railway-pr-preview-lifecycle');
    expect(discovery.steps.filter(
      step => step.env?.RAILWAY_API_TOKEN !== undefined
    )).toHaveLength(1);
    for (const job of Object.values(reusable.jobs)) {
      const serialized = JSON.stringify(job);
      expect(!(serialized.includes('RAILWAY_API_TOKEN')
        && serialized.includes('head-evidence'))).toBe(true);
    }
  });

  it('runs the trusted 113-request harness against a Railway-secret-free head checkout', () => {
    const e2e = reusable.jobs['preview-e2e'];
    expect(e2e.permissions).toEqual({ contents: 'read' });
    expect(e2e.steps.some(step =>
      step.with?.ref === '${{ needs.lifecycle.outputs.head_sha }}'
      && step.with?.path === 'head-evidence'
      && step.with?.['persist-credentials'] === false)).toBe(true);
    expect(e2e.steps.some(step =>
      step.with?.ref === '${{ github.workflow_sha }}'
      && step.with?.path === 'trusted'
      && step.with?.['persist-credentials'] === false)).toBe(true);
    expect(e2e.steps.some(step =>
      String(step.run ?? '').includes('trusted/scripts/native-pr-preview-e2e.mjs')
      && String(step.run).includes('--git-evidence-root')
      && String(step.run).includes('head-evidence')
      && String(step.run).includes('--execute')
      && String(step.run).includes('--allow-network'))).toBe(true);
    expect(JSON.stringify(e2e)).not.toContain('RAILWAY_API_TOKEN');
    expect(JSON.stringify(e2e)).not.toContain('RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN');
  });

  it('publishes a narrowly scoped head status without Railway authority or PR checkout', () => {
    const reporter = reusable.jobs['report-preview-status'];
    expect(reporter.permissions.statuses).toBe('write');
    expect(reporter.permissions['pull-requests']).toBe('read');
    expect(JSON.stringify(reporter)).not.toContain('RAILWAY_API_TOKEN');
    expect(reporter.steps.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(true);
    expect(reporter.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.ref).toBe(
      '${{ github.workflow_sha }}'
    );
    expect(reporter.steps.some(step =>
      String(step.run ?? '').includes('report-status'))).toBe(true);
  });
});

describe('GitHub PR preview status API', () => {
  const state = 'pending';
  const description = 'Reconciling exact-SHA Railway preview and sealed E2E.';
  const targetUrl = 'https://github.com/pbjustin/Arcanos/actions/runs/123456789';
  const statusUrl = `https://api.github.com/repos/${CONTRACT.repository}/statuses/${HEAD_SHA}`;

  function commitStatusResponse(overrides = {}) {
    return {
      url: statusUrl,
      id: 123456789,
      state,
      description,
      target_url: targetUrl,
      context: CONTRACT.statusContext,
      ...overrides,
    };
  }

  it('accepts GitHub documented commit-status responses without a sha field', async () => {
    let observedRequest;
    const api = new GitHubApi({
      token: 'github-token-for-test-only-000000000000',
      fetchImpl: async (url, init) => {
        observedRequest = { url, init };
        return jsonResponse(commitStatusResponse(), 201);
      },
    });

    await expect(api.writeCommitStatus({
      sha: HEAD_SHA,
      state,
      description,
      targetUrl,
    })).resolves.toBeUndefined();

    expect(observedRequest.url).toBe(statusUrl);
    expect(observedRequest.init.method).toBe('POST');
    expect(JSON.parse(observedRequest.init.body)).toEqual({
      state,
      context: CONTRACT.statusContext,
      description,
      target_url: targetUrl,
    });
  });

  it('rejects a commit-status response for a different exact SHA', async () => {
    const api = new GitHubApi({
      token: 'github-token-for-test-only-000000000000',
      fetchImpl: async () => jsonResponse(commitStatusResponse({
        url: `https://api.github.com/repos/${CONTRACT.repository}/statuses/${'b'.repeat(40)}`,
      }), 201),
    });

    await expect(api.writeCommitStatus({
      sha: HEAD_SHA,
      state,
      description,
      targetUrl,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_STATUS_WRITE_FAILED');
  });
});

describe('Railway PR preview lifecycle policy', () => {
  it('reconciles only an open, ready, same-repository main PR with the opt-in label', () => {
    const pr = validateLifecyclePullRequest(pullRequest(), PR_NUMBER);
    expect(decideLifecycleAction({ eventAction: 'synchronize', pullRequest: pr })).toBe('reconcile');

    expect(decideLifecycleAction({
      eventAction: 'opened',
      pullRequest: validateLifecyclePullRequest(pullRequest({ draft: true }), PR_NUMBER),
    })).toBe('noop');
    expect(decideLifecycleAction({
      eventAction: 'labeled',
      eventLabelName: 'documentation',
      pullRequest: pr,
    })).toBe('reconcile');
  });

  it('cleans up only the exact opt-in lifecycle transitions', () => {
    const closed = validateLifecyclePullRequest(pullRequest({ state: 'closed' }), PR_NUMBER);
    const draft = validateLifecyclePullRequest(pullRequest({ draft: true }), PR_NUMBER);
    const unlabeled = validateLifecyclePullRequest(pullRequest({ labels: [] }), PR_NUMBER);
    const retargeted = validateLifecyclePullRequest(pullRequest({
      base: { ref: 'develop', repo: { full_name: CONTRACT.repository } },
    }), PR_NUMBER);
    expect(decideLifecycleAction({ eventAction: 'closed', pullRequest: closed })).toBe('cleanup');
    expect(decideLifecycleAction({ eventAction: 'converted_to_draft', pullRequest: draft })).toBe('cleanup');
    expect(decideLifecycleAction({
      eventAction: 'unlabeled',
      eventLabelName: CONTRACT.optInLabel,
      pullRequest: unlabeled,
    })).toBe('cleanup');
    expect(decideLifecycleAction({
      eventAction: 'unlabeled',
      eventLabelName: 'documentation',
      pullRequest: unlabeled,
    })).toBe('noop');
    expect(decideLifecycleAction({
      eventAction: 'edited',
      pullRequest: retargeted,
    })).toBe('cleanup');
    expect(decideLifecycleAction({
      eventAction: 'manual',
      pullRequest: retargeted,
    })).toBe('cleanup');
  });

  it('converges stale destructive events against current PR state', () => {
    const reopened = validateLifecyclePullRequest(pullRequest(), PR_NUMBER);
    expect(decideLifecycleAction({
      eventAction: 'closed',
      pullRequest: reopened,
    })).toBe('reconcile');
    expect(decideLifecycleAction({
      eventAction: 'converted_to_draft',
      pullRequest: reopened,
    })).toBe('reconcile');
    expect(decideLifecycleAction({
      eventAction: 'unlabeled',
      eventLabelName: CONTRACT.optInLabel,
      pullRequest: reopened,
    })).toBe('reconcile');
  });

  it.each([
    ['fork', { head: { ref: 'branch', sha: HEAD_SHA, repo: { full_name: 'attacker/fork' } } }],
    ['wrong number', { number: PR_NUMBER + 1 }],
  ])('rejects a %s before provider access', (_name, overrides) => {
    expect(() => validateLifecyclePullRequest(pullRequest(overrides), PR_NUMBER)).toThrow(
      RailwayPrPreviewLifecycleError
    );
  });

  it.each([
    'feature+preview',
    'feature@preview',
    'fix#1435',
    'feature=preview',
    'feature,preview',
    'hello-$USER',
    'feature;preview',
    'feature/雪',
    '-feature',
    '@',
    'feature/foo./bar',
    'a'.repeat(244),
  ])('accepts the Git-valid branch ref %s', (headRef) => {
    const validated = validateLifecyclePullRequest(pullRequest({
      head: {
        ref: headRef,
        sha: HEAD_SHA,
        repo: { full_name: CONTRACT.repository },
      },
    }), PR_NUMBER);

    expect(validated.headRef).toBe(headRef);
  });

  it.each([
    'feature preview',
    'feature..preview',
    'feature@{preview',
    'feature.lock',
    'feature.lock/preview',
    'feature/.hidden',
    'feature//preview',
    'feature~preview',
    'feature^preview',
    'feature:preview',
    'feature?preview',
    'feature*preview',
    'feature[preview',
    'feature\\preview',
    'feature/preview.',
    'refs/heads/feature',
    'a'.repeat(40),
    'a'.repeat(245),
  ])('rejects the Git-invalid branch ref %s', (headRef) => {
    expect(() => validateLifecyclePullRequest(pullRequest({
      head: {
        ref: headRef,
        sha: HEAD_SHA,
        repo: { full_name: CONTRACT.repository },
      },
    }), PR_NUMBER)).toThrow('RAILWAY_PR_PREVIEW_GITHUB_PR_INVALID');
  });

  it('requires coherent exact authority before and after native lifecycle cutover', () => {
    const authority = {
      apiToken: { workspaces: [{ id: CONTRACT.workspaceId }] },
      project: {
        id: CONTRACT.projectId,
        workspaceId: CONTRACT.workspaceId,
        baseEnvironmentId: null,
        primaryEnvironmentId: CONTRACT.productionEnvironmentId,
        prDeploys: false,
      },
    };
    expect(() => validateLifecycleAuthority(authority, { requireNativeDisabled: true })).not.toThrow();
    expect(() => validateLifecycleAuthority(authority, { requireNativeDisabled: false })).not.toThrow();
    const nativeAuthority = {
      ...authority,
      project: {
        ...authority.project,
        baseEnvironmentId: CONTRACT.baseEnvironmentId,
        prDeploys: true,
      },
    };
    expect(() => validateLifecycleAuthority(nativeAuthority, {
      requireNativeDisabled: false,
    })).not.toThrow();
    expect(() => validateLifecycleAuthority(nativeAuthority, {
      requireNativeDisabled: true,
    })).toThrow('RAILWAY_PR_PREVIEW_NATIVE_LIFECYCLE_ENABLED');
    expect(() => validateLifecycleAuthority({
      ...authority,
      project: {
        ...authority.project,
        baseEnvironmentId: CONTRACT.baseEnvironmentId,
      },
    }, { requireNativeDisabled: false })).toThrow('RAILWAY_PR_PREVIEW_AUTHORITY_MISMATCH');
    expect(() => validateLifecycleAuthority({
      ...nativeAuthority,
      project: {
        ...nativeAuthority.project,
        baseEnvironmentId: null,
      },
    }, { requireNativeDisabled: false })).toThrow('RAILWAY_PR_PREVIEW_AUTHORITY_MISMATCH');
  });

  it('attests the exact credential-empty base topology from live provider shape', () => {
    expect(() => validateBasePreviewEnvironment(baseEnvironment())).not.toThrow();
    const wrongAncestor = baseEnvironment();
    wrongAncestor.sourceEnvironment.id = CONTRACT.productionEnvironmentId;
    expect(() => validateBasePreviewEnvironment(wrongAncestor)).toThrow(
      'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
    );
    const wrongRetries = baseEnvironment();
    wrongRetries.serviceInstances.edges[0].node.restartPolicyMaxRetries = 0;
    expect(() => validateBasePreviewEnvironment(wrongRetries)).toThrow(
      'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
    );
  });

  it('rejects base region or replica topology drift', () => {
    const extraRegion = baseEnvironment();
    extraRegion.config.services[CONTRACT.services.worker.id]
      .deploy.multiRegionConfig['us-west2'] = { numReplicas: 1 };
    expect(() => validateBasePreviewEnvironment(extraRegion)).toThrow(
      'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
    );

    const extraReplica = baseEnvironment();
    extraReplica.config.services[CONTRACT.services.web.id]
      .deploy.multiRegionConfig[PREVIEW_REGION].numReplicas = 2;
    expect(() => validateBasePreviewEnvironment(extraReplica)).toThrow(
      'RAILWAY_PR_PREVIEW_BASE_MISMATCH'
    );
  });

  it('accepts only an exact controller-owned, credential-empty two-role environment', () => {
    expect(() => validateOwnedPreviewEnvironment(environment(), {
      headRef: HEAD_REF,
      prNumber: PR_NUMBER,
      requireActiveDomains: true,
    })).not.toThrow();

    const withVolume = environment();
    withVolume.volumeInstances.edges.push({ node: {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.web.id,
      volumeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mountPath: '/data',
      deletedAt: null,
      state: 'READY',
    } });
    expect(() => validateOwnedPreviewEnvironment(withVolume, {
      headRef: HEAD_REF,
      prNumber: PR_NUMBER,
    })).toThrow('RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');

    const withSecret = environment();
    withSecret.config.services[CONTRACT.services.web.id].variables.OPENAI_API_KEY = {
      generator: null,
      value: 'sensitive-test-sentinel',
    };
    expect(() => validateOwnedPreviewEnvironment(withSecret, {
      headRef: HEAD_REF,
      prNumber: PR_NUMBER,
    })).toThrow('RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');

    const withUnexpectedVariableMetadata = environment();
    withUnexpectedVariableMetadata.config.services[CONTRACT.services.web.id]
      .variables.ARCANOS_PROCESS_KIND.generator = null;
    expect(() => validateOwnedPreviewEnvironment(withUnexpectedVariableMetadata, {
      headRef: HEAD_REF,
      prNumber: PR_NUMBER,
    })).toThrow('RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');

    const withForeignTrigger = environment({ triggers: [{
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      projectId: CONTRACT.projectId,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.web.id,
      repository: 'attacker/fork',
      branch: 'main',
      provider: 'github',
      checkSuites: false,
    }] });
    expect(() => validateOwnedPreviewEnvironment(withForeignTrigger, {
      headRef: pullRequest().head.ref,
      prNumber: PR_NUMBER,
    })).toThrow('RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');

    const withNearMissDomain = environment();
    withNearMissDomain.serviceInstances.edges[0].node.domains.serviceDomains[0].domain =
      `arcanos-worker-pr-676862-${PR_NUMBER}.up.railway.app`;
    expect(() => validateOwnedPreviewEnvironment(withNearMissDomain, {
      headRef: HEAD_REF,
      prNumber: PR_NUMBER,
    })).toThrow('RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');
  });

  it('attests exact deployment identity and PR-safe manifest', () => {
    expect(() => validatePreviewDeployment(deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    }), {
      deploymentId: WORKER_DEPLOYMENT_ID,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      commitSha: HEAD_SHA,
    })).not.toThrow();

    const unsafe = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    unsafe.meta.serviceManifest.deploy.startCommand = 'npm start';
    expect(() => validatePreviewDeployment(unsafe, {
      deploymentId: WORKER_DEPLOYMENT_ID,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      commitSha: HEAD_SHA,
    })).toThrow('RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  });

  it('rejects unexpected deployment property mapping keys', () => {
    const unexpectedMapping = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    unexpectedMapping.meta.propertyFileMapping['deploy.numReplicas'] =
      '$.environments.pr.deploy.numReplicas';

    expect(() => validatePreviewDeployment(unexpectedMapping, {
      deploymentId: WORKER_DEPLOYMENT_ID,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      commitSha: HEAD_SHA,
    })).toThrow('RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  });

  it('rejects realized deployment region or replica topology drift', () => {
    const extraRegion = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    extraRegion.meta.serviceManifest.deploy.multiRegionConfig['us-west2'] = {
      numReplicas: 1,
    };
    expect(() => validatePreviewDeployment(extraRegion, {
      deploymentId: WORKER_DEPLOYMENT_ID,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      commitSha: HEAD_SHA,
    })).toThrow('RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');

    const extraReplica = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    extraReplica.meta.serviceManifest.deploy
      .multiRegionConfig[PREVIEW_REGION].numReplicas = 2;
    expect(() => validatePreviewDeployment(extraReplica, {
      deploymentId: WORKER_DEPLOYMENT_ID,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      commitSha: HEAD_SHA,
    })).toThrow('RAILWAY_PR_PREVIEW_DEPLOYMENT_MISMATCH');
  });

  it('ignores a newer failed latest record when the sole active deployment is exact', async () => {
    const worker = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    const web = deployment({
      id: WEB_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.web.id,
    });
    const failedLatest = deployment({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      serviceId: CONTRACT.services.worker.id,
      status: 'FAILED',
      stopped: true,
    });
    const active = environment({
      workerActive: [worker],
      webActive: [web],
      workerLatest: failedLatest,
      webLatest: web,
    });
    const calls = [];
    const railway = {
      async validateAuthority(options) {
        expect(options).toEqual({ requireNativeDisabled: true });
        calls.push('authority');
      },
      async readBaseEnvironment() { calls.push('base'); return { valid: true }; },
      validateBaseEnvironment(base) { expect(base).toEqual({ valid: true }); },
      async listEnvironments() { calls.push('list'); return [active]; },
      async readEnvironment() { calls.push('environment'); return active; },
      async removeAndVerifyTriggers() { calls.push('triggers'); },
      async deployExact() { throw new Error('Exact active pair must not redeploy.'); },
      async readReadiness({ role }) {
        calls.push(`readiness:${role}`);
        return role === 'worker'
          ? {
              ready: true,
              mode: 'passive-pr-preview',
              processKind: 'worker',
              prNumber: PR_NUMBER,
              sourceCommit: HEAD_SHA,
            }
          : {
              ready: true,
              mode: 'native-pr-application-e2e-v1',
              processKind: 'web',
              prNumber: PR_NUMBER,
              sourceCommit: HEAD_SHA,
              applicationImported: true,
              fixturesSealed: true,
              protectedEffectsEnabled: false,
              protectsMaliciousPr: false,
              requiresPlatformSecretIsolationForUntrustedCode: true,
            };
      },
    };

    const result = await reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () => {
        calls.push('github');
        return validateLifecyclePullRequest(pullRequest(), PR_NUMBER);
      },
    });

    expect(result).toMatchObject({
      action: 'reconcile',
      headSha: HEAD_SHA,
      workerDeploymentId: WORKER_DEPLOYMENT_ID,
      webDeploymentId: WEB_DEPLOYMENT_ID,
    });
    expect(calls).not.toContain('deploy');
    expect(calls).toEqual(expect.arrayContaining([
      'authority',
      'base',
      'triggers',
      'readiness:worker',
      'readiness:web',
    ]));
  });

  it('resumes an exact pending worker deployment without enqueueing a duplicate', async () => {
    const pendingWorker = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      status: 'BUILDING',
      stopped: true,
    });
    const activeWorker = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    const activeWeb = deployment({
      id: WEB_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.web.id,
    });
    let current = environment({
      workerLatest: pendingWorker,
    });
    const calls = [];
    const railway = {
      async validateAuthority() {},
      async readBaseEnvironment() { return { valid: true }; },
      validateBaseEnvironment() {},
      async listEnvironments() { return [current]; },
      async readEnvironment() { return current; },
      async removeAndVerifyTriggers() {},
      async deployExact() { throw new Error('must not enqueue a duplicate'); },
      async waitForDeployment({ deploymentId }) {
        calls.push(`wait:${deploymentId}`);
        current = environment({
          workerActive: [activeWorker],
          workerLatest: activeWorker,
          webActive: [activeWeb],
          webLatest: activeWeb,
        });
        return activeWorker;
      },
      async readReadiness({ role }) {
        return role === 'worker'
          ? {
              ready: true,
              mode: 'passive-pr-preview',
              processKind: 'worker',
              prNumber: PR_NUMBER,
              sourceCommit: HEAD_SHA,
            }
          : {
              ready: true,
              mode: 'native-pr-application-e2e-v1',
              processKind: 'web',
              prNumber: PR_NUMBER,
              sourceCommit: HEAD_SHA,
              applicationImported: true,
              fixturesSealed: true,
              protectedEffectsEnabled: false,
              protectsMaliciousPr: false,
              requiresPlatformSecretIsolationForUntrustedCode: true,
            };
      },
    };

    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).resolves.toMatchObject({
      workerDeploymentId: WORKER_DEPLOYMENT_ID,
      webDeploymentId: WEB_DEPLOYMENT_ID,
    });
    expect(calls).toEqual([`wait:${WORKER_DEPLOYMENT_ID}`]);
  });

  it('fails closed on a pending deployment for a different head', async () => {
    const foreignPending = deployment({
      id: WORKER_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      commitSha: 'b'.repeat(40),
      status: 'DEPLOYING',
      stopped: true,
    });
    const current = environment({ workerLatest: foreignPending });
    let deployed = false;
    const railway = {
      async validateAuthority() {},
      async readBaseEnvironment() { return { valid: true }; },
      validateBaseEnvironment() {},
      async listEnvironments() { return [current]; },
      async readEnvironment() { return current; },
      async removeAndVerifyTriggers() {},
      async deployExact() { deployed = true; return WORKER_DEPLOYMENT_ID; },
    };

    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_DEPLOYMENT_CONFLICT');
    expect(deployed).toBe(false);
  });

  it('rejects an exact web deployment before the worker is active', async () => {
    const pendingWeb = deployment({
      id: WEB_DEPLOYMENT_ID,
      serviceId: CONTRACT.services.web.id,
      status: 'BUILDING',
      stopped: true,
    });
    const current = environment({ webLatest: pendingWeb });
    let deployed = false;
    const railway = {
      async validateAuthority() {},
      async readBaseEnvironment() { return { valid: true }; },
      validateBaseEnvironment() {},
      async listEnvironments() { return [current]; },
      async readEnvironment() { return current; },
      async removeAndVerifyTriggers() {},
      async deployExact() { deployed = true; return WORKER_DEPLOYMENT_ID; },
    };

    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_WORKER_FIRST_CONFLICT');
    expect(deployed).toBe(false);
  });

  it('fails closed when a cloned trigger survives the quiescence readback', async () => {
    const trigger = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      projectId: CONTRACT.projectId,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      repository: CONTRACT.repository,
      branch: HEAD_REF,
      provider: 'github',
      checkSuites: false,
    };
    const current = environment({ triggers: [trigger] });
    let deployed = false;
    const railway = {
      async validateAuthority() {},
      async readBaseEnvironment() { return { valid: true }; },
      validateBaseEnvironment() {},
      async listEnvironments() { return [current]; },
      async readEnvironment() { return current; },
      async removeAndVerifyTriggers() {},
      async deployExact() { deployed = true; return WORKER_DEPLOYMENT_ID; },
    };

    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_TRIGGER_REAPPEARED');
    expect(deployed).toBe(false);
  });

  it('deletes a newly created environment when trigger quiescence fails', async () => {
    const created = environment();
    let inventoryReads = 0;
    let deletedId;
    let createInput;
    const railway = {
      async validateAuthority() {},
      async readBaseEnvironment() { return { valid: true }; },
      validateBaseEnvironment() {},
      async listEnvironments() {
        inventoryReads += 1;
        return inventoryReads === 1 ? [] : [created];
      },
      async createEnvironment(input) {
        createInput = input;
        return {
          id: created.id,
          name: created.name,
          projectId: CONTRACT.projectId,
          isEphemeral: true,
          sourceEnvironment: { id: CONTRACT.baseEnvironmentId },
        };
      },
      async readEnvironment() { return created; },
      async removeAndVerifyTriggers() {
        throw new RailwayPrPreviewLifecycleError(
          'RAILWAY_PR_PREVIEW_TRIGGER_DELETE_FAILED'
        );
      },
      async deleteAndVerifyEnvironment(target) { deletedId = target.id; },
    };

    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_TRIGGER_DELETE_FAILED');
    expect(createInput).toEqual({
      applyChangesInBackground: false,
      ephemeral: true,
      name: `${CONTRACT.environmentPrefix}${PR_NUMBER}`,
      projectId: CONTRACT.projectId,
      skipInitialDeploys: true,
      sourceEnvironmentId: CONTRACT.baseEnvironmentId,
      stageInitialChanges: false,
    });
    expect(deletedId).toBe(PREVIEW_ENVIRONMENT_ID);
  });

  it('does not create a preview after the PR is retargeted away from main', async () => {
    let created = false;
    const retargeted = validateLifecyclePullRequest(pullRequest({
      base: { ref: 'develop', repo: { full_name: CONTRACT.repository } },
    }), PR_NUMBER);
    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway: {
        async validateAuthority(options) {
          expect(options).toEqual({ requireNativeDisabled: true });
        },
        async readBaseEnvironment() { return { valid: true }; },
        validateBaseEnvironment() {},
        async listEnvironments() { return []; },
        async createEnvironment() { created = true; },
      },
      verifyCurrentPullRequest: async () => retargeted,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_GITHUB_STATE_CHANGED');
    expect(created).toBe(false);
  });

  it('deploys worker first and never enqueues web after worker failure', async () => {
    const empty = environment();
    const calls = [];
    const railway = {
      async validateAuthority() { calls.push('authority'); },
      async readBaseEnvironment() { return { valid: true }; },
      validateBaseEnvironment() {},
      async listEnvironments() { return [empty]; },
      async readEnvironment() { return empty; },
      async removeAndVerifyTriggers() { calls.push('triggers'); },
      async deployExact({ serviceId }) {
        calls.push(`deploy:${serviceId}`);
        if (serviceId === CONTRACT.services.worker.id) {
          throw new RailwayPrPreviewLifecycleError('RAILWAY_PR_PREVIEW_DEPLOYMENT_FAILED');
        }
        return WEB_DEPLOYMENT_ID;
      },
    };

    await expect(reconcileRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
      railway,
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_DEPLOYMENT_FAILED');

    expect(calls).toContain(`deploy:${CONTRACT.services.worker.id}`);
    expect(calls).not.toContain(`deploy:${CONTRACT.services.web.id}`);
  });

  it('discovers only exact opt-in PRs and controller-owned environments', async () => {
    const numbers = await discoverRailwayPrPreviewNumbers({
      github: {
        async listOpenPullRequests() {
          return [
            pullRequest(),
            pullRequest({
              number: PR_NUMBER + 1,
              labels: [{ name: 'documentation' }],
            }),
            pullRequest({
              number: PR_NUMBER + 2,
              head: {
                ref: 'fork',
                sha: 'b'.repeat(40),
                repo: { full_name: 'attacker/fork' },
              },
            }),
          ];
        },
      },
      railway: {
        async validateAuthority(options) {
          expect(options).toEqual({ requireNativeDisabled: false });
        },
        async listEnvironments() {
          return [
            {
              id: PREVIEW_ENVIRONMENT_ID,
              name: `${CONTRACT.environmentPrefix}${PR_NUMBER + 3}`,
              projectId: CONTRACT.projectId,
            },
            {
              id: CONTRACT.baseEnvironmentId,
              name: CONTRACT.baseEnvironmentName,
              projectId: CONTRACT.projectId,
            },
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              name: `Arcanos-pr-${PR_NUMBER + 4}`,
              projectId: CONTRACT.projectId,
            },
          ];
        },
      },
    });

    expect(numbers).toEqual([PR_NUMBER, PR_NUMBER + 3]);
  });

  it('does not delete after an ineligible PR becomes eligible again', async () => {
    const target = environment();
    let deleted = false;
    const closed = validateLifecyclePullRequest(
      pullRequest({ state: 'closed' }),
      PR_NUMBER
    );
    await expect(cleanupRailwayPrPreview({
      pullRequest: closed,
      railway: {
        async validateAuthority() {},
        async listEnvironments() { return [target]; },
        async readEnvironment() { return target; },
        async deleteAndVerifyEnvironment() { deleted = true; },
      },
      verifyCurrentPullRequest: async () =>
        validateLifecyclePullRequest(pullRequest(), PR_NUMBER),
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_GITHUB_STATE_CHANGED');
    expect(deleted).toBe(false);
  });

  it('cleans an exact owned preview after the PR is retargeted away from main', async () => {
    const target = environment();
    const retargeted = validateLifecyclePullRequest(pullRequest({
      base: { ref: 'develop', repo: { full_name: CONTRACT.repository } },
    }), PR_NUMBER);
    let deletedId;
    await expect(cleanupRailwayPrPreview({
      pullRequest: retargeted,
      railway: {
        async validateAuthority(options) {
          expect(options).toEqual({ requireNativeDisabled: false });
        },
        async listEnvironments() { return [target]; },
        async readEnvironment() { return target; },
        async deleteAndVerifyEnvironment(item) { deletedId = item.id; },
      },
      verifyCurrentPullRequest: async () => retargeted,
    })).resolves.toMatchObject({ action: 'cleanup', deleted: true });
    expect(deletedId).toBe(PREVIEW_ENVIRONMENT_ID);
  });

  it('can clean a controller-owned environment after the PR branch is renamed', async () => {
    const target = environment({ triggers: [{
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      projectId: CONTRACT.projectId,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
      repository: CONTRACT.repository,
      branch: 'renamed#branch',
      provider: 'github',
      checkSuites: false,
    }] });
    target.config.services[CONTRACT.services.worker.id].source.branch = 'renamed+branch';
    target.config.services[CONTRACT.services.web.id].source.branch = 'renamed+branch';
    let deletedId;
    const closed = validateLifecyclePullRequest(
      pullRequest({ state: 'closed', head: {
        ref: 'new@branch-name',
        sha: HEAD_SHA,
        repo: { full_name: CONTRACT.repository },
      } }),
      PR_NUMBER
    );
    await expect(cleanupRailwayPrPreview({
      pullRequest: closed,
      railway: {
        async validateAuthority() {},
        async listEnvironments() { return [target]; },
        async readEnvironment() { return target; },
        async deleteAndVerifyEnvironment(item) { deletedId = item.id; },
      },
      verifyCurrentPullRequest: async () => closed,
    })).resolves.toMatchObject({ deleted: true });
    expect(deletedId).toBe(PREVIEW_ENVIRONMENT_ID);
  });

  it('rejects malformed branch identity during cleanup', async () => {
    const target = environment();
    target.config.services[CONTRACT.services.worker.id].source.branch = 123;
    let deleted = false;
    const closed = validateLifecyclePullRequest(
      pullRequest({ state: 'closed' }),
      PR_NUMBER
    );
    await expect(cleanupRailwayPrPreview({
      pullRequest: closed,
      railway: {
        async validateAuthority() {},
        async listEnvironments() { return [target]; },
        async readEnvironment() { return target; },
        async deleteAndVerifyEnvironment() { deleted = true; },
      },
      verifyCurrentPullRequest: async () => closed,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_OWNERSHIP_MISMATCH');
    expect(deleted).toBe(false);
  });
});

describe('Railway PR preview lifecycle provider client', () => {
  const safeCreateInput = () => ({
    projectId: CONTRACT.projectId,
    name: `${CONTRACT.environmentPrefix}${PR_NUMBER}`,
    sourceEnvironmentId: CONTRACT.baseEnvironmentId,
    ephemeral: true,
    skipInitialDeploys: true,
    stageInitialChanges: false,
    applyChangesInBackground: false,
  });

  it('uses the exact safe clone flags and exact-SHA deployment mutation', async () => {
    const requests = [];
    const api = new RailwayGraphqlApi({
      token: 'workspace-token-for-test-only-000000000000',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push({ request, options });
        if (request.query.includes('CreatePreviewLifecycleEnvironment')) {
          return jsonResponse({ data: { environmentCreate: {
            id: PREVIEW_ENVIRONMENT_ID,
            name: `${CONTRACT.environmentPrefix}${PR_NUMBER}`,
            projectId: CONTRACT.projectId,
            isEphemeral: true,
            sourceEnvironment: { id: CONTRACT.baseEnvironmentId },
          } } });
        }
        if (request.query.includes('DeployPreviewLifecycleService')) {
          return jsonResponse({ data: {
            serviceInstanceDeployV2: WORKER_DEPLOYMENT_ID,
          } });
        }
        throw new Error('Unexpected operation.');
      },
    });

    const input = safeCreateInput();
    await expect(api.createEnvironment(input)).resolves.toMatchObject({
      id: PREVIEW_ENVIRONMENT_ID,
    });
    await expect(api.deployExact({
      commitSha: HEAD_SHA,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    })).resolves.toBe(WORKER_DEPLOYMENT_ID);

    expect(requests[0].request.variables).toEqual({ input });
    expect(requests[1].request.variables).toEqual({
      commitSha: HEAD_SHA,
      environmentId: PREVIEW_ENVIRONMENT_ID,
      serviceId: CONTRACT.services.worker.id,
    });
    for (const { options } of requests) {
      expect(options.redirect).toBe('error');
      expect(options.headers.authorization).toBe(
        'Bearer workspace-token-for-test-only-000000000000'
      );
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('rejects an account-wide token before any project operation', async () => {
    const operations = [];
    const api = new RailwayGraphqlApi({
      token: 'account-token-for-test-only-0000000000000',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        operations.push(request.query);
        return jsonResponse({ data: { me: { id: 'account-user' } } });
      },
    });

    await expect(api.validateAuthority({
      requireNativeDisabled: true,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_ACCOUNT_TOKEN_FORBIDDEN');
    expect(operations).toHaveLength(1);
    expect(operations[0]).toContain('PreviewLifecycleTokenType');
  });

  it('caps provider responses without exposing the provider body', async () => {
    const oversized = JSON.stringify({
      data: { padding: 'x'.repeat(2 * 1024 * 1024) },
    });
    const api = new RailwayGraphqlApi({
      token: 'workspace-token-for-test-only-000000000000',
      fetchImpl: async () => new Response(oversized, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    await expect(api.createEnvironment(safeCreateInput())).rejects.toThrow(
      'RAILWAY_PR_PREVIEW_API_FAILED'
    );
  });

  it('rejects unsafe create, deploy, and delete targets before provider access', async () => {
    let requests = 0;
    const api = new RailwayGraphqlApi({
      token: 'workspace-token-for-test-only-000000000000',
      fetchImpl: async () => {
        requests += 1;
        throw new Error('Provider access should not occur.');
      },
    });

    await expect(api.createEnvironment({
      ...safeCreateInput(),
      skipInitialDeploys: false,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_CREATE_INPUT_INVALID');
    for (const environmentId of [
      CONTRACT.baseEnvironmentId,
      CONTRACT.productionEnvironmentId,
    ]) {
      await expect(api.deployExact({
        commitSha: HEAD_SHA,
        environmentId,
        serviceId: CONTRACT.services.worker.id,
      })).rejects.toThrow('RAILWAY_PR_PREVIEW_DEPLOY_TARGET_INVALID');
    }
    await expect(api.deleteAndVerifyEnvironment({
      ...environment(),
      name: `Arcanos-pr-${PR_NUMBER}`,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_DELETE_TARGET_INVALID');
    expect(requests).toBe(0);
  });

  it('fails closed when cleanup identity is ambiguous', async () => {
    const target = environment();
    const railway = {
      async validateAuthority() {},
      async listEnvironments() { return [target, { ...target, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }]; },
      async readEnvironment() { throw new Error('Ambiguity reached target read.'); },
      async deleteAndVerifyEnvironment() { throw new Error('Ambiguity reached deletion.'); },
    };

    const { cleanupRailwayPrPreview } = await import(
      '../scripts/railway-pr-preview-lifecycle.mjs'
    );
    await expect(cleanupRailwayPrPreview({
      pullRequest: validateLifecyclePullRequest(pullRequest({ state: 'closed' }), PR_NUMBER),
      railway,
    })).rejects.toThrow('RAILWAY_PR_PREVIEW_ENVIRONMENT_AMBIGUOUS');
  });
});
