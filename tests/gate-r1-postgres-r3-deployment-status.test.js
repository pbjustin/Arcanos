import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_R3_DEPLOYMENT_DEADLINE_MS,
  GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS,
  GATE_R1_R3_DEPLOYMENT_POLL_INTERVAL_MS,
  parseGateR1PostgresR3DeploymentStatusArgs,
  projectGateR1PostgresR3DeploymentStatus,
  requireGateR1PostgresR3DeploymentSuccess,
  waitForGateR1PostgresR3Deployment,
  runGateR1PostgresR3DeploymentStatus
} from '../scripts/gate-r1-postgres-r3-deployment-status.js';
import {
  GATE_R1_R3_ENVIRONMENT_ID,
  GATE_R1_R3_POSTGRES_SERVICE_ID,
  GATE_R1_R3_PROJECT_NAME,
  GATE_R1_R3_ENVIRONMENT_NAME
} from '../scripts/gate-r1-postgres-r3-config-patch.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const SERVICE_NAME = 'phase2e-postgres-r3-20260720';
const DEPLOYMENT_ID = '75e791a9-31cb-40bc-8e39-8970958cf330';
const OTHER_DEPLOYMENT_ID = 'd1d3ca4f-5816-4587-ac37-c6104369ae55';
const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'deployment-secret-sentinel-must-not-escape';
const UNRELATED_SECRET_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['DATABASE_URL', SECRET_SENTINEL]
]));

function rawStatus({
  id = GATE_R1_R3_POSTGRES_SERVICE_ID,
  name = SERVICE_NAME,
  deploymentId = DEPLOYMENT_ID,
  status = 'DEPLOYING',
  stopped = false,
  ...extra
} = {}) {
  return { id, name, deploymentId, status, stopped, ...extra };
}

function statusBuffer({
  project = GATE_R1_R3_PROJECT_NAME,
  environment = GATE_R1_R3_ENVIRONMENT_NAME,
  service = 'None'
} = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

describe('Gate R1 PostgreSQL R3 schema-locked deployment status', () => {
  it('accepts only the exact fixed service CLI argument shape', () => {
    expect(parseGateR1PostgresR3DeploymentStatusArgs([
      '--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID
    ])).toEqual({
      deploymentId: undefined,
      operation: 'read',
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID
    });
    expect(parseGateR1PostgresR3DeploymentStatusArgs([
      '--operation', 'wait', '--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID
    ])).toEqual({
      deploymentId: undefined,
      operation: 'wait',
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID
    });
    expect(parseGateR1PostgresR3DeploymentStatusArgs([
      '--operation', 'verify-success',
      '--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--deployment-id', DEPLOYMENT_ID
    ])).toEqual({
      deploymentId: DEPLOYMENT_ID,
      operation: 'verify-success',
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID
    });

    for (const args of [
      [],
      ['--service-id', 'b7789306-8aef-4113-add5-02883a6cc087'],
      ['--service-id', 'not-a-uuid'],
      ['--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID, '--all'],
      ['--all'],
      ['--environment', GATE_R1_R3_ENVIRONMENT_ID],
      ['--operation', 'wait', '--service-id', 'not-the-r3-service'],
      ['--operation', 'verify-success', '--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID],
      ['--operation', 'verify-success', '--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID,
        '--deployment-id', 'not-a-uuid']
    ]) {
      expect(() => parseGateR1PostgresR3DeploymentStatusArgs(args))
        .toThrow('GATE_R1_R3_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
    }
  });

  it('classifies no deployment without inventing a deployment identity', () => {
    const result = projectGateR1PostgresR3DeploymentStatus(rawStatus({
      deploymentId: null,
      status: null,
      stopped: true
    }));

    expect(result).toMatchObject({
      deploymentId: null,
      deploymentStatus: null,
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
      serviceName: SERVICE_NAME,
      stateCategory: 'STOPPED',
      status: 'PASS',
      stopped: true
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it.each(['QUEUED', 'INITIALIZING', 'BUILDING', 'DEPLOYING', 'WAITING'])(
    'classifies %s as pending',
    status => {
      expect(projectGateR1PostgresR3DeploymentStatus(rawStatus({ status })))
        .toMatchObject({
          deploymentId: DEPLOYMENT_ID,
          deploymentStatus: status,
          stateCategory: 'PENDING',
          status: 'PASS',
          stopped: false
        });
    }
  );

  it('classifies exactly SUCCESS as success', () => {
    expect(projectGateR1PostgresR3DeploymentStatus(rawStatus({ status: 'SUCCESS' })))
      .toMatchObject({
        deploymentId: DEPLOYMENT_ID,
        deploymentStatus: 'SUCCESS',
        stateCategory: 'SUCCESS',
        status: 'PASS',
        stopped: false
      });
  });

  it.each([
    'CRASHED', 'FAILED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING', 'NEEDS_APPROVAL'
  ])('classifies %s as a terminal failure', status => {
    expect(projectGateR1PostgresR3DeploymentStatus(rawStatus({ status })))
      .toMatchObject({
        deploymentId: DEPLOYMENT_ID,
        deploymentStatus: status,
        stateCategory: 'TERMINAL_FAILURE',
        status: 'PASS'
      });
  });

  it('classifies a stopped deployment separately and never reports it as success', () => {
    expect(projectGateR1PostgresR3DeploymentStatus(rawStatus({
      status: 'SUCCESS',
      stopped: true
    }))).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      deploymentStatus: 'SUCCESS',
      stateCategory: 'STOPPED',
      status: 'PASS',
      stopped: true
    });
  });

  it.each([
    ['extra key', rawStatus({ extra: true })],
    ['missing key', (() => { const value = rawStatus(); delete value.stopped; return value; })()],
    ['wrong service id', rawStatus({ id: 'b7789306-8aef-4113-add5-02883a6cc087' })],
    ['wrong service name', rawStatus({ name: 'Postgres' })],
    ['malformed deployment id', rawStatus({ deploymentId: 'not-a-uuid' })],
    ['unknown status', rawStatus({ status: 'UNKNOWN' })],
    ['non-string status', rawStatus({ status: 1 })],
    ['non-boolean stopped', rawStatus({ stopped: 'false' })],
    ['deployment without status', rawStatus({ status: null })],
    ['status without deployment', rawStatus({ deploymentId: null, status: 'SUCCESS' })]
  ])('rejects %s under the exact response schema', (_name, value) => {
    expect(() => projectGateR1PostgresR3DeploymentStatus(value))
      .toThrow('GATE_R1_R3_DEPLOYMENT_STATUS_RESPONSE_INVALID');
  });

  it('rejects a deployment identity change when an expected ID is supplied', () => {
    expect(() => projectGateR1PostgresR3DeploymentStatus(
      rawStatus({ deploymentId: OTHER_DEPLOYMENT_ID }),
      { expectedDeploymentId: DEPLOYMENT_ID }
    )).toThrow('GATE_R1_R3_DEPLOYMENT_ID_MISMATCH');

    expect(projectGateR1PostgresR3DeploymentStatus(
      rawStatus(),
      { expectedDeploymentId: DEPLOYMENT_ID }
    )).toMatchObject({ deploymentId: DEPLOYMENT_ID });

    for (const expectedDeploymentId of ['', 'not-a-uuid', null, 1]) {
      expect(() => projectGateR1PostgresR3DeploymentStatus(
        rawStatus(),
        { expectedDeploymentId }
      )).toThrow('GATE_R1_R3_DEPLOYMENT_ID_MISMATCH');
    }
  });

  it('polls with fixed bounds, latches one ID, and returns only a successful deployment', () => {
    const statuses = [
      rawStatus({ deploymentId: null, status: null, stopped: false }),
      rawStatus({ status: 'QUEUED' }),
      rawStatus({ status: 'DEPLOYING' }),
      rawStatus({ status: 'SUCCESS' })
    ];
    const readStatus = jest.fn(expectedDeploymentId => projectGateR1PostgresR3DeploymentStatus(
      statuses.shift(),
      { expectedDeploymentId }
    ));
    const sleep = jest.fn();

    expect(waitForGateR1PostgresR3Deployment({ readStatus, sleep })).toEqual({
      code: 'GATE_R1_R3_DEPLOYMENT_SUCCEEDED',
      deploymentId: DEPLOYMENT_ID,
      environmentId: GATE_R1_R3_ENVIRONMENT_ID,
      observations: 4,
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
      status: 'PASS'
    });
    expect(readStatus.mock.calls.map(([expected]) => expected)).toEqual([
      undefined, undefined, DEPLOYMENT_ID, DEPLOYMENT_ID
    ]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(GATE_R1_R3_DEPLOYMENT_POLL_INTERVAL_MS);
  });

  it('permits success on observation 120 without sleeping afterward', () => {
    let observation = 0;
    const readStatus = jest.fn(() => {
      observation += 1;
      return projectGateR1PostgresR3DeploymentStatus(observation === 120
        ? rawStatus({ status: 'SUCCESS' })
        : rawStatus({ deploymentId: null, status: null, stopped: false }));
    });
    const sleep = jest.fn();

    expect(waitForGateR1PostgresR3Deployment({ readStatus, sleep }))
      .toMatchObject({ observations: 120, deploymentId: DEPLOYMENT_ID });
    expect(readStatus).toHaveBeenCalledTimes(GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS);
    expect(sleep).toHaveBeenCalledTimes(GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS - 1);
  });

  it('fails after 120 observations without a deployment and performs only 119 sleeps', () => {
    const readStatus = jest.fn(() => projectGateR1PostgresR3DeploymentStatus(rawStatus({
      deploymentId: null,
      status: null,
      stopped: false
    })));
    const sleep = jest.fn();

    expect(() => waitForGateR1PostgresR3Deployment({ readStatus, sleep }))
      .toThrow('GATE_R1_R3_DEPLOYMENT_POLL_TIMEOUT');
    expect(readStatus).toHaveBeenCalledTimes(GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS);
    expect(sleep).toHaveBeenCalledTimes(GATE_R1_R3_DEPLOYMENT_MAX_OBSERVATIONS - 1);
  });

  it.each([
    ['terminal', rawStatus({ status: 'FAILED' }), 'GATE_R1_R3_DEPLOYMENT_TERMINAL_FAILURE'],
    ['stopped', rawStatus({ status: 'SUCCESS', stopped: true }), 'GATE_R1_R3_DEPLOYMENT_STOPPED'],
    ['stopped without a deployment', rawStatus({
      deploymentId: null,
      status: null,
      stopped: true
    }), 'GATE_R1_R3_DEPLOYMENT_STOPPED']
  ])('fails immediately on a %s first observation without sleeping', (_name, raw, code) => {
    const readStatus = jest.fn(() => projectGateR1PostgresR3DeploymentStatus(raw));
    const sleep = jest.fn();
    expect(() => waitForGateR1PostgresR3Deployment({ readStatus, sleep })).toThrow(code);
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('enforces the ten-minute monotonic deadline around reads and sleeps', () => {
    let current = 0;
    const now = jest.fn(() => current);
    const sleep = jest.fn(milliseconds => { current += milliseconds; });
    const readStatus = jest.fn(() => {
      current = GATE_R1_R3_DEPLOYMENT_DEADLINE_MS - 4_000;
      return projectGateR1PostgresR3DeploymentStatus(rawStatus({
        deploymentId: null,
        status: null,
        stopped: false
      }));
    });

    expect(() => waitForGateR1PostgresR3Deployment({ readStatus, now, sleep }))
      .toThrow('GATE_R1_R3_DEPLOYMENT_POLL_TIMEOUT');
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps a read that reaches the monotonic deadline to the fixed poll timeout', () => {
    let current = 0;
    const now = jest.fn(() => current);
    const readStatus = jest.fn(() => {
      current = GATE_R1_R3_DEPLOYMENT_DEADLINE_MS;
      return projectGateR1PostgresR3DeploymentStatus(rawStatus({ status: 'SUCCESS' }));
    });
    const sleep = jest.fn();

    expect(() => waitForGateR1PostgresR3Deployment({ readStatus, now, sleep }))
      .toThrow('GATE_R1_R3_DEPLOYMENT_POLL_TIMEOUT');
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails immediately if the latched deployment changes or disappears', () => {
    for (const second of [
      rawStatus({ deploymentId: OTHER_DEPLOYMENT_ID }),
      rawStatus({ deploymentId: null, status: null, stopped: false })
    ]) {
      const statuses = [rawStatus({ status: 'DEPLOYING' }), second];
      const readStatus = jest.fn(expectedDeploymentId =>
        projectGateR1PostgresR3DeploymentStatus(statuses.shift(), { expectedDeploymentId }));
      const sleep = jest.fn();
      expect(() => waitForGateR1PostgresR3Deployment({ readStatus, sleep }))
        .toThrow('GATE_R1_R3_DEPLOYMENT_ID_MISMATCH');
      expect(readStatus).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    }
  });

  it('requires exact expected-ID success for pre/post-readiness verification', () => {
    const successRead = jest.fn(expectedDeploymentId =>
      projectGateR1PostgresR3DeploymentStatus(rawStatus({ status: 'SUCCESS' }), {
        expectedDeploymentId
      }));
    expect(requireGateR1PostgresR3DeploymentSuccess({
      deploymentId: DEPLOYMENT_ID,
      readStatus: successRead
    })).toMatchObject({ deploymentId: DEPLOYMENT_ID, stateCategory: 'SUCCESS' });
    expect(successRead).toHaveBeenCalledWith(DEPLOYMENT_ID);

    for (const raw of [
      rawStatus({ status: 'DEPLOYING' }),
      rawStatus({ status: 'SUCCESS', stopped: true })
    ]) {
      expect(() => requireGateR1PostgresR3DeploymentSuccess({
        deploymentId: DEPLOYMENT_ID,
        readStatus: () => projectGateR1PostgresR3DeploymentStatus(raw, {
          expectedDeploymentId: DEPLOYMENT_ID
        })
      })).toThrow('GATE_R1_R3_DEPLOYMENT_NOT_SUCCESSFUL');
    }
  });

  it('runs only the exact read-only service-status command with bounded output', () => {
    const linkStdout = statusBuffer();
    const deploymentStdout = Buffer.from(`${JSON.stringify(rawStatus())}\n`);
    const deploymentStderr = Buffer.alloc(0);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: deploymentStdout, stderr: deploymentStderr });

    const result = runGateR1PostgresR3DeploymentStatus({
      environment: {
        PATH: 'C:\\safe',
        ...UNRELATED_SECRET_ENVIRONMENT,
        RAILWAY_TOKEN: ''
      },
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
      spawn
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(['status']);
    expect(spawn.mock.calls[1][1]).toEqual([
      'service', 'status',
      '-s', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '-e', GATE_R1_R3_ENVIRONMENT_ID,
      '--json'
    ]);
    expect(spawn.mock.calls[1][2]).toMatchObject({
      env: { PATH: 'C:\\safe' },
      maxBuffer: 1024,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    expect(spawn.mock.calls[1][1].join(' ')).not.toMatch(/\b(up|down|redeploy|restart)\b/i);
    expect(result).toMatchObject({ deploymentId: DEPLOYMENT_ID, stateCategory: 'PENDING' });
    expectZeroed(linkStdout);
    expectZeroed(deploymentStdout);
  });

  it('caps both child-process timeouts to the remaining monotonic deadline', () => {
    let current = 0;
    const now = jest.fn(() => current);
    const linkStdout = statusBuffer();
    const deploymentStdout = Buffer.from(`${JSON.stringify(rawStatus())}\n`);
    const spawn = jest.fn()
      .mockImplementationOnce(() => {
        current = 15_000;
        return { status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) };
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: deploymentStdout,
        stderr: Buffer.alloc(0)
      });

    expect(runGateR1PostgresR3DeploymentStatus({
      deadlineAt: 40_000,
      environment: { PATH: 'safe' },
      now,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toMatchObject({ deploymentId: DEPLOYMENT_ID });
    expect(spawn.mock.calls[0][2].timeout).toBe(30_000);
    expect(spawn.mock.calls[1][2].timeout).toBe(25_000);
    expectZeroed(linkStdout);
    expectZeroed(deploymentStdout);
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before link or status reads',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR1PostgresR3DeploymentStatus({
        environment: { PATH: 'safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_R3_DEPLOYMENT_STATUS_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects the wrong isolated link before the status query', () => {
    const linkStdout = statusBuffer({ environment: 'production' });
    const spawn = jest.fn(() => ({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) }));

    expect(() => runGateR1PostgresR3DeploymentStatus({
      environment: { PATH: 'safe' },
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_SOURCE_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(linkStdout);
  });

  it.each([
    ['nonzero query', { status: 1, stdout: Buffer.from(SECRET_SENTINEL), stderr: Buffer.from(SECRET_SENTINEL) }, 'GATE_R1_R3_DEPLOYMENT_STATUS_QUERY_FAILED'],
    ['timed-out query', {
      error: Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT' }),
      status: null,
      stdout: Buffer.from(SECRET_SENTINEL),
      stderr: Buffer.from(SECRET_SENTINEL)
    }, 'GATE_R1_R3_DEPLOYMENT_STATUS_TIMEOUT'],
    ['oversized query', {
      status: 0,
      stdout: Buffer.alloc(1025, 0x41),
      stderr: Buffer.alloc(0)
    }, 'GATE_R1_R3_DEPLOYMENT_STATUS_RESPONSE_INVALID']
  ])('maps %s to a fixed failure and clears bounded diagnostics', (_name, queryResult, code) => {
    const linkStdout = statusBuffer();
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce(queryResult);

    expect(() => runGateR1PostgresR3DeploymentStatus({
      environment: { PATH: 'safe' },
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow(code);
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(linkStdout);
    expectZeroed(queryResult.stdout);
    expectZeroed(queryResult.stderr);
  });

  it('rejects malformed or secret-bearing child output with fixed diagnostics only', () => {
    const linkStdout = statusBuffer();
    const deploymentStdout = Buffer.from(JSON.stringify({
      ...rawStatus(),
      unexpected: `postgresql://${SECRET_SENTINEL}`
    }));
    const deploymentStderr = Buffer.from(`Bearer ${SECRET_SENTINEL}`);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: deploymentStdout, stderr: deploymentStderr });

    expect(() => runGateR1PostgresR3DeploymentStatus({
      environment: { PATH: 'safe' },
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
      spawn
    })).toThrow('GATE_R1_R3_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    expectZeroed(deploymentStdout);
    expectZeroed(deploymentStderr);
  });
});
