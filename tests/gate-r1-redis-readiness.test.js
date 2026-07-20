import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  GATE_R_ENVIRONMENT_ID,
  GATE_R_PROJECT_ID,
  GATE_R_REDIS_SERVICE_NAME,
  buildRedisReadinessInvocation,
  resolveRedisRailwayExecutable,
  runRedisReadiness
} from '../scripts/gate-r1-redis-readiness.js';
import { GATE_R1_REDIS_SERVICE_ID } from '../scripts/gate-r1-redis-r2-config-patch.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const REPLACEMENT_SERVICE_ID = GATE_R1_REDIS_SERVICE_ID;
const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'credential-sentinel-should-not-escape';
const ORIGINAL_REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const SAFE_ENVIRONMENT = Object.freeze({
  DATABASE_URL: SECRET_SENTINEL,
  PROVIDER_TEST_INPUT: SECRET_SENTINEL,
  PATH: 'C:\\safe'
});

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

function modelRailwayCli4302Command(args) {
  const commandArguments = args.slice(7);
  return Object.freeze({
    args: Object.freeze(['-c', commandArguments.join(' ')]),
    commandArguments: Object.freeze(commandArguments),
    file: 'sh'
  });
}

afterEach(() => {
  if (ORIGINAL_REDIS_PASSWORD === undefined) {
    delete process.env.REDIS_PASSWORD;
  } else {
    process.env.REDIS_PASSWORD = ORIGINAL_REDIS_PASSWORD;
  }
  jest.restoreAllMocks();
});

describe('Gate R1 authenticated Redis readiness', () => {
  it('resolves the executable directly on non-Windows platforms', () => {
    const exists = jest.fn();

    expect(resolveRedisRailwayExecutable({ platform: 'linux', exists })).toBe('railway');
    expect(exists).not.toHaveBeenCalled();
  });

  it('maps missing and exceptional Windows executable discovery to one fixed code', () => {
    expect(() =>
      resolveRedisRailwayExecutable({
        platform: 'win32',
        pathValue: 'C:\\missing',
        exists: () => false
      })
    ).toThrow('GATE_R_REDIS_READINESS_CLI_UNAVAILABLE');
    expect(() =>
      resolveRedisRailwayExecutable({
        platform: 'win32',
        pathValue: 'C:\\hostile',
        exists: () => {
          throw new Error(SECRET_SENTINEL);
        }
      })
    ).toThrow('GATE_R_REDIS_READINESS_CLI_UNAVAILABLE');
  });

  it('builds an exact-target, authenticated, non-data-mutating Railway SSH invocation', () => {
    process.env.REDIS_PASSWORD = SECRET_SENTINEL;
    const invocation = buildRedisReadinessInvocation({
      serviceId: REPLACEMENT_SERVICE_ID,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      environment: SAFE_ENVIRONMENT
    });
    const serialized = invocation.args.join(' ');

    expect(invocation.file).toBe(TEST_RAILWAY_EXECUTABLE);
    expect(invocation.args.slice(0, 7)).toEqual([
      'ssh',
      '-p',
      GATE_R_PROJECT_ID,
      '-e',
      GATE_R_ENVIRONMENT_ID,
      '-s',
      REPLACEMENT_SERVICE_ID
    ]);
    expect(invocation.args.slice(7)).toEqual([expect.any(String)]);
    expect(invocation.options).toMatchObject({ shell: false, timeout: 30_000, windowsHide: true });
    expect(invocation.options.env).toEqual({ PATH: 'C:\\safe' });
    expect(invocation.options.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(serialized).toContain(`RAILWAY_SERVICE_NAME:-}" = "${GATE_R_REDIS_SERVICE_NAME}`);
    expect(serialized).toContain('REDISCLI_AUTH="$REDIS_PASSWORD"');
    expect(serialized).toContain('redis-cli --raw -h 127.0.0.1 -p 6379 --no-auth-warning PING');
    expect(serialized).toContain('test "$response" = PONG');
    expect(serialized).toContain('2>/dev/null');
    expect(serialized).toContain('exit 70');
    expect(serialized).toContain('exit 71');
    expect(serialized).toContain('exit 72');
    expect(serialized).toContain('exit 73');
    expect(serialized).toContain('exit 74');
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toMatch(/redis-cli\s+(?:[^;]*\s)?(?:-a|--pass|--user)\b/);
    expect(serialized).not.toMatch(/(?:redis|rediss):\/\//i);
    expect(serialized).not.toMatch(/\b(echo|env|printenv|printf|set\s+-x)\b/);
    expect(serialized).not.toMatch(/\b(SET|DEL|FLUSHALL|FLUSHDB|CONFIG|EVAL|SCRIPT)\b/);
  });

  it('passes one fixed command through the Railway CLI 4.30.2 outer shell without nesting', () => {
    const invocation = buildRedisReadinessInvocation({
      serviceId: REPLACEMENT_SERVICE_ID,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      environment: SAFE_ENVIRONMENT
    });
    const modeled = modelRailwayCli4302Command(invocation.args);
    const [remoteCommand] = modeled.commandArguments;

    expect(modeled.file).toBe('sh');
    expect(modeled.args).toEqual(['-c', remoteCommand]);
    expect(modeled.commandArguments).toHaveLength(1);
    expect(remoteCommand).toMatch(/^test "\$\{RAILWAY_PROJECT_ID:-\}"/u);
    expect(remoteCommand).not.toMatch(/^sh\s+-lc\b/u);
    expect(remoteCommand).toContain('|| exit 70');
    expect(remoteCommand).toContain('REDISCLI_AUTH="$REDIS_PASSWORD"');
    expect(remoteCommand).toContain('redis-cli --raw');
    expect(remoteCommand).toContain('2>/dev/null');
  });

  it('suppresses and clears unexpected child output on success', () => {
    const stdout = Buffer.from(`redis://${SECRET_SENTINEL}`);
    const stderr = Buffer.from(`Authorization: Bearer ${SECRET_SENTINEL}`);
    const fakeSpawn = jest.fn(() => ({
      error: undefined,
      output: [null, stdout, stderr],
      signal: null,
      status: 0,
      stderr,
      stdout
    }));

    const result = runRedisReadiness({
      serviceId: REPLACEMENT_SERVICE_ID,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      environment: SAFE_ENVIRONMENT,
      spawn: fakeSpawn
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(fakeSpawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(result).toEqual({
      code: 'GATE_R_REDIS_AUTHENTICATED_READINESS_PASSED',
      environmentId: GATE_R_ENVIRONMENT_ID,
      projectId: GATE_R_PROJECT_ID,
      serviceId: REPLACEMENT_SERVICE_ID,
      status: 'PASS'
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it.each([
    [70, 'GATE_R_REDIS_READINESS_REMOTE_TARGET_MISMATCH'],
    [71, 'GATE_R_REDIS_READINESS_CREDENTIAL_CONFIGURATION_INVALID'],
    [72, 'GATE_R_REDIS_READINESS_CLIENT_UNAVAILABLE'],
    [73, 'GATE_R_REDIS_READINESS_TIMEOUT'],
    [74, 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED'],
    [1, 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED'],
    [null, 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED'],
    ['0', 'GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED']
  ])('maps child status %s to fixed diagnostics only', (status, expectedMessage) => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const fakeSpawn = jest.fn(() => ({ status, stderr }));

    expect(() =>
      runRedisReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        environment: SAFE_ENVIRONMENT,
        spawn: fakeSpawn
      })
    ).toThrow(expectedMessage);
    expectZeroed(stderr);
  });

  it.each([
    ['ETIMEDOUT', 'GATE_R_REDIS_READINESS_TIMEOUT'],
    ['ENOENT', 'GATE_R_REDIS_READINESS_CLI_UNAVAILABLE'],
    ['EACCES', 'GATE_R_REDIS_READINESS_CLI_UNAVAILABLE'],
    ['EINVAL', 'GATE_R_REDIS_READINESS_CLI_UNAVAILABLE']
  ])('maps spawn error %s to a fixed message and clears diagnostics', (code, expectedMessage) => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const nested = { stderr };
    const error = Object.assign(new Error(SECRET_SENTINEL), { code, error: nested });
    const fakeSpawn = jest.fn(() => ({ error, status: null }));

    expect(() =>
      runRedisReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        environment: SAFE_ENVIRONMENT,
        spawn: fakeSpawn
      })
    ).toThrow(expectedMessage);
    expectZeroed(stderr);
  });

  it('maps hostile thrown diagnostics to a fixed message without invoking accessors', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const causeBuffer = Buffer.from(SECRET_SENTINEL);
    const hostile = Object.create(null, {
      cause: { value: { stderr: causeBuffer } },
      code: {
        get() {
          throw new Error(SECRET_SENTINEL);
        }
      },
      message: { value: SECRET_SENTINEL },
      stderr: {
        get() {
          throw new Error(SECRET_SENTINEL);
        }
      },
      output: { value: [stderr] }
    });
    const fakeSpawn = jest.fn(() => {
      throw hostile;
    });

    expect(() =>
      runRedisReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        environment: SAFE_ENVIRONMENT,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_REDIS_AUTHENTICATED_READINESS_FAILED');
    expectZeroed(stderr);
    expectZeroed(causeBuffer);
  });

  it('rejects wrong project, environment, malformed, missing, and quarantined targets before execution', () => {
    const fakeSpawn = jest.fn();
    const common = {
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn: fakeSpawn
    };

    expect(() =>
      runRedisReadiness({
        ...common,
        projectId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() =>
      runRedisReadiness({
        ...common,
        environmentId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() => runRedisReadiness({ ...common, serviceId: 'not-a-uuid' })).toThrow(
      'GATE_R_REDIS_READINESS_SERVICE_INVALID'
    );
    expect(() => runRedisReadiness({ ...common, serviceId: undefined })).toThrow(
      'GATE_R_REDIS_READINESS_SERVICE_INVALID'
    );
    for (const serviceId of [
      'b7789306-8aef-4113-add5-02883a6cc087',
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      '11111111-2222-4333-8444-555555555555'
    ]) {
      expect(() => runRedisReadiness({ ...common, serviceId })).toThrow(
        'GATE_R_REDIS_READINESS_SERVICE_FORBIDDEN'
      );
    }
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('rejects an empty executable before execution', () => {
    const fakeSpawn = jest.fn();

    expect(() =>
      runRedisReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: '',
        environment: SAFE_ENVIRONMENT,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_REDIS_READINESS_CLI_UNAVAILABLE');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before starting Railway',
    tokenName => {
      const fakeSpawn = jest.fn();
      expect(() => runRedisReadiness({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        serviceId: REPLACEMENT_SERVICE_ID,
        spawn: fakeSpawn
      })).toThrow('GATE_R_REDIS_READINESS_AMBIENT_TOKEN_FORBIDDEN');
      expect(fakeSpawn).not.toHaveBeenCalled();
    }
  );

  it('maps hostile environment enumeration to the fixed ambient-token code', () => {
    const fakeSpawn = jest.fn();
    const environment = new Proxy({}, {
      ownKeys() {
        throw new Error(SECRET_SENTINEL);
      }
    });

    expect(() => runRedisReadiness({
      environment,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      serviceId: REPLACEMENT_SERVICE_ID,
      spawn: fakeSpawn
    })).toThrow('GATE_R_REDIS_READINESS_AMBIENT_TOKEN_FORBIDDEN');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('emits only the fixed argument error on an invalid CLI invocation', () => {
    const script = fileURLToPath(new URL('../scripts/gate-r1-redis-readiness.js', import.meta.url));
    const child = spawnSync(process.execPath, [script, '--service-id', SECRET_SENTINEL, 'extra'], {
      encoding: 'utf8',
      shell: false
    });

    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('GATE_R_REDIS_READINESS_ARGUMENT_INVALID\n');
    expect(child.stderr).not.toContain(SECRET_SENTINEL);
  });
});
