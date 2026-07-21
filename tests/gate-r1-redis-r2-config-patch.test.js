import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_REDIS_ENVIRONMENT_ID,
  GATE_R1_REDIS_ENVIRONMENT_NAME,
  GATE_R1_REDIS_SERVICE_ID,
  GATE_R1_REDIS_START_COMMAND,
  buildGateR1RedisR2Patch,
  runGateR1RedisR2ConfigPatch
} from '../scripts/gate-r1-redis-r2-config-patch.js';
import { GATE_R1_APPROVED_REDIS_START_COMMAND } from '../scripts/gate-r1-railway-metadata-projector.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'redis-config-secret-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze({
  DATABASE_URL: SECRET_SENTINEL,
  PROVIDER_TEST_INPUT: SECRET_SENTINEL,
  PATH: 'C:\\safe'
});

function statusBuffer({ environment = GATE_R1_REDIS_ENVIRONMENT_NAME } = {}) {
  return Buffer.from(`Project: Arcanos\nEnvironment: ${environment}\nService: None\n`);
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

describe('Gate R1 Redis R2 fixed offline configuration patch', () => {
  it('builds only the reviewed exact-target restart and start-command patch', () => {
    const definition = buildGateR1RedisR2Patch('service-configuration');
    const patch = JSON.parse(definition.patchJson);

    expect(GATE_R1_REDIS_START_COMMAND).toBe(GATE_R1_APPROVED_REDIS_START_COMMAND);
    expect(definition).toMatchObject({
      message: 'gate-r: configure private redis replacement',
      profile: 'service-configuration'
    });
    expect(patch).toEqual({
      services: {
        [GATE_R1_REDIS_SERVICE_ID]: {
          deploy: {
            startCommand: GATE_R1_REDIS_START_COMMAND,
            restartPolicyType: 'ON_FAILURE',
            restartPolicyMaxRetries: 3
          }
        }
      }
    });

    for (const profile of [undefined, null, '', 'redis-source', 'service-configuration ']) {
      expect(() => buildGateR1RedisR2Patch(profile))
        .toThrow('GATE_R1_REDIS_CONFIG_ARGUMENT_INVALID');
    }
  });

  it('checks the exact isolated link and sends the fixed patch through stdin', () => {
    const statusStdout = statusBuffer();
    const patchStdout = Buffer.from(SECRET_SENTINEL);
    let submittedPatch;
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce((_file, _args, options) => {
        submittedPatch = Buffer.from(options.input);
        return { status: 0, stdout: patchStdout, stderr: Buffer.alloc(0) };
      });

    const result = runGateR1RedisR2ConfigPatch({
      environment: SAFE_ENVIRONMENT,
      profile: 'service-configuration',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(['status']);
    expect(spawn.mock.calls[1][1]).toEqual([
      'environment', 'edit',
      '-e', GATE_R1_REDIS_ENVIRONMENT_ID,
      '-m', 'gate-r: configure private redis replacement',
      '--json'
    ]);
    expect(spawn.mock.calls[1][2]).toMatchObject({
      env: { PATH: 'C:\\safe' },
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true
    });
    expect(JSON.parse(submittedPatch.toString('utf8'))).toEqual(
      JSON.parse(buildGateR1RedisR2Patch('service-configuration').patchJson)
    );
    expect(result).toEqual({
      code: 'GATE_R1_REDIS_CONFIG_PATCH_ACCEPTED_PENDING_PROJECTION',
      environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
      profile: 'service-configuration',
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      projectionRequired: true,
      retryAuthorized: false,
      serviceId: GATE_R1_REDIS_SERVICE_ID,
      status: 'PENDING_PROJECTION'
    });
    expectZeroed(statusStdout);
    expectZeroed(patchStdout);
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before checking the link',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR1RedisR2ConfigPatch({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        profile: 'service-configuration',
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_REDIS_CONFIG_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects a wrong isolated link before mutation and clears its diagnostics', () => {
    const stdout = statusBuffer({ environment: 'production' });
    const stderr = Buffer.from(SECRET_SENTINEL);
    const spawn = jest.fn(() => ({ status: 0, stdout, stderr }));

    expect(() => runGateR1RedisR2ConfigPatch({
      environment: SAFE_ENVIRONMENT,
      profile: 'service-configuration',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_CONFIG_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it.each([
    ['timed-out', {
      error: Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT' }),
      status: null
    }],
    ['nonzero', { status: 1 }]
  ])('maps a %s patch result to ambiguity and clears secret diagnostics', (_name, patchResult) => {
    const statusStdout = statusBuffer();
    const stdout = Buffer.from(SECRET_SENTINEL);
    const stderr = Buffer.from(SECRET_SENTINEL);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({
        ...patchResult,
        stdout,
        stderr
      });

    expect(() => runGateR1RedisR2ConfigPatch({
      environment: SAFE_ENVIRONMENT,
      profile: 'service-configuration',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_CONFIG_PATCH_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it('does not treat Railway stdout acknowledgement as configuration truth', () => {
    const statusStdout = statusBuffer();
    const patchStdout = Buffer.from(JSON.stringify({ committed: true, ignoredValue: SECRET_SENTINEL }));
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: patchStdout, stderr: Buffer.alloc(0) });

    expect(runGateR1RedisR2ConfigPatch({
      environment: SAFE_ENVIRONMENT,
      profile: 'service-configuration',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toMatchObject({
      code: 'GATE_R1_REDIS_CONFIG_PATCH_ACCEPTED_PENDING_PROJECTION',
      projectionRequired: true,
      retryAuthorized: false,
      status: 'PENDING_PROJECTION'
    });
    expectZeroed(patchStdout);
  });

  it('maps hostile thrown patch diagnostics to a fixed code without invoking accessors', () => {
    const statusStdout = statusBuffer();
    const output = Buffer.from(SECRET_SENTINEL);
    const causeOutput = Buffer.from(SECRET_SENTINEL);
    const hostile = Object.create(null, {
      cause: { value: { stdout: causeOutput } },
      message: { value: SECRET_SENTINEL },
      output: { value: [output] },
      stderr: {
        get() {
          throw new Error(SECRET_SENTINEL);
        }
      }
    });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce(() => { throw hostile; });

    expect(() => runGateR1RedisR2ConfigPatch({
      environment: SAFE_ENVIRONMENT,
      profile: 'service-configuration',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_CONFIG_PATCH_AMBIGUOUS');
    expectZeroed(output);
    expectZeroed(causeOutput);
  });
});
