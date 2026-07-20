import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_R3_ENVIRONMENT_ID,
  GATE_R1_R3_ENVIRONMENT_NAME,
  GATE_R1_R3_POSTGRES_SERVICE_ID,
  GATE_R1_R3_PROJECT_ID,
  GATE_R1_R3_PROJECT_NAME,
  buildGateR1PostgresR3Patch,
  runGateR1PostgresR3ConfigPatch
} from '../scripts/gate-r1-postgres-r3-config-patch.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'credential-sentinel-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze({ PATH: 'C:\\safe' });
const UNRELATED_SECRET_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['DATABASE_URL', SECRET_SENTINEL]
]));

function statusBuffer({
  project = GATE_R1_R3_PROJECT_NAME,
  environment = GATE_R1_R3_ENVIRONMENT_NAME,
  service = 'None'
} = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function acknowledgement(message, overrides = {}) {
  return Buffer.from(`${JSON.stringify({
    committed: true,
    environmentId: GATE_R1_R3_ENVIRONMENT_ID,
    environmentName: GATE_R1_R3_ENVIRONMENT_NAME,
    message,
    staged: true,
    ...overrides
  })}\n`);
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

function successfulSpawn(capture = {}) {
  return jest.fn((_file, args, options) => {
    if (args[0] === 'status') {
      const stdout = statusBuffer();
      const stderr = Buffer.alloc(0);
      capture.statusStdout = stdout;
      capture.statusStderr = stderr;
      return { status: 0, stdout, stderr };
    }
    capture.patchArgs = [...args];
    capture.patchInput = Buffer.from(options.input);
    const message = buildGateR1PostgresR3Patch('service-configuration').message;
    const stdout = acknowledgement(message);
    const stderr = Buffer.alloc(0);
    capture.patchStdout = stdout;
    capture.patchStderr = stderr;
    return { status: 0, stdout, stderr };
  });
}

describe('Gate R1 PostgreSQL R3 fixed configuration patch', () => {
  it('constructs only the exact PostgreSQL restart-policy patch', () => {
    const configuration = buildGateR1PostgresR3Patch('service-configuration');

    expect(JSON.parse(configuration.patchJson)).toEqual({
      services: {
        [GATE_R1_R3_POSTGRES_SERVICE_ID]: {
          deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3 }
        }
      }
    });
    const serialized = configuration.patchJson;
    for (const forbidden of [
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      '1ac0bd56-50b3-49eb-954c-ea83515ec915',
      'redis:8.2.1',
      'REDIS_PASSWORD',
      'startCommand',
      'variables',
      'volume',
      'domain',
      'tcpProxy'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('rejects every caller-selected or unknown profile before spawning Railway', () => {
    const spawn = jest.fn();
    for (const profile of [
      undefined,
      null,
      {},
      '',
      'postgres',
      'postgres-source',
      'redis-source',
      'POSTGRES-SOURCE',
      '__proto__'
    ]) {
      expect(() => runGateR1PostgresR3ConfigPatch({
        profile,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_R3_CONFIG_ARGUMENT_INVALID');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires the exact link and sends the fixed service-configuration patch through stdin', () => {
      const profile = 'service-configuration';
      const capture = {};
      const spawn = successfulSpawn(capture);
      const result = runGateR1PostgresR3ConfigPatch({
        profile,
        environment: {
          PATH: 'safe',
          RAILWAY_TOKEN: '',
          ...UNRELATED_SECRET_ENVIRONMENT
        },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      });

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[0][0]).toBe(TEST_RAILWAY_EXECUTABLE);
      expect(spawn.mock.calls[0][1]).toEqual(['status']);
      expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 30_000 });
      expect(spawn.mock.calls[0][2].env).toEqual({ PATH: 'safe' });
      expect(spawn.mock.calls[1][1]).toEqual([
        'environment', 'edit',
        '-e', GATE_R1_R3_ENVIRONMENT_ID,
        '-m', buildGateR1PostgresR3Patch(profile).message,
        '--json'
      ]);
      expect(JSON.parse(capture.patchInput.toString('utf8'))).toEqual(
        JSON.parse(buildGateR1PostgresR3Patch(profile).patchJson)
      );
      expect(spawn.mock.calls[1][2]).toMatchObject({ timeout: 30_000 });
      expect(spawn.mock.calls[1][2].env).toEqual({ PATH: 'safe' });
      expect(result).toEqual({
        code: 'GATE_R1_R3_CONFIG_PATCH_COMMITTED',
        environmentId: GATE_R1_R3_ENVIRONMENT_ID,
        profile,
        projectId: GATE_R1_R3_PROJECT_ID,
        projectionRequired: true,
        retryAuthorized: false,
        serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
        status: 'PENDING_PROJECTION'
      });
      expectZeroed(capture.statusStdout);
      expectZeroed(capture.patchStdout);
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before spawning Railway',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR1PostgresR3ConfigPatch({
        profile: 'service-configuration',
        environment: { PATH: 'safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_R3_CONFIG_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['wrong project', { project: 'Another' }],
    ['wrong environment', { environment: 'production' }],
    ['selected service', { service: 'phase2e-postgres-r3-20260720' }]
  ])('stops before the patch when the isolated link has %s', (_name, statusOverrides) => {
    const stdout = statusBuffer(statusOverrides);
    const stderr = Buffer.alloc(0);
    const spawn = jest.fn(() => ({ status: 0, stdout, stderr }));

    expect(() => runGateR1PostgresR3ConfigPatch({
      profile: 'service-configuration',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_CONFIG_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stdout);
  });

  it('maps patch failure to a fixed code and clears secret-bearing diagnostics', () => {
    const statusStdout = statusBuffer();
    const patchStdout = Buffer.from(`postgresql://${SECRET_SENTINEL}`);
    const patchStderr = Buffer.from(`Authorization: Bearer ${SECRET_SENTINEL}`);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 1, stdout: patchStdout, stderr: patchStderr });

    expect(() => runGateR1PostgresR3ConfigPatch({
      profile: 'service-configuration',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_CONFIG_PATCH_FAILED');
    expectZeroed(statusStdout);
    expectZeroed(patchStdout);
    expectZeroed(patchStderr);
  });

  it.each([
    ['unknown acknowledgement field', { extra: true }],
    ['wrong environment', { environmentId: '00000000-0000-4000-8000-000000000000' }],
    ['not committed', { committed: false }],
    ['not staged', { staged: false }]
  ])('rejects %s without exposing the child response', (_name, overrides) => {
    const definition = buildGateR1PostgresR3Patch('service-configuration');
    const statusStdout = statusBuffer();
    const patchStdout = acknowledgement(definition.message, overrides);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: patchStdout, stderr: Buffer.alloc(0) });

    expect(() => runGateR1PostgresR3ConfigPatch({
      profile: definition.profile,
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
    expectZeroed(patchStdout);
  });

  it('bounds child output and never returns raw diagnostics', () => {
    const statusStdout = statusBuffer();
    const oversized = Buffer.alloc(4097, 0x41);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: oversized, stderr: Buffer.alloc(0) });

    expect(() => runGateR1PostgresR3ConfigPatch({
      profile: 'service-configuration',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_CONFIG_PATCH_RESULT_INVALID');
    expectZeroed(oversized);
  });

  it.each(['status', 'patch'])('maps a %s timeout to a fixed code and wipes diagnostics', phase => {
    const statusStdout = statusBuffer();
    const timeoutStderr = Buffer.from(SECRET_SENTINEL);
    const timeout = Object.assign(new Error(SECRET_SENTINEL), {
      code: 'ETIMEDOUT',
      stderr: timeoutStderr
    });
    const spawn = phase === 'status'
      ? jest.fn(() => ({ error: timeout, status: null, stderr: timeoutStderr }))
      : jest.fn()
        .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
        .mockReturnValueOnce({ error: timeout, status: null, stderr: timeoutStderr });

    expect(() => runGateR1PostgresR3ConfigPatch({
      profile: 'service-configuration',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_CONFIG_TIMEOUT');
    expect(spawn).toHaveBeenCalledTimes(phase === 'status' ? 1 : 2);
    expectZeroed(timeoutStderr);
  });

  it('maps a synchronously thrown timeout to a fixed code and wipes nested diagnostics', () => {
    const causeStderr = Buffer.from(SECRET_SENTINEL);
    const error = Object.assign(new Error(SECRET_SENTINEL), {
      cause: { stderr: causeStderr },
      code: 'ETIMEDOUT'
    });
    const spawn = jest.fn(() => { throw error; });

    expect(() => runGateR1PostgresR3ConfigPatch({
      profile: 'service-configuration',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_CONFIG_TIMEOUT');
    expectZeroed(causeStderr);
  });
});
