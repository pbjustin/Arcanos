import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_R3_POSTGRES_IMAGE,
  buildGateR1PostgresR3SourceActivation,
  parseGateR1PostgresR3SourceActivationArgs,
  runGateR1PostgresR3SourceActivation
} from '../scripts/gate-r1-postgres-r3-source-activation.js';
import {
  GATE_R1_R3_ENVIRONMENT_ID,
  GATE_R1_R3_POSTGRES_SERVICE_ID,
  GATE_R1_R3_PROJECT_ID
} from '../scripts/gate-r1-postgres-r3-config-patch.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const PROJECT_NAME = 'Arcanos';
const ENVIRONMENT_NAME = 'phase2e-validation-20260717';
const SERVICE_NAME = 'phase2e-postgres-r3-20260720';
const SECRET_SENTINEL = 'credential-sentinel-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze({ PATH: 'C:\\safe' });
const UNRELATED_SECRET_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['DATABASE_URL', SECRET_SENTINEL],
  ['REDIS_URL', SECRET_SENTINEL]
]));

function statusBuffer({
  project = PROJECT_NAME,
  environment = ENVIRONMENT_NAME,
  service = 'None'
} = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

function successfulSpawn(capture = {}) {
  return jest.fn((_file, args, options) => {
    if (args[0] === 'status') {
      capture.statusArgs = [...args];
      capture.statusOptions = options;
      capture.statusStdout = statusBuffer();
      capture.statusStderr = Buffer.alloc(0);
      return { status: 0, stdout: capture.statusStdout, stderr: capture.statusStderr };
    }
    capture.activationArgs = [...args];
    capture.activationOptions = options;
    capture.activationInput = options.input;
    capture.activationInputSnapshot = Buffer.from(options.input);
    capture.activationStdout = Buffer.from(`postgresql://${SECRET_SENTINEL}`);
    capture.activationStderr = Buffer.from(`Authorization: Bearer ${SECRET_SENTINEL}`);
    return {
      status: 0,
      stdout: capture.activationStdout,
      stderr: capture.activationStderr
    };
  });
}

describe('Gate R1 PostgreSQL R3 source activation', () => {
  it('constructs one exact R3-only pinned-image patch', () => {
    const activation = buildGateR1PostgresR3SourceActivation();

    expect(GATE_R1_R3_PROJECT_ID).toBe('7faf44e5-519c-4e73-8d7a-da9f389e6187');
    expect(GATE_R1_R3_ENVIRONMENT_ID).toBe('fb99f47d-5ef5-44c1-96c2-acf7b90fab13');
    expect(GATE_R1_R3_POSTGRES_SERVICE_ID).toBe('7346b3f6-bf3d-46e1-9d66-79f10847ef89');
    expect(GATE_R1_R3_POSTGRES_IMAGE).toBe('ghcr.io/railwayapp-templates/postgres-ssl:18.4');
    expect(JSON.parse(activation.patchJson)).toEqual({
      services: {
        [GATE_R1_R3_POSTGRES_SERVICE_ID]: {
          source: { image: GATE_R1_R3_POSTGRES_IMAGE }
        }
      }
    });

    const serialized = activation.patchJson;
    for (const forbidden of [
      'repo', 'deploy', 'restartPolicy', 'startCommand', 'variables', 'volume',
      'domain', 'tcpProxy', 'redis', '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      '1ac0bd56-50b3-49eb-954c-ea83515ec915'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('accepts no caller-selected target, image, profile, or operation', () => {
    expect(parseGateR1PostgresR3SourceActivationArgs(['--operation', 'activate']))
      .toEqual({ operation: 'activate' });
    for (const args of [
      [],
      ['--service-id', GATE_R1_R3_POSTGRES_SERVICE_ID],
      ['--image', GATE_R1_R3_POSTGRES_IMAGE],
      ['--profile', 'postgres-source'],
      ['--activate'],
      ['unexpected']
    ]) {
      expect(() => parseGateR1PostgresR3SourceActivationArgs(args))
        .toThrow('GATE_R1_R3_SOURCE_ARGUMENT_INVALID');
    }
  });

  it('performs one exact source assignment and no second deployment trigger', () => {
    const capture = {};
    const spawn = successfulSpawn(capture);
    const result = runGateR1PostgresR3SourceActivation({
      environment: {
        PATH: 'C:\\safe',
        ...UNRELATED_SECRET_ENVIRONMENT,
        RAILWAY_TOKEN: ''
      },
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(capture.statusArgs).toEqual(['status']);
    expect(capture.statusOptions).toMatchObject({
      maxBuffer: 512,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    expect(capture.statusOptions.env).toEqual({ PATH: 'C:\\safe' });
    expect(capture.activationArgs).toEqual([
      'environment', 'edit',
      '-e', GATE_R1_R3_ENVIRONMENT_ID,
      '-m', buildGateR1PostgresR3SourceActivation().message,
      '--json'
    ]);
    expect(capture.activationOptions).toMatchObject({
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true,
      env: { PATH: 'C:\\safe' }
    });
    expect(JSON.parse(capture.activationInputSnapshot.toString('utf8'))).toEqual(
      JSON.parse(buildGateR1PostgresR3SourceActivation().patchJson)
    );
    expect(capture.activationArgs.join(' ')).not.toMatch(/\b(up|redeploy|restart|down|service-config)\b/i);
    expect(result).toEqual({
      code: 'GATE_R1_R3_SOURCE_ACTIVATION_ACCEPTED_PENDING_PROJECTION',
      environmentId: GATE_R1_R3_ENVIRONMENT_ID,
      projectId: GATE_R1_R3_PROJECT_ID,
      projectionRequired: true,
      retryAuthorized: false,
      serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
      status: 'PENDING_PROJECTION'
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expectZeroed(capture.statusStdout);
    expectZeroed(capture.activationInput);
    expectZeroed(capture.activationStdout);
    expectZeroed(capture.activationStderr);
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before status or activation',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR1PostgresR3SourceActivation({
        environment: { PATH: 'safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R1_R3_SOURCE_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['wrong project', { project: 'Another project' }],
    ['wrong environment', { environment: 'production' }],
    ['selected service', { service: SERVICE_NAME }]
  ])('rejects a %s link before source assignment', (_name, override) => {
    const stdout = statusBuffer(override);
    const stderr = Buffer.alloc(0);
    const spawn = jest.fn(() => ({ status: 0, stdout, stderr }));

    expect(() => runGateR1PostgresR3SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_SOURCE_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stdout);
  });

  it.each([
    ['nonzero exit', () => ({ status: 1, stdout: Buffer.from(SECRET_SENTINEL), stderr: Buffer.from(SECRET_SENTINEL) })],
    ['timeout result', () => ({
      error: Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT' }),
      status: null,
      stdout: Buffer.from(SECRET_SENTINEL),
      stderr: Buffer.from(SECRET_SENTINEL)
    })],
    ['success with arbitrary ignored output', () => ({
      status: 0,
      stdout: Buffer.from(`not-an-ack ${SECRET_SENTINEL}`),
      stderr: Buffer.from(SECRET_SENTINEL)
    })]
  ])('treats activation %s according to one-shot projection semantics', (name, activationResult) => {
    const statusStdout = statusBuffer();
    const result = activationResult();
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce(result);

    const invoke = () => runGateR1PostgresR3SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    });

    if (name === 'success with arbitrary ignored output') {
      expect(invoke()).toMatchObject({ status: 'PENDING_PROJECTION', retryAuthorized: false });
    } else {
      expect(invoke).toThrow('GATE_R1_R3_SOURCE_ACTIVATION_AMBIGUOUS');
    }
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(statusStdout);
    expectZeroed(result.stdout);
    expectZeroed(result.stderr);
  });

  it('maps a thrown activation failure to ambiguity, clears nested diagnostics, and never retries', () => {
    const statusStdout = statusBuffer();
    const stderr = Buffer.from(SECRET_SENTINEL);
    const causeStdout = Buffer.from(SECRET_SENTINEL);
    const error = Object.assign(new Error(SECRET_SENTINEL), {
      cause: { stdout: causeStdout },
      code: 'ETIMEDOUT',
      stderr
    });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockImplementationOnce(() => { throw error; });

    expect(() => runGateR1PostgresR3SourceActivation({
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R1_R3_SOURCE_ACTIVATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(stderr);
    expectZeroed(causeStdout);
  });
});
