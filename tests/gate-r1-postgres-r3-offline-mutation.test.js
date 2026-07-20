import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_R3_POSTGRES_VARIABLES,
  GATE_R1_R3_POSTGRES_VOLUME_MOUNT,
  buildGateR1PostgresR3OfflineInvocation,
  encodeGateR1Base64Url,
  runGateR1PostgresR3OfflineMutation
} from '../scripts/gate-r1-postgres-r3-offline-mutation.js';
import {
  GATE_R1_R3_ENVIRONMENT_ID,
  GATE_R1_R3_ENVIRONMENT_NAME,
  GATE_R1_R3_POSTGRES_SERVICE_ID,
  GATE_R1_R3_PROJECT_ID,
  GATE_R1_R3_PROJECT_NAME
} from '../scripts/gate-r1-postgres-r3-config-patch.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'credential-sentinel-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze({ PATH: 'C:\\safe' });
const UNRELATED_SECRET_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['DATABASE_URL', SECRET_SENTINEL],
  ['REDIS_URL', SECRET_SENTINEL]
]));

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

function successfulSpawn(capture = {}) {
  return jest.fn((_file, args, options) => {
    if (args[0] === 'status') {
      capture.statusOptions = options;
      capture.statusStdout = statusBuffer();
      capture.statusStderr = Buffer.alloc(0);
      return { status: 0, stdout: capture.statusStdout, stderr: capture.statusStderr };
    }
    capture.mutationArgs = [...args];
    capture.mutationOptions = options;
    capture.mutationInput = options.input;
    capture.mutationInputSnapshot = Buffer.isBuffer(options.input)
      ? Buffer.from(options.input)
      : undefined;
    capture.mutationStdout = Buffer.from(`postgresql://${SECRET_SENTINEL}`);
    capture.mutationStderr = Buffer.from(`Authorization: Bearer ${SECRET_SENTINEL}`);
    return {
      status: 0,
      stdout: capture.mutationStdout,
      stderr: capture.mutationStderr
    };
  });
}

describe('Gate R1 PostgreSQL R3 offline mutations', () => {
  it('encodes exactly 32 bytes as a 43-byte base64url buffer without padding', () => {
    const input = Buffer.from(Array.from({ length: 32 }, (_value, index) => index));
    const encoded = encodeGateR1Base64Url(input);

    expect(encoded).toHaveLength(43);
    expect(encoded.toString('ascii')).toBe(input.toString('base64url'));
    expect(encoded.toString('ascii')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(encoded).not.toContain(0x3d);
  });

  it('exposes only three closed operations with exact R3 targets and fixed values', () => {
    const volume = buildGateR1PostgresR3OfflineInvocation('volume');
    const credential = buildGateR1PostgresR3OfflineInvocation('credential');
    const variables = buildGateR1PostgresR3OfflineInvocation('variables');

    expect(volume.args).toEqual([
      'volume',
      '--service', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--environment', GATE_R1_R3_ENVIRONMENT_ID,
      'add',
      '--mount-path', GATE_R1_R3_POSTGRES_VOLUME_MOUNT,
      '--json'
    ]);
    expect(credential.args).toEqual([
      'variable', 'set',
      '--service', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--environment', GATE_R1_R3_ENVIRONMENT_ID,
      '--stdin', '--skip-deploys', '--json', 'POSTGRES_PASSWORD'
    ]);
    expect(variables.args).toEqual([
      'variable', 'set',
      '--service', GATE_R1_R3_POSTGRES_SERVICE_ID,
      '--environment', GATE_R1_R3_ENVIRONMENT_ID,
      '--skip-deploys', '--json',
      ...GATE_R1_R3_POSTGRES_VARIABLES
    ]);
    expect(GATE_R1_R3_POSTGRES_VARIABLES).toHaveLength(11);
    const serialized = [volume.args, credential.args, variables.args].flat().join('\n');
    expect(serialized).not.toContain('PUBLIC_URL');
    expect(serialized).not.toContain('redis');
    expect(serialized).not.toContain('b7789306-8aef-4113-add5-02883a6cc087');
    expect(serialized).not.toContain('a2a57da4-a928-427f-be30-d4a68b59a117');
  });

  it('rejects every unknown or caller-shaped operation before token, randomness, or spawn access', () => {
    const spawn = jest.fn();
    const randomFill = jest.fn();
    for (const operation of [undefined, null, '', {}, 'postgres-source', 'redis', '__proto__']) {
      expect(() => runGateR1PostgresR3OfflineMutation({
        operation,
        environment: { RAILWAY_TOKEN: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        randomFill,
        spawn
      })).toThrow('GATE_R1_R3_OFFLINE_ARGUMENT_INVALID');
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(randomFill).not.toHaveBeenCalled();
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before spawning or generating a credential',
    tokenName => {
      const spawn = jest.fn();
      const randomFill = jest.fn();
      expect(() => runGateR1PostgresR3OfflineMutation({
        operation: 'credential',
        environment: { PATH: 'safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        randomFill,
        spawn
      })).toThrow('GATE_R1_R3_OFFLINE_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
      expect(randomFill).not.toHaveBeenCalled();
    }
  );

  it.each(['volume', 'variables'])(
    'runs the exact %s command once after the exact unselected link check',
    operation => {
      const capture = {};
      const spawn = successfulSpawn(capture);
      const result = runGateR1PostgresR3OfflineMutation({
        operation,
        environment: {
          PATH: 'safe',
          RAILWAY_TOKEN: '',
          ...UNRELATED_SECRET_ENVIRONMENT
        },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      });

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[0][1]).toEqual(['status']);
      expect(capture.statusOptions).toMatchObject({
        maxBuffer: 512,
        shell: false,
        timeout: 30_000,
        windowsHide: true
      });
      expect(capture.statusOptions.env).toEqual({ PATH: 'safe' });
      expect(capture.mutationArgs).toEqual(
        buildGateR1PostgresR3OfflineInvocation(operation).args
      );
      expect(capture.mutationOptions).toMatchObject({
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 30_000,
        windowsHide: true
      });
      expect(capture.mutationOptions.env).toEqual({ PATH: 'safe' });
      expect(result).toMatchObject({
        environmentId: GATE_R1_R3_ENVIRONMENT_ID,
        operation,
        projectId: GATE_R1_R3_PROJECT_ID,
        projectionRequired: true,
        retryAuthorized: false,
        serviceId: GATE_R1_R3_POSTGRES_SERVICE_ID,
        status: 'PENDING_PROJECTION'
      });
      expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
      expectZeroed(capture.statusStdout);
      expectZeroed(capture.mutationStdout);
      expectZeroed(capture.mutationStderr);
    }
  );

  it('generates the password only after target validation and passes it only through stdin', () => {
    const capture = {};
    const spawn = successfulSpawn(capture);
    let entropy;
    const randomFill = jest.fn(buffer => {
      entropy = buffer;
      buffer.set(Array.from({ length: 32 }, (_value, index) => index + 1));
      return buffer;
    });

    const result = runGateR1PostgresR3OfflineMutation({
      operation: 'credential',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      randomFill,
      spawn
    });

    expect(randomFill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(capture.mutationArgs).not.toContain(capture.mutationInputSnapshot.toString('ascii'));
    expect(capture.mutationArgs.at(-1)).toBe('POSTGRES_PASSWORD');
    expect(capture.mutationOptions.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(capture.mutationInputSnapshot).toHaveLength(43);
    expect(capture.mutationInputSnapshot.toString('ascii')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expectZeroed(entropy);
    expectZeroed(capture.mutationInput);
    expect(result.code).toBe('GATE_R1_R3_PASSWORD_ACCEPTED_PENDING_PROJECTION');
  });

  it('does not generate a password when the exact link check fails', () => {
    const stdout = statusBuffer({ environment: 'production' });
    const spawn = jest.fn(() => ({ status: 0, stdout, stderr: Buffer.alloc(0) }));
    const randomFill = jest.fn();

    expect(() => runGateR1PostgresR3OfflineMutation({
      operation: 'credential',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      randomFill,
      spawn
    })).toThrow('GATE_R1_R3_OFFLINE_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(randomFill).not.toHaveBeenCalled();
    expectZeroed(stdout);
  });

  it('maps generator failure to a fixed code and wipes the entropy buffer', () => {
    const capture = {};
    let entropy;
    const randomFill = jest.fn(buffer => {
      entropy = buffer;
      buffer.fill(0x41);
      throw new Error(SECRET_SENTINEL);
    });
    const spawn = successfulSpawn(capture);

    expect(() => runGateR1PostgresR3OfflineMutation({
      operation: 'credential',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      randomFill,
      spawn
    })).toThrow('GATE_R1_R3_OFFLINE_CREDENTIAL_GENERATION_FAILED');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(entropy);
  });

  it.each([
    ['volume', 'GATE_R1_R3_VOLUME_MUTATION_AMBIGUOUS'],
    ['credential', 'GATE_R1_R3_PASSWORD_MUTATION_AMBIGUOUS'],
    ['variables', 'GATE_R1_R3_VARIABLES_MUTATION_AMBIGUOUS']
  ])('maps a failed %s mutation to a fixed no-retry code and wipes diagnostics', (operation, code) => {
    const statusStdout = statusBuffer();
    const mutationStdout = Buffer.from(`postgresql://${SECRET_SENTINEL}`);
    const mutationStderr = Buffer.from(`Bearer ${SECRET_SENTINEL}`);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 1, stdout: mutationStdout, stderr: mutationStderr });

    expect(() => runGateR1PostgresR3OfflineMutation({
      operation,
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      randomFill: buffer => buffer.fill(0x41),
      spawn
    })).toThrow(code);
    expectZeroed(statusStdout);
    expectZeroed(mutationStdout);
    expectZeroed(mutationStderr);
  });

  it('maps timeouts and thrown child diagnostics to fixed non-sensitive failures', () => {
    const timeoutStderr = Buffer.from(SECRET_SENTINEL);
    const timeout = Object.assign(new Error(SECRET_SENTINEL), {
      code: 'ETIMEDOUT',
      stderr: timeoutStderr
    });
    const timedOutSpawn = jest.fn(() => ({ error: timeout, status: null }));
    expect(() => runGateR1PostgresR3OfflineMutation({
      operation: 'volume',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn: timedOutSpawn
    })).toThrow('GATE_R1_R3_OFFLINE_TIMEOUT');
    expectZeroed(timeoutStderr);

    const thrownStderr = Buffer.from(SECRET_SENTINEL);
    const causeStderr = Buffer.from(SECRET_SENTINEL);
    const thrownSpawn = jest.fn(() => {
      throw Object.assign(new Error(SECRET_SENTINEL), {
        cause: { stderr: causeStderr },
        code: 'ETIMEDOUT',
        stderr: thrownStderr
      });
    });
    expect(() => runGateR1PostgresR3OfflineMutation({
      operation: 'variables',
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn: thrownSpawn
    })).toThrow('GATE_R1_R3_OFFLINE_TIMEOUT');
    expectZeroed(thrownStderr);
    expectZeroed(causeStderr);
  });
});
