import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_REDIS_ENVIRONMENT_ID,
  GATE_R1_REDIS_ENVIRONMENT_NAME,
  GATE_R1_REDIS_SERVICE_ID
} from '../scripts/gate-r1-redis-r2-config-patch.js';
import {
  GATE_R1_REDIS_IMAGE,
  buildGateR1RedisR2SourceActivation,
  parseGateR1RedisR2SourceActivationArgs,
  runGateR1RedisR2SourceActivation
} from '../scripts/gate-r1-redis-r2-source-activation.js';
import { GATE_R1_APPROVED_IMAGES_BY_SERVICE } from '../scripts/gate-r1-railway-metadata-projector.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'redis-source-secret-must-not-escape';
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

describe('Gate R1 Redis R2 one-shot source activation', () => {
  it('accepts only the explicit activation operation', () => {
    expect(parseGateR1RedisR2SourceActivationArgs(['--operation', 'activate']))
      .toEqual({ operation: 'activate' });
    for (const argv of [
      [],
      ['activate'],
      ['--operation', 'activate', '--again'],
      ['--operation', 'retry'],
      ['--service-id', GATE_R1_REDIS_SERVICE_ID]
    ]) {
      expect(() => parseGateR1RedisR2SourceActivationArgs(argv))
        .toThrow('GATE_R1_REDIS_SOURCE_ARGUMENT_INVALID');
    }
  });

  it('builds only the fixed Redis image patch for the exact retained service', () => {
    expect(GATE_R1_REDIS_IMAGE).toBe('redis:8.2.1');
    expect(GATE_R1_REDIS_IMAGE)
      .toBe(GATE_R1_APPROVED_IMAGES_BY_SERVICE['phase2e-redis-r2-20260718']);
    expect(buildGateR1RedisR2SourceActivation()).toEqual({
      args: [
        'environment', 'edit',
        '-e', GATE_R1_REDIS_ENVIRONMENT_ID,
        '-m', 'gate-r: activate private redis replacement',
        '--json'
      ],
      message: 'gate-r: activate private redis replacement',
      patchJson: JSON.stringify({
        services: {
          [GATE_R1_REDIS_SERVICE_ID]: { source: { image: 'redis:8.2.1' } }
        }
      })
    });
  });

  it('checks the exact link and submits the one fixed source patch through stdin once', () => {
    const statusStdout = statusBuffer();
    let submittedPatch;
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce((_file, _args, options) => {
        submittedPatch = Buffer.from(options.input);
        return { status: 0, stdout: Buffer.from(SECRET_SENTINEL), stderr: Buffer.from(SECRET_SENTINEL) };
      });

    const result = runGateR1RedisR2SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(['status']);
    expect(spawn.mock.calls[1][1]).toEqual(buildGateR1RedisR2SourceActivation().args);
    expect(spawn.mock.calls[1][2]).toMatchObject({
      env: { PATH: 'C:\\safe' },
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true
    });
    expect(JSON.parse(submittedPatch.toString('utf8'))).toEqual({
      services: {
        [GATE_R1_REDIS_SERVICE_ID]: { source: { image: GATE_R1_REDIS_IMAGE } }
      }
    });
    expect(result).toEqual({
      code: 'GATE_R1_REDIS_SOURCE_ACTIVATION_ACCEPTED_PENDING_PROJECTION',
      environmentId: GATE_R1_REDIS_ENVIRONMENT_ID,
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      projectionRequired: true,
      retryAuthorized: false,
      serviceId: GATE_R1_REDIS_SERVICE_ID,
      status: 'PENDING_PROJECTION'
    });
    expectZeroed(statusStdout);
    expectZeroed(spawn.mock.results[1].value.stdout);
    expectZeroed(spawn.mock.results[1].value.stderr);
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before any target or source operation',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR1RedisR2SourceActivation({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_REDIS_SOURCE_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects a wrong isolated link before source mutation', () => {
    const stdout = statusBuffer({ environment: 'production' });
    const spawn = jest.fn(() => ({ status: 0, stdout, stderr: Buffer.alloc(0) }));

    expect(() => runGateR1RedisR2SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_SOURCE_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stdout);
  });

  it.each([
    ['nonzero', { status: 1, stdout: Buffer.from(SECRET_SENTINEL), stderr: Buffer.from(SECRET_SENTINEL) }],
    ['timeout', {
      error: Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT' }),
      status: null,
      stdout: Buffer.from(SECRET_SENTINEL),
      stderr: Buffer.from(SECRET_SENTINEL)
    }]
  ])('treats %s source result as ambiguous, clears diagnostics, and never retries', (_name, sourceResult) => {
    const statusStdout = statusBuffer();
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce(sourceResult);

    expect(() => runGateR1RedisR2SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_SOURCE_ACTIVATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(sourceResult.stdout);
    expectZeroed(sourceResult.stderr);
  });

  it('maps hostile source diagnostics to ambiguity without invoking accessors', () => {
    const statusStdout = statusBuffer();
    const output = Buffer.from(SECRET_SENTINEL);
    const causeOutput = Buffer.from(SECRET_SENTINEL);
    const hostile = Object.create(null, {
      cause: { value: { stderr: causeOutput } },
      message: { value: SECRET_SENTINEL },
      output: { value: [output] },
      stdout: {
        get() {
          throw new Error(SECRET_SENTINEL);
        }
      }
    });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce(() => { throw hostile; });

    expect(() => runGateR1RedisR2SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_REDIS_SOURCE_ACTIVATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(output);
    expectZeroed(causeOutput);
  });
});
