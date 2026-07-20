import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_ENVIRONMENT_ID,
  GATE_R2_ENVIRONMENT_NAME,
  GATE_R2_PROJECT_ID,
  GATE_R2_RETIREMENT_TARGETS,
  buildGateR2RetirementPatch,
  parseGateR2RetirementArgs,
  runGateR2ServiceInstanceRetirement
} from '../scripts/gate-r2-service-instance-retirement.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'retirement-secret-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['DATABASE_URL', SECRET_SENTINEL],
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['PATH', 'C:\\safe']
]));
const ACTIVE_REPLACEMENT_SERVICE_IDS = Object.freeze([
  '7346b3f6-bf3d-46e1-9d66-79f10847ef89',
  '1ac0bd56-50b3-49eb-954c-ea83515ec915'
]);

function statusBuffer({ project = 'Arcanos', environment = GATE_R2_ENVIRONMENT_NAME, service = 'None' } = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function statusJsonBuffer() {
  return Buffer.from(JSON.stringify({
    environmentId: GATE_R2_ENVIRONMENT_ID,
    environmentName: GATE_R2_ENVIRONMENT_NAME,
    projectId: GATE_R2_PROJECT_ID,
    projectName: 'Arcanos'
  }));
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

describe('Gate R2 fixed service-instance retirement', () => {
  it('hard-binds the exact three obsolete service-instance profiles', () => {
    expect(GATE_R2_RETIREMENT_TARGETS).toEqual({
      'failed-postgres-r2': {
        message: 'gate-r2: retire failed postgres r2 service instance',
        serviceId: 'a2a57da4-a928-427f-be30-d4a68b59a117',
        serviceInstanceId: 'e8c42bea-d887-485b-8aaf-ba0f45d439e8',
        serviceName: 'phase2e-postgres-r2-20260718'
      },
      'original-postgres': {
        message: 'gate-r2: retire original preview postgres service instance',
        serviceId: 'b7789306-8aef-4113-add5-02883a6cc087',
        serviceInstanceId: '6dac21a3-ad8a-4b98-ad50-637054c13729',
        serviceName: 'Postgres'
      },
      'original-redis': {
        message: 'gate-r2: retire original preview redis service instance',
        serviceId: '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
        serviceInstanceId: '8340f02f-dbcb-4c0e-bdde-b3f7c4bf5856',
        serviceName: 'Redis'
      }
    });
  });

  it.each(Object.keys(GATE_R2_RETIREMENT_TARGETS))(
    'builds one service-only isDeleted patch for %s',
    profile => {
      const definition = buildGateR2RetirementPatch(profile);
      const patch = JSON.parse(definition.patchJson);

      expect(patch).toEqual({
        services: { [definition.serviceId]: { isDeleted: true } }
      });
      expect(Object.keys(patch.services)).toHaveLength(1);
      expect(definition.patchJson.length).toBeGreaterThan(0);
      for (const forbidden of [
        ...ACTIVE_REPLACEMENT_SERVICE_IDS,
        'volume',
        'deploy',
        'source',
        'variables',
        'domain',
        'tcpProxy'
      ]) {
        expect(definition.patchJson).not.toContain(forbidden);
      }
    }
  );

  it('rejects caller-selected IDs and every unknown profile before spawning Railway', () => {
    const spawn = jest.fn();
    for (const profile of [undefined, null, '', 'original-postgres ', 'POSTGRES', '__proto__']) {
      expect(() => runGateR2ServiceInstanceRetirement({
        profile,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('accepts only one exact fixed profile argument and no caller-selected identifier', () => {
    for (const profile of Object.keys(GATE_R2_RETIREMENT_TARGETS)) {
      expect(parseGateR2RetirementArgs(['--profile', profile])).toEqual({ profile });
    }
    for (const argv of [
      [],
      ['--profile'],
      ['--profile', 'original-postgres', '--service-id', 'arbitrary'],
      ['--service-id', 'b7789306-8aef-4113-add5-02883a6cc087'],
      ['--profile', 'ORIGINAL-POSTGRES']
    ]) {
      expect(() => parseGateR2RetirementArgs(argv))
        .toThrow('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
    }
  });

  it.each(Object.keys(GATE_R2_RETIREMENT_TARGETS))(
    'checks the isolated link and submits exactly one nonempty stdin mutation for %s',
    profile => {
      const definition = buildGateR2RetirementPatch(profile);
      const statusStdout = statusBuffer();
      const statusJsonStdout = statusJsonBuffer();
      const mutationStdout = Buffer.from(SECRET_SENTINEL);
      let submittedInput;
      const spawn = jest.fn()
        .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
        .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
        .mockImplementationOnce((_file, _args, options) => {
          submittedInput = Buffer.from(options.input);
          return { status: 0, stdout: mutationStdout, stderr: Buffer.alloc(0) };
        });

      const result = runGateR2ServiceInstanceRetirement({
        environment: SAFE_ENVIRONMENT,
        profile,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      });

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn.mock.calls[0][1]).toEqual([
        'link', '-p', GATE_R2_PROJECT_ID, '-e', GATE_R2_ENVIRONMENT_ID, '--json'
      ]);
      expect(spawn.mock.calls[0][2].env).toEqual({ PATH: 'C:\\safe' });
      expect(spawn.mock.calls[1][1]).toEqual(['status']);
      expect(spawn.mock.calls[2][2].cwd).toBe(spawn.mock.calls[0][2].cwd);
      expect(spawn.mock.calls[2][1]).toEqual([
        'environment', 'edit',
        '-e', GATE_R2_ENVIRONMENT_ID,
        '-m', definition.message,
        '--json'
      ]);
      expect(spawn.mock.calls[2][2]).toMatchObject({
        env: { PATH: 'C:\\safe' },
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 30_000,
        windowsHide: true
      });
      expect(submittedInput.length).toBeGreaterThan(0);
      expect(JSON.parse(submittedInput.toString('utf8'))).toEqual(
        JSON.parse(definition.patchJson)
      );
      expect(result).toEqual({
        code: 'GATE_R2_RETIREMENT_ACCEPTED_PENDING_PROJECTION',
        environmentId: GATE_R2_ENVIRONMENT_ID,
        profile,
        projectId: GATE_R2_PROJECT_ID,
        projectionRequired: true,
        retryAuthorized: false,
        serviceId: definition.serviceId,
        serviceInstanceId: definition.serviceInstanceId,
        status: 'PENDING_PROJECTION'
      });
      expectZeroed(statusStdout);
      expectZeroed(statusJsonStdout);
      expectZeroed(mutationStdout);
    }
  );

  it.each([...GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES, 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN'])(
    'rejects ambient %s before checking the link',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR2ServiceInstanceRetirement({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        profile: 'original-postgres',
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R2_RETIREMENT_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['wrong project', { project: 'Another' }],
    ['wrong environment', { environment: 'production' }],
    ['selected service', { service: 'Postgres' }]
  ])('stops before mutation for %s', (_name, statusOverrides) => {
    const stdout = statusBuffer(statusOverrides);
    const stderr = Buffer.alloc(0);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonBuffer(), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout, stderr });

    expect(() => runGateR2ServiceInstanceRetirement({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_RETIREMENT_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(stdout);
  });

  it('maps a pre-mutation status timeout to a fixed code without retrying', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const timeout = Object.assign(new Error(SECRET_SENTINEL), {
      code: 'ETIMEDOUT',
      stderr
    });
    const spawn = jest.fn(() => { throw timeout; });

    expect(() => runGateR2ServiceInstanceRetirement({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_RETIREMENT_TIMEOUT');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stderr);
  });

  it.each([
    ['timed out', { error: Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT' }), status: null }],
    ['returned nonzero', { status: 1 }]
  ])('maps a mutation that %s to no-retry ambiguity and wipes diagnostics', (_name, mutationResult) => {
    const statusStdout = statusBuffer();
    const statusJsonStdout = statusJsonBuffer();
    const stdout = Buffer.from(SECRET_SENTINEL);
    const stderr = Buffer.from(SECRET_SENTINEL);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ ...mutationResult, stdout, stderr });

    expect(() => runGateR2ServiceInstanceRetirement({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it('does not parse Railway mutation stdout or retry after accepted invocation', () => {
    const statusStdout = statusBuffer();
    const statusJsonStdout = statusJsonBuffer();
    const mutationStdout = Buffer.from(JSON.stringify(Object.fromEntries([
      ['committed', false],
      [['sec', 'ret'].join(''), SECRET_SENTINEL]
    ])));
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: mutationStdout, stderr: Buffer.alloc(0) });

    expect(runGateR2ServiceInstanceRetirement({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-redis',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toMatchObject({
      code: 'GATE_R2_RETIREMENT_ACCEPTED_PENDING_PROJECTION',
      projectionRequired: true,
      retryAuthorized: false
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(mutationStdout);
  });

  it('maps hostile thrown diagnostics to a fixed ambiguous code without invoking accessors', () => {
    const statusStdout = statusBuffer();
    const statusJsonStdout = statusJsonBuffer();
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
      .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce(() => { throw hostile; });

    expect(() => runGateR2ServiceInstanceRetirement({
      environment: SAFE_ENVIRONMENT,
      profile: 'failed-postgres-r2',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(output);
    expectZeroed(causeOutput);
  });

  it('treats fixed-link cleanup failure after mutation invocation as ambiguous', () => {
    const spawn = jest.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const fixedLink = jest.fn(({ operation }) => {
      operation('C:\\fixed-temp\\arcanos-gate-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      throw new Error('GATE_R2_RETIREMENT_TARGET_MISMATCH');
    });
    expect(() => runGateR2ServiceInstanceRetirement({
      environment: SAFE_ENVIRONMENT,
      fixedLink,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
