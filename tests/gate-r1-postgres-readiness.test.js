import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R_ENVIRONMENT_ID,
  GATE_R_POSTGRES_SERVICE_ID,
  GATE_R_POSTGRES_SERVICE_NAME,
  GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES,
  GATE_R_PROJECT_ID,
  buildPostgresReadinessInvocation,
  resolveRailwayExecutable,
  runPostgresReadiness
} from '../scripts/gate-r1-postgres-readiness.js';

const REPLACEMENT_SERVICE_ID = GATE_R_POSTGRES_SERVICE_ID;
const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'credential-sentinel-should-not-escape';
const SAFE_ENVIRONMENT = Object.freeze({ PATH: 'C:\\safe' });
const UNRELATED_SECRET_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['DATABASE_URL', SECRET_SENTINEL],
  ['REDIS_URL', SECRET_SENTINEL],
  ['AUTHORIZATION', SECRET_SENTINEL]
]));

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

function modelRailwayCli4302Command(args) {
  // Mirrors Railway CLI 4.30.2: trailing arguments are joined, then passed to `sh -c`.
  const commandArguments = args.slice(7);
  return Object.freeze({
    args: Object.freeze(['-c', commandArguments.join(' ')]),
    commandArguments: Object.freeze(commandArguments),
    file: 'sh'
  });
}

describe('Gate R1 authenticated PostgreSQL readiness', () => {
  it('resolves the executable directly on non-Windows platforms', () => {
    const exists = jest.fn();

    expect(resolveRailwayExecutable({ platform: 'linux', exists })).toBe('railway');
    expect(exists).not.toHaveBeenCalled();
  });

  it('resolves the real Windows executable behind an npm shim', () => {
    const pathEntry = 'C:\\Users\\operator\\AppData\\Roaming\\npm';
    const commandShim = `${pathEntry}\\railway.cmd`;
    const packageExecutable = `${pathEntry}\\node_modules\\@railway\\cli\\bin\\railway.exe`;
    const exists = jest.fn(candidate => [commandShim, packageExecutable].includes(candidate));

    expect(resolveRailwayExecutable({ platform: 'win32', pathValue: pathEntry, exists })).toBe(
      packageExecutable
    );
  });

  it('fails closed when the Windows executable is unavailable', () => {
    expect(() =>
      resolveRailwayExecutable({ platform: 'win32', pathValue: 'C:\\missing', exists: () => false })
    ).toThrow('GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE');
  });

  it('builds an exact-target, authenticated, non-SQL Railway SSH invocation', () => {
    expect(GATE_R_POSTGRES_SERVICE_NAME).toBe('phase2e-postgres-r3-20260720');
    const invocation = buildPostgresReadinessInvocation({
      serviceId: REPLACEMENT_SERVICE_ID,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      environment: {
        PATH: 'safe',
        RAILWAY_TOKEN: '',
        ...UNRELATED_SECRET_ENVIRONMENT
      }
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
    expect(invocation.options.env).toEqual({ PATH: 'safe' });
    expect(invocation.options.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(serialized).toContain('psql');
    expect(serialized).toContain('--no-psqlrc');
    expect(serialized).toContain('--no-password');
    expect(serialized).toContain('--set=ON_ERROR_STOP=1');
    expect(serialized).toContain('--command="\\conninfo"');
    expect(serialized).toContain('PGPASSWORD="$POSTGRES_PASSWORD"');
    expect(serialized).toContain(`RAILWAY_SERVICE_NAME:-}" = "${GATE_R_POSTGRES_SERVICE_NAME}`);
    expect(serialized).toContain('>/dev/null 2>&1');
    expect(serialized).toContain('exit 70');
    expect(serialized).toContain('exit 71');
    expect(serialized).toContain('exit 72');
    expect(serialized).toContain('exit 73');
    expect(serialized).toContain('exit 74');
    expect(serialized).not.toContain('pg_isready');
    expect(serialized).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    expect(serialized).not.toMatch(/\b(echo|env|printenv|printf)\b/);
  });

  it('passes one fixed command through the Railway CLI 4.30.2 outer shell without nesting', () => {
    const invocation = buildPostgresReadinessInvocation({
      serviceId: REPLACEMENT_SERVICE_ID,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      environment: SAFE_ENVIRONMENT
    });
    const modeled = modelRailwayCli4302Command(invocation.args);
    const [remoteCommand] = modeled.commandArguments;

    expect(modeled.file).toBe('sh');
    expect(modeled.args).toEqual(['-c', remoteCommand]);
    expect(modeled.commandArguments).toHaveLength(1);
    expect(remoteCommand).toMatch(/^test "\$\{RAILWAY_PROJECT_ID:-\}"/);
    expect(remoteCommand).not.toMatch(/^sh\s+-lc\b/u);
    expect(remoteCommand).toContain('|| exit 70');
    expect(remoteCommand).toContain('psql');
    expect(remoteCommand).toContain('>/dev/null 2>&1');
  });

  it('suppresses and clears unexpected child output on success', () => {
    const stdout = Buffer.from(`postgresql://${SECRET_SENTINEL}`);
    const stderr = Buffer.from(`Authorization: Bearer ${SECRET_SENTINEL}`);
    const fakeSpawn = jest.fn(() => ({
      error: undefined,
      output: [null, stdout, stderr],
      signal: null,
      status: 0,
      stderr,
      stdout
    }));

    const result = runPostgresReadiness({
      serviceId: REPLACEMENT_SERVICE_ID,
      environment: SAFE_ENVIRONMENT,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn: fakeSpawn
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(fakeSpawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(result).toEqual({
      code: 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_PASSED',
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
    [70, 'GATE_R_POSTGRES_READINESS_REMOTE_TARGET_MISMATCH'],
    [71, 'GATE_R_POSTGRES_READINESS_CREDENTIAL_CONFIGURATION_INVALID'],
    [72, 'GATE_R_POSTGRES_READINESS_CLIENT_UNAVAILABLE'],
    [73, 'GATE_R_POSTGRES_READINESS_TIMEOUT'],
    [74, 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED'],
    [1, 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED']
  ])('maps child status %s to fixed diagnostics only', (status, expectedMessage) => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const fakeSpawn = jest.fn(() => ({ status, stderr }));

    expect(() =>
      runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow(expectedMessage);
    expectZeroed(stderr);
  });

  it('maps spawn timeouts to a fixed message and clears diagnostics', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const error = Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT', stderr });
    const fakeSpawn = jest.fn(() => ({ error, status: null }));

    expect(() =>
      runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_TIMEOUT');
    expectZeroed(stderr);
  });

  it('maps thrown child errors to a fixed message and clears diagnostics', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const causeStderr = Buffer.from(SECRET_SENTINEL);
    const fakeSpawn = jest.fn(() => {
      throw Object.assign(new Error(SECRET_SENTINEL), { cause: { stderr: causeStderr }, stderr });
    });

    expect(() =>
      runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED');
    expectZeroed(stderr);
    expectZeroed(causeStderr);
  });

  it('rejects wrong project, environment, malformed, and every non-R3 service target before execution', () => {
    const fakeSpawn = jest.fn();

    expect(() =>
      runPostgresReadiness({
        projectId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() =>
      runPostgresReadiness({
        environmentId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() =>
      runPostgresReadiness({
        serviceId: 'not-a-uuid',
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_SERVICE_INVALID');
    expect(() =>
      runPostgresReadiness({
        serviceId: 'b7789306-8aef-4113-add5-02883a6cc087',
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN');
    for (const serviceId of [
      '11111111-2222-4333-8444-555555555555',
      '434fa5b4-b52c-4caf-aaba-e87c173bf10d',
      'a2a57da4-a928-427f-be30-d4a68b59a117',
      '1ac0bd56-50b3-49eb-954c-ea83515ec915',
      'd8d5181a-2f72-48d7-8413-6f05d113876c',
      'febdf999-1c96-48df-8e28-c905b8b27082',
      'c4ade025-3f13-4fca-9309-5d0dd81396fe',
      '1765befb-b805-4051-9af9-28634e986886'
    ]) {
      expect(() =>
        runPostgresReadiness({
          serviceId,
          environment: SAFE_ENVIRONMENT,
          railwayExecutable: TEST_RAILWAY_EXECUTABLE,
          spawn: fakeSpawn
        })
      ).toThrow('GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN');
    }
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('rejects an empty executable before execution', () => {
    const fakeSpawn = jest.fn();

    expect(() =>
      runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: SAFE_ENVIRONMENT,
        railwayExecutable: '',
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it.each(GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES)(
    'rejects ambient %s before spawning Railway',
    tokenName => {
      const fakeSpawn = jest.fn();
      expect(() => runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        environment: { PATH: 'safe', [tokenName]: SECRET_SENTINEL },
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })).toThrow('GATE_R_POSTGRES_READINESS_AMBIENT_TOKEN_FORBIDDEN');
      expect(fakeSpawn).not.toHaveBeenCalled();
    }
  );
});
