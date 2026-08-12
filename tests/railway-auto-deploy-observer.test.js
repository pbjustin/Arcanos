import { describe, expect, it, jest } from '@jest/globals';
import {
  DEPLOYMENT_OBSERVATION_LIST_LIMIT,
  DEPLOYMENT_OBSERVATION_TIMEOUT_MS,
  DEPLOYMENT_POLL_INTERVAL_MS,
  RAILWAY_COMMAND_LIMITS,
  classifyDeploymentStatus,
  enqueueDeployment,
  main,
  readActiveDeploymentId,
  readRailwayVariables,
  runBoundedRailwayCommand,
  verifyActiveDeployment,
  waitForDeploymentSuccess,
} from '../scripts/railway-auto-deploy-observer.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const FAILED_DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';
const ENVIRONMENT_ID = '55555555-5555-4555-8555-555555555555';
const SERVICE_INSTANCE_ID = '66666666-6666-4666-8666-666666666666';
const DECOY_ENVIRONMENT_ID = '77777777-7777-4777-8777-777777777777';
const DECOY_SERVICE_ID = '88888888-8888-4888-8888-888888888888';
const DECOY_SERVICE_INSTANCE_ID = '99999999-9999-4999-8999-999999999999';
const DEPLOY_REF = 'a'.repeat(40);
const ENVIRONMENT_NAME = 'production';

const target = {
  serviceId: SERVICE_ID,
  environmentName: ENVIRONMENT_NAME,
};

function deploymentList(status, deploymentId = DEPLOYMENT_ID) {
  return JSON.stringify([{ id: deploymentId, status }]);
}

function projectStatusFixture() {
  return {
    id: PROJECT_ID,
    deletedAt: null,
    services: {
      edges: [
        { node: { id: DECOY_SERVICE_ID, name: 'decoy' } },
        { node: { id: SERVICE_ID, name: 'ARCANOS Worker' } },
      ],
    },
    environments: {
      edges: [
        {
          node: {
            id: DECOY_ENVIRONMENT_ID,
            name: 'development',
            canAccess: true,
            deletedAt: null,
            serviceInstances: { edges: [] },
          },
        },
        {
          node: {
            id: ENVIRONMENT_ID,
            name: ENVIRONMENT_NAME,
            canAccess: true,
            deletedAt: null,
            serviceInstances: {
              edges: [
                {
                  node: {
                    id: DECOY_SERVICE_INSTANCE_ID,
                    serviceId: DECOY_SERVICE_ID,
                    serviceName: 'decoy',
                    environmentId: ENVIRONMENT_ID,
                    latestDeployment: null,
                    activeDeployments: [],
                  },
                },
                {
                  node: {
                    id: SERVICE_INSTANCE_ID,
                    serviceId: SERVICE_ID,
                    serviceName: 'ARCANOS Worker',
                    environmentId: ENVIRONMENT_ID,
                    latestDeployment: {
                      id: FAILED_DEPLOYMENT_ID,
                      status: 'FAILED',
                      deploymentStopped: true,
                    },
                    activeDeployments: [
                      {
                        id: DEPLOYMENT_ID,
                        status: 'SUCCESS',
                        createdAt: '2026-08-11T21:00:00.000Z',
                        meta: { omittedFromErrors: 'sensitive provider metadata' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  };
}

function targetEnvironmentNode(status) {
  return status.environments.edges[1].node;
}

function targetServiceNode(status) {
  return targetEnvironmentNode(status).serviceInstances.edges[1].node;
}

describe('Railway bounded command execution', () => {
  it('enforces the requested timeout and output cap without a shell', async () => {
    const execFileImplementation = jest.fn(
      (file, args, options, callback) => {
        callback(null, 'bounded-output', '');
      },
    );

    await expect(
      runBoundedRailwayCommand(
        ['deployment', 'list'],
        { timeoutMs: 12_345, maxBufferBytes: 65_536 },
        { execFileImplementation },
      ),
    ).resolves.toBe('bounded-output');

    expect(execFileImplementation).toHaveBeenCalledWith(
      'railway',
      ['deployment', 'list'],
      expect.objectContaining({
        encoding: 'utf8',
        maxBuffer: 65_536,
        shell: false,
        timeout: 12_345,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });

  it('fails with sanitized timeout and output-limit errors', async () => {
    const timeoutError = Object.assign(new Error('secret provider details'), {
      killed: true,
      signal: 'SIGKILL',
    });
    const overflowError = Object.assign(new Error('stdout maxBuffer exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const timeoutExec = jest.fn((_file, _args, _options, callback) => {
      callback(timeoutError, '', 'sensitive stderr');
    });
    const overflowExec = jest.fn((_file, _args, _options, callback) => {
      callback(overflowError, 'oversized output', 'sensitive stderr');
    });

    await expect(
      runBoundedRailwayCommand(
        ['deployment', 'list'],
        { timeoutMs: 30_000, maxBufferBytes: 65_536 },
        { execFileImplementation: timeoutExec },
      ),
    ).rejects.toMatchObject({
      code: 'RAILWAY_COMMAND_TIMEOUT',
      message: 'RAILWAY_COMMAND_TIMEOUT',
    });
    await expect(
      runBoundedRailwayCommand(
        ['deployment', 'list'],
        { timeoutMs: 30_000, maxBufferBytes: 65_536 },
        { execFileImplementation: overflowExec },
      ),
    ).rejects.toMatchObject({
      code: 'RAILWAY_COMMAND_OUTPUT_LIMIT',
      message: 'RAILWAY_COMMAND_OUTPUT_LIMIT',
    });
  });
});

describe('Railway detached upload', () => {
  it('queues one detached upload and returns its validated exact ID', async () => {
    const runCommand = jest.fn(async () =>
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        logsUrl: 'https://railway.example/deployment',
      }),
    );

    await expect(
      enqueueDeployment(
        {
          projectId: PROJECT_ID,
          ...target,
          deployRef: DEPLOY_REF,
        },
        { runCommand },
      ),
    ).resolves.toBe(DEPLOYMENT_ID);

    expect(runCommand).toHaveBeenCalledWith(
      [
        'up',
        '--ci',
        '--detach',
        '--json',
        '--project',
        PROJECT_ID,
        '--environment',
        ENVIRONMENT_NAME,
        '--service',
        SERVICE_ID,
        '--message',
        `GitHub auto deploy ${DEPLOY_REF}`,
      ],
      RAILWAY_COMMAND_LIMITS.enqueue,
    );
  });

  it.each([
    ['malformed JSON', '{'],
    ['missing ID', JSON.stringify({ logsUrl: 'https://railway.example' })],
    ['invalid ID', JSON.stringify({ deploymentId: 'latest' })],
    [
      'multiple JSON values',
      `${JSON.stringify({ deploymentId: DEPLOYMENT_ID })}\n{}`,
    ],
  ])('rejects %s from the upload response', async (_label, output) => {
    await expect(
      enqueueDeployment(
        {
          projectId: PROJECT_ID,
          ...target,
          deployRef: DEPLOY_REF,
        },
        { runCommand: async () => output },
      ),
    ).rejects.toThrow('RAILWAY_DEPLOYMENT_RESPONSE_INVALID');
  });
});

describe('Railway exact-deployment observation', () => {
  it.each([
    'INITIALIZING',
    'QUEUED',
    'BUILDING',
    'DEPLOYING',
    'WAITING',
    'NEEDS_APPROVAL',
  ])('classifies %s as pending', status => {
    expect(classifyDeploymentStatus(status)).toBe('pending');
  });

  it('classifies SUCCESS as success', () => {
    expect(classifyDeploymentStatus('SUCCESS')).toBe('success');
  });

  it.each([
    'FAILED',
    'CRASHED',
    'REMOVED',
    'REMOVING',
    'SKIPPED',
    'SLEEPING',
  ])('classifies %s as a terminal failure', status => {
    expect(classifyDeploymentStatus(status)).toBe('failure');
  });

  it.each(['STOPPED', 'CANCELLED', 'success', '', null])(
    'fails closed for unknown status %p',
    status => {
      expect(() => classifyDeploymentStatus(status)).toThrow(
        'RAILWAY_DEPLOYMENT_STATUS_UNKNOWN',
      );
    },
  );

  it('retries NOT_FOUND and every pending state until exact-ID success', async () => {
    let clockMs = 0;
    const statuses = [
      'NOT_FOUND',
      'INITIALIZING',
      'QUEUED',
      'BUILDING',
      'DEPLOYING',
      'WAITING',
      'NEEDS_APPROVAL',
      'SUCCESS',
    ];
    const runCommand = jest.fn(async (_args, limits) => {
      expect(limits.maxBufferBytes).toBe(
        RAILWAY_COMMAND_LIMITS.deploymentList.maxBufferBytes,
      );
      expect(limits.timeoutMs).toBeLessThanOrEqual(
        RAILWAY_COMMAND_LIMITS.deploymentList.timeoutMs,
      );
      clockMs += 100;
      const status = statuses.shift();
      return status === 'NOT_FOUND' ? '[]' : deploymentList(status);
    });
    const sleep = jest.fn(async delayMs => {
      clockMs += delayMs;
    });
    const onStatus = jest.fn();

    await expect(
      waitForDeploymentSuccess(
        { deploymentId: DEPLOYMENT_ID, ...target },
        {
          runCommand,
          now: () => clockMs,
          sleep,
          onStatus,
        },
      ),
    ).resolves.toBe('SUCCESS');

    expect(runCommand).toHaveBeenCalledTimes(8);
    expect(runCommand.mock.calls[0][0]).toEqual([
      'deployment',
      'list',
      '--service',
      SERVICE_ID,
      '--environment',
      ENVIRONMENT_NAME,
      '--limit',
      String(DEPLOYMENT_OBSERVATION_LIST_LIMIT),
      '--json',
    ]);
    expect(sleep).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledWith(DEPLOYMENT_POLL_INTERVAL_MS);
    expect(onStatus.mock.calls.map(call => call[0].status)).toEqual([
      'NOT_FOUND',
      'INITIALIZING',
      'QUEUED',
      'BUILDING',
      'DEPLOYING',
      'WAITING',
      'NEEDS_APPROVAL',
      'SUCCESS',
    ]);
  });

  it.each([
    'FAILED',
    'CRASHED',
    'REMOVED',
    'REMOVING',
    'SKIPPED',
    'SLEEPING',
  ])('rejects exact deployment terminal state %s', async status => {
    await expect(
      waitForDeploymentSuccess(
        { deploymentId: DEPLOYMENT_ID, ...target },
        {
          runCommand: async () => deploymentList(status),
          onStatus: () => {},
        },
      ),
    ).rejects.toThrow(`RAILWAY_DEPLOYMENT_TERMINAL_FAILURE:${status}`);
  });

  it('counts Railway CLI execution time against the wall-clock deadline', async () => {
    let clockMs = 0;

    await expect(
      waitForDeploymentSuccess(
        { deploymentId: DEPLOYMENT_ID, ...target },
        {
          runCommand: async () => {
            clockMs += DEPLOYMENT_OBSERVATION_TIMEOUT_MS;
            return deploymentList('SUCCESS');
          },
          now: () => clockMs,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow('RAILWAY_DEPLOYMENT_OBSERVATION_TIMEOUT');
  });

  it('fails closed if an injected clock moves backward', async () => {
    const readings = [1_000, 1_000, 900];

    await expect(
      waitForDeploymentSuccess(
        { deploymentId: DEPLOYMENT_ID, ...target },
        {
          runCommand: async () => deploymentList('BUILDING'),
          now: () => readings.shift(),
          sleep: async () => {},
          onStatus: () => {},
        },
      ),
    ).rejects.toThrow('RAILWAY_OBSERVATION_CLOCK_INVALID');
  });

  it('rejects an unknown exact-deployment status', async () => {
    await expect(
      waitForDeploymentSuccess(
        { deploymentId: DEPLOYMENT_ID, ...target },
        { runCommand: async () => deploymentList('PAUSED_BY_PROVIDER') },
      ),
    ).rejects.toThrow('RAILWAY_DEPLOYMENT_STATUS_UNKNOWN');
  });

  it.each([
    ['malformed JSON', '{'],
    ['non-array JSON', '{}'],
    [
      'duplicate exact IDs',
      JSON.stringify([
        { id: DEPLOYMENT_ID, status: 'BUILDING' },
        { id: DEPLOYMENT_ID, status: 'SUCCESS' },
      ]),
    ],
  ])('rejects %s deployment-list evidence', async (_label, output) => {
    await expect(
      waitForDeploymentSuccess(
        { deploymentId: DEPLOYMENT_ID, ...target },
        { runCommand: async () => output },
      ),
    ).rejects.toThrow('RAILWAY_DEPLOYMENT_LIST_INVALID');
  });
});

describe('Railway bounded activation evidence', () => {
  it('captures the sole active SUCCESS when a newer latest deployment failed', async () => {
    const runCommand = jest.fn(async () => JSON.stringify(projectStatusFixture()));

    await expect(
      readActiveDeploymentId({ projectId: PROJECT_ID, ...target }, { runCommand }),
    ).resolves.toBe(DEPLOYMENT_ID);
    expect(runCommand).toHaveBeenCalledWith(
      ['status', '--json'],
      RAILWAY_COMMAND_LIMITS.projectStatus,
    );
  });

  it('rejects an invalid expected project before reading Railway state', async () => {
    const runCommand = jest.fn();

    await expect(
      readActiveDeploymentId({ projectId: 'current', ...target }, { runCommand }),
    ).rejects.toThrow('RAILWAY_PROJECT_ID_INVALID');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('requires and validates project identity at the active-id CLI boundary', async () => {
    await expect(
      main([
        'active-id',
        '--service',
        SERVICE_ID,
        '--environment',
        ENVIRONMENT_NAME,
      ]),
    ).rejects.toThrow('RAILWAY_OBSERVER_ARGUMENTS_INVALID');

    await expect(
      main([
        'active-id',
        '--project',
        'current',
        '--service',
        SERVICE_ID,
        '--environment',
        ENVIRONMENT_NAME,
      ]),
    ).rejects.toThrow('RAILWAY_PROJECT_ID_INVALID');
  });

  it.each([
    ['a different project', status => { status.id = DECOY_SERVICE_ID; }],
    ['a deleted project', status => { status.deletedAt = '2026-08-12T00:00:00.000Z'; }],
    ['no exact environment', status => { status.environments.edges.splice(1, 1); }],
    ['duplicate exact environments', status => {
      status.environments.edges.push({
        node: {
          ...targetEnvironmentNode(status),
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      });
    }],
    ['an inaccessible environment', status => { targetEnvironmentNode(status).canAccess = false; }],
    ['a deleted environment', status => {
      targetEnvironmentNode(status).deletedAt = '2026-08-12T00:00:00.000Z';
    }],
    ['an invalid environment ID', status => { targetEnvironmentNode(status).id = 'production'; }],
    ['a reused environment ID', status => {
      status.environments.edges[0].node.id = ENVIRONMENT_ID;
    }],
    ['a malformed environment edge', status => { status.environments.edges.push({}); }],
    ['no exact project service', status => { status.services.edges.splice(1, 1); }],
    ['duplicate exact project services', status => {
      status.services.edges.push({ node: { id: SERVICE_ID, name: 'ARCANOS Worker' } });
    }],
    ['no exact service instance', status => {
      targetEnvironmentNode(status).serviceInstances.edges.splice(1, 1);
    }],
    ['duplicate exact service instances', status => {
      targetEnvironmentNode(status).serviceInstances.edges.push({
        node: {
          ...targetServiceNode(status),
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      });
    }],
    ['a mismatched service environment', status => {
      targetServiceNode(status).environmentId = DECOY_ENVIRONMENT_ID;
    }],
    ['a mismatched service name', status => { targetServiceNode(status).serviceName = 'impostor'; }],
    ['a reused service-instance ID', status => {
      targetEnvironmentNode(status).serviceInstances.edges[0].node.id = SERVICE_INSTANCE_ID;
    }],
    ['a malformed service-instance edge', status => {
      targetEnvironmentNode(status).serviceInstances.edges.push({ node: null });
    }],
    ['missing active deployments', status => { delete targetServiceNode(status).activeDeployments; }],
    ['non-array active deployments', status => { targetServiceNode(status).activeDeployments = {}; }],
    ['zero active deployments', status => { targetServiceNode(status).activeDeployments = []; }],
    ['multiple active deployments', status => {
      targetServiceNode(status).activeDeployments.push({
        id: FAILED_DEPLOYMENT_ID,
        status: 'FAILED',
      });
    }],
    ['multiple successful active deployments', status => {
      targetServiceNode(status).activeDeployments.push({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'SUCCESS',
      });
    }],
    ['a non-success active deployment', status => {
      targetServiceNode(status).activeDeployments[0].status = 'DEPLOYING';
    }],
    ['a missing active status', status => {
      delete targetServiceNode(status).activeDeployments[0].status;
    }],
    ['an invalid active deployment ID', status => {
      targetServiceNode(status).activeDeployments[0].id = 'active';
    }],
    ['a malformed active deployment', status => {
      targetServiceNode(status).activeDeployments[0] = null;
    }],
  ])('rejects baseline inventory with %s', async (_label, mutateStatus) => {
    const status = projectStatusFixture();
    mutateStatus(status);

    await expect(
      readActiveDeploymentId(
        { projectId: PROJECT_ID, ...target },
        { runCommand: async () => JSON.stringify(status) },
      ),
    ).rejects.toThrow('RAILWAY_BASELINE_ACTIVATION_EVIDENCE_MISMATCH');
  });

  it.each([
    ['malformed JSON', '{'],
    ['non-object JSON', '[]'],
  ])('rejects %s project-status evidence', async (_label, output) => {
    await expect(
      readActiveDeploymentId(
        { projectId: PROJECT_ID, ...target },
        { runCommand: async () => output },
      ),
    ).rejects.toThrow('RAILWAY_BASELINE_ACTIVATION_EVIDENCE_MISMATCH');
  });

  it('requires the exact deployment to remain the active SUCCESS', async () => {
    const runCommand = jest.fn(async () =>
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        status: 'SUCCESS',
        stopped: false,
      }),
    );

    await expect(
      verifyActiveDeployment(
        { deploymentId: DEPLOYMENT_ID, ...target },
        { runCommand },
      ),
    ).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledWith(
      [
        'service',
        'status',
        '--service',
        SERVICE_ID,
        '--environment',
        ENVIRONMENT_NAME,
        '--json',
      ],
      RAILWAY_COMMAND_LIMITS.serviceStatus,
    );
  });

  it.each([
    [
      'different deployment',
      JSON.stringify({
        deploymentId: '44444444-4444-4444-8444-444444444444',
        status: 'SUCCESS',
      }),
    ],
    [
      'non-success state',
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        status: 'DEPLOYING',
        stopped: false,
      }),
    ],
    [
      'stopped deployment',
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        status: 'SUCCESS',
        stopped: true,
      }),
    ],
    [
      'missing stopped evidence',
      JSON.stringify({
        deploymentId: DEPLOYMENT_ID,
        status: 'SUCCESS',
      }),
    ],
    ['malformed JSON', '{'],
  ])('rejects %s activation evidence', async (_label, output) => {
    await expect(
      verifyActiveDeployment(
        { deploymentId: DEPLOYMENT_ID, ...target },
        { runCommand: async () => output },
      ),
    ).rejects.toThrow('RAILWAY_READINESS_ACTIVATION_EVIDENCE_MISMATCH');
  });

  it('returns bounded variable JSON only from the exact service/environment', async () => {
    const runCommand = jest.fn(async () => '{"ARCANOS_PROCESS_KIND":"web"}');

    await expect(
      readRailwayVariables(target, { runCommand }),
    ).resolves.toBe('{"ARCANOS_PROCESS_KIND":"web"}');
    expect(runCommand).toHaveBeenCalledWith(
      [
        'variable',
        'list',
        '--service',
        SERVICE_ID,
        '--environment',
        ENVIRONMENT_NAME,
        '--json',
      ],
      RAILWAY_COMMAND_LIMITS.variableList,
    );
  });

  it.each([
    'production/blue',
    'Prøduction β',
    'x'.repeat(200),
  ])('preserves provider-compatible environment name %p', async environmentName => {
    const runCommand = jest.fn(async () => '{}');

    await expect(
      readRailwayVariables(
        { serviceId: SERVICE_ID, environmentName },
        { runCommand },
      ),
    ).resolves.toBe('{}');
    expect(runCommand.mock.calls[0][0]).toContain(environmentName);
  });
});
