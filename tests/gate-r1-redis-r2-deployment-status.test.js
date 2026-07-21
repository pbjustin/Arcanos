import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_REDIS_DEPLOYMENT_DEADLINE_MS,
  GATE_R1_REDIS_DEPLOYMENT_MAX_OBSERVATIONS,
  GATE_R1_REDIS_DEPLOYMENT_POLL_INTERVAL_MS,
  parseGateR1RedisR2DeploymentStatusArgs,
  projectGateR1RedisR2DeploymentStatus,
  requireGateR1RedisR2DeploymentSuccess,
  runGateR1RedisR2DeploymentStatus,
  waitForGateR1RedisR2Deployment
} from '../scripts/gate-r1-redis-r2-deployment-status.js';
import {
  GATE_R1_REDIS_ENVIRONMENT_ID,
  GATE_R1_REDIS_ENVIRONMENT_NAME,
  GATE_R1_REDIS_PROJECT_ID,
  GATE_R1_REDIS_PROJECT_NAME,
  GATE_R1_REDIS_SERVICE_ID,
  GATE_R1_REDIS_SERVICE_NAME
} from '../scripts/gate-r1-redis-r2-config-patch.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const DEPLOYMENT_ID = '75e791a9-31cb-40bc-8e39-8970958cf330';
const OTHER_DEPLOYMENT_ID = 'd1d3ca4f-5816-4587-ac37-c6104369ae55';
const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'redis-deployment-secret-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze({
  DATABASE_URL: SECRET_SENTINEL,
  PROVIDER_TEST_INPUT: SECRET_SENTINEL,
  PATH: 'C:\\safe'
});

function rawStatus({
  id = GATE_R1_REDIS_SERVICE_ID,
  name = GATE_R1_REDIS_SERVICE_NAME,
  deploymentId = DEPLOYMENT_ID,
  status = 'DEPLOYING',
  stopped = false,
  ...extra
} = {}) {
  return { id, name, deploymentId, status, stopped, ...extra };
}

function statusBuffer({ environment = GATE_R1_REDIS_ENVIRONMENT_NAME } = {}) {
  return Buffer.from(
    `Project: ${GATE_R1_REDIS_PROJECT_NAME}\nEnvironment: ${environment}\nService: None\n`
  );
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

describe('Gate R1 Redis R2 schema-locked deployment status', () => {
  it('accepts only exact fixed-service read, wait, and expected-ID verification arguments', () => {
    expect(parseGateR1RedisR2DeploymentStatusArgs([
      '--service-id', GATE_R1_REDIS_SERVICE_ID
    ])).toEqual({
      deploymentId: undefined,
      operation: 'read',
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });
    expect(parseGateR1RedisR2DeploymentStatusArgs([
      '--operation', 'wait', '--service-id', GATE_R1_REDIS_SERVICE_ID
    ])).toEqual({
      deploymentId: undefined,
      operation: 'wait',
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });
    expect(parseGateR1RedisR2DeploymentStatusArgs([
      '--operation', 'verify-success',
      '--service-id', GATE_R1_REDIS_SERVICE_ID,
      '--deployment-id', DEPLOYMENT_ID
    ])).toEqual({
      deploymentId: DEPLOYMENT_ID,
      operation: 'verify-success',
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });

    for (const argv of [
      [],
      ['--service-id', '434fa5b4-b52c-4caf-aaba-e87c173bf10d'],
      ['--service-id', GATE_R1_REDIS_SERVICE_ID, '--all'],
      ['--operation', 'wait', '--service-id', 'not-the-redis-service'],
      ['--operation', 'verify-success', '--service-id', GATE_R1_REDIS_SERVICE_ID],
      ['--operation', 'verify-success', '--service-id', GATE_R1_REDIS_SERVICE_ID,
        '--deployment-id', 'not-a-uuid']
    ]) {
      expect(() => parseGateR1RedisR2DeploymentStatusArgs(argv))
        .toThrow('GATE_R1_REDIS_DEPLOYMENT_STATUS_ARGUMENT_INVALID');
    }
  });

  it.each([
    ['no deployment', rawStatus({ deploymentId: null, status: null }), 'NO_DEPLOYMENT'],
    ['pending', rawStatus({ status: 'DEPLOYING' }), 'PENDING'],
    ['success', rawStatus({ status: 'SUCCESS' }), 'SUCCESS'],
    ['terminal', rawStatus({ status: 'FAILED' }), 'TERMINAL_FAILURE'],
    ['stopped', rawStatus({ status: 'SUCCESS', stopped: true }), 'STOPPED']
  ])('classifies %s with an exact bounded projection', (_name, raw, stateCategory) => {
    expect(projectGateR1RedisR2DeploymentStatus(raw)).toMatchObject({
      code: 'GATE_R1_REDIS_DEPLOYMENT_STATUS_PROJECTED',
      environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
      projectId: GATE_R1_REDIS_PROJECT_ID,
      serviceId: GATE_R1_REDIS_SERVICE_ID,
      serviceName: GATE_R1_REDIS_SERVICE_NAME,
      stateCategory,
      status: 'PASS'
    });
  });

  it('rejects malformed, unknown, wrong-service, and unexpected response fields', () => {
    for (const raw of [
      rawStatus({ id: '434fa5b4-b52c-4caf-aaba-e87c173bf10d' }),
      rawStatus({ name: 'Redis' }),
      rawStatus({ status: 'UNKNOWN' }),
      rawStatus({ deploymentId: 'not-a-uuid' }),
      rawStatus({ extra: true }),
      rawStatus({ deploymentId: null, status: 'SUCCESS' })
    ]) {
      expect(() => projectGateR1RedisR2DeploymentStatus(raw))
        .toThrow('GATE_R1_REDIS_DEPLOYMENT_STATUS_RESPONSE_INVALID');
    }
  });

  it('polls within fixed bounds, latches one deployment ID, and returns only success', () => {
    const statuses = [
      rawStatus({ deploymentId: null, status: null }),
      rawStatus({ status: 'QUEUED' }),
      rawStatus({ status: 'DEPLOYING' }),
      rawStatus({ status: 'SUCCESS' })
    ];
    const readStatus = jest.fn(expectedDeploymentId =>
      projectGateR1RedisR2DeploymentStatus(statuses.shift(), { expectedDeploymentId }));
    const sleep = jest.fn();

    expect(waitForGateR1RedisR2Deployment({ readStatus, sleep })).toEqual({
      code: 'GATE_R1_REDIS_DEPLOYMENT_SUCCEEDED',
      deploymentId: DEPLOYMENT_ID,
      environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
      observations: 4,
      projectId: GATE_R1_REDIS_PROJECT_ID,
      serviceId: GATE_R1_REDIS_SERVICE_ID,
      status: 'PASS'
    });
    expect(readStatus.mock.calls.map(([expected]) => expected))
      .toEqual([undefined, undefined, DEPLOYMENT_ID, DEPLOYMENT_ID]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(GATE_R1_REDIS_DEPLOYMENT_POLL_INTERVAL_MS);
  });

  it('fails at the fixed observation bound without a deployment and never oversleeps', () => {
    const readStatus = jest.fn(() => projectGateR1RedisR2DeploymentStatus(rawStatus({
      deploymentId: null,
      status: null
    })));
    const sleep = jest.fn();

    expect(() => waitForGateR1RedisR2Deployment({ readStatus, sleep }))
      .toThrow('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
    expect(readStatus).toHaveBeenCalledTimes(GATE_R1_REDIS_DEPLOYMENT_MAX_OBSERVATIONS);
    expect(sleep).toHaveBeenCalledTimes(GATE_R1_REDIS_DEPLOYMENT_MAX_OBSERVATIONS - 1);
  });

  it('enforces the ten-minute monotonic deadline before sleeping', () => {
    let current = 0;
    const now = jest.fn(() => current);
    const readStatus = jest.fn(() => {
      current = GATE_R1_REDIS_DEPLOYMENT_DEADLINE_MS - 4_000;
      return projectGateR1RedisR2DeploymentStatus(rawStatus({
        deploymentId: null,
        status: null
      }));
    });
    const sleep = jest.fn();

    expect(() => waitForGateR1RedisR2Deployment({ readStatus, now, sleep }))
      .toThrow('GATE_R1_REDIS_DEPLOYMENT_POLL_TIMEOUT');
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails immediately on deployment rollover or disappearance after latching', () => {
    for (const second of [
      rawStatus({ deploymentId: OTHER_DEPLOYMENT_ID }),
      rawStatus({ deploymentId: null, status: null })
    ]) {
      const statuses = [rawStatus({ status: 'DEPLOYING' }), second];
      const readStatus = jest.fn(expectedDeploymentId =>
        projectGateR1RedisR2DeploymentStatus(statuses.shift(), { expectedDeploymentId }));
      const sleep = jest.fn();
      expect(() => waitForGateR1RedisR2Deployment({ readStatus, sleep }))
        .toThrow('GATE_R1_REDIS_DEPLOYMENT_ID_MISMATCH');
      expect(readStatus).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    [rawStatus({ status: 'FAILED' }), 'GATE_R1_REDIS_DEPLOYMENT_TERMINAL_FAILURE'],
    [rawStatus({ status: 'SUCCESS', stopped: true }), 'GATE_R1_REDIS_DEPLOYMENT_STOPPED'],
    [rawStatus({ deploymentId: null, status: null, stopped: true }), 'GATE_R1_REDIS_DEPLOYMENT_STOPPED']
  ])('fails immediately on terminal or stopped state', (raw, code) => {
    const readStatus = jest.fn(() => projectGateR1RedisR2DeploymentStatus(raw));
    const sleep = jest.fn();
    expect(() => waitForGateR1RedisR2Deployment({ readStatus, sleep })).toThrow(code);
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('requires the exact latched deployment to remain successful around readiness', () => {
    const readStatus = jest.fn(expectedDeploymentId =>
      projectGateR1RedisR2DeploymentStatus(rawStatus({ status: 'SUCCESS' }), {
        expectedDeploymentId
      }));
    expect(requireGateR1RedisR2DeploymentSuccess({
      deploymentId: DEPLOYMENT_ID,
      readStatus
    })).toMatchObject({ deploymentId: DEPLOYMENT_ID, stateCategory: 'SUCCESS' });
    expect(readStatus).toHaveBeenCalledWith(DEPLOYMENT_ID);

    expect(() => requireGateR1RedisR2DeploymentSuccess({
      deploymentId: DEPLOYMENT_ID,
      readStatus: () => projectGateR1RedisR2DeploymentStatus(rawStatus({ status: 'DEPLOYING' }))
    })).toThrow('GATE_R1_REDIS_DEPLOYMENT_NOT_SUCCESSFUL');
  });

  it('runs only the exact read-only status command with a sanitized child environment', () => {
    const linkStdout = statusBuffer();
    const queryStdout = Buffer.from(`${JSON.stringify(rawStatus())}\n`);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: queryStdout, stderr: Buffer.alloc(0) });

    const result = runGateR1RedisR2DeploymentStatus({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(['status']);
    expect(spawn.mock.calls[1][1]).toEqual([
      'service', 'status',
      '-s', GATE_R1_REDIS_SERVICE_ID,
      '-e', GATE_R1_REDIS_ENVIRONMENT_ID,
      '--json'
    ]);
    expect(spawn.mock.calls[1][2]).toMatchObject({
      env: { PATH: 'C:\\safe' },
      maxBuffer: 1024,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    expect(result).toMatchObject({ deploymentId: DEPLOYMENT_ID, stateCategory: 'PENDING' });
    expectZeroed(linkStdout);
    expectZeroed(queryStdout);
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before the link or deployment query',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR1RedisR2DeploymentStatus({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_REDIS_DEPLOYMENT_STATUS_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects the wrong isolated link before the status query', () => {
    const linkStdout = statusBuffer({ environment: 'production' });
    const spawn = jest.fn(() => ({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) }));

    expect(() => runGateR1RedisR2DeploymentStatus({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(linkStdout);
  });

  it('maps secret-bearing query failure to a fixed code and clears diagnostics', () => {
    const linkStdout = statusBuffer();
    const stdout = Buffer.from(`redis://${SECRET_SENTINEL}`);
    const stderr = Buffer.from(`Bearer ${SECRET_SENTINEL}`);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 1, stdout, stderr });

    expect(() => runGateR1RedisR2DeploymentStatus({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_DEPLOYMENT_STATUS_QUERY_FAILED');
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it('maps hostile thrown query diagnostics to a fixed code without invoking accessors', () => {
    const linkStdout = statusBuffer();
    const output = Buffer.from(SECRET_SENTINEL);
    const causeOutput = Buffer.from(SECRET_SENTINEL);
    const hostile = Object.create(null, {
      cause: { value: { stderr: causeOutput } },
      message: { value: SECRET_SENTINEL },
      output: { value: [output] },
      stderr: {
        get() {
          throw new Error(SECRET_SENTINEL);
        }
      }
    });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce(() => { throw hostile; });

    expect(() => runGateR1RedisR2DeploymentStatus({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_DEPLOYMENT_STATUS_QUERY_FAILED');
    expectZeroed(output);
    expectZeroed(causeOutput);
  });
});
