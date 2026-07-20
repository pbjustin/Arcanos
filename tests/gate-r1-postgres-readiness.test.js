import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R_ENVIRONMENT_ID,
  GATE_R_POSTGRES_SERVICE_NAME,
  GATE_R_PROJECT_ID,
  buildPostgresReadinessInvocation,
  resolveRailwayExecutable,
  runPostgresReadiness
} from '../scripts/gate-r1-postgres-readiness.js';

const REPLACEMENT_SERVICE_ID = '11111111-2222-4333-8444-555555555555';
const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'credential-sentinel-should-not-escape';

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
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
    const invocation = buildPostgresReadinessInvocation({
      serviceId: REPLACEMENT_SERVICE_ID,
      railwayExecutable: TEST_RAILWAY_EXECUTABLE
    });
    const serialized = invocation.args.join(' ');

    expect(invocation.file).toBe(TEST_RAILWAY_EXECUTABLE);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '-p',
        GATE_R_PROJECT_ID,
        '-e',
        GATE_R_ENVIRONMENT_ID,
        '-s',
        REPLACEMENT_SERVICE_ID,
        'sh',
        '-lc'
      ])
    );
    expect(invocation.options).toMatchObject({ shell: false, timeout: 30_000, windowsHide: true });
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
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_TIMEOUT');
    expectZeroed(stderr);
  });

  it('maps thrown child errors to a fixed message and clears diagnostics', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const fakeSpawn = jest.fn(() => {
      throw Object.assign(new Error(SECRET_SENTINEL), { stderr });
    });

    expect(() =>
      runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED');
    expectZeroed(stderr);
  });

  it('rejects wrong project, environment, malformed, and quarantined service targets before execution', () => {
    const fakeSpawn = jest.fn();

    expect(() =>
      runPostgresReadiness({
        projectId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() =>
      runPostgresReadiness({
        environmentId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() =>
      runPostgresReadiness({
        serviceId: 'not-a-uuid',
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_SERVICE_INVALID');
    expect(() =>
      runPostgresReadiness({
        serviceId: 'b7789306-8aef-4113-add5-02883a6cc087',
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('rejects an empty executable before execution', () => {
    const fakeSpawn = jest.fn();

    expect(() =>
      runPostgresReadiness({
        serviceId: REPLACEMENT_SERVICE_ID,
        railwayExecutable: '',
        spawn: fakeSpawn
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_CLI_UNAVAILABLE');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });
});
