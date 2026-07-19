import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R_ENVIRONMENT_ID,
  GATE_R_POSTGRES_SERVICE_NAME,
  GATE_R_PROJECT_ID,
  buildPostgresReadinessInvocation,
  runPostgresReadiness
} from '../scripts/gate-r1-postgres-readiness.js';

const REPLACEMENT_SERVICE_ID = '11111111-2222-4333-8444-555555555555';

describe('Gate R1 authenticated PostgreSQL readiness', () => {
  it('builds an exact-target, authenticated, non-SQL Railway SSH invocation', () => {
    const invocation = buildPostgresReadinessInvocation({ serviceId: REPLACEMENT_SERVICE_ID });
    const serialized = invocation.args.join(' ');

    expect(invocation.file).toBe('railway');
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
    expect(invocation.options).toMatchObject({ shell: false, stdio: 'ignore', timeout: 30_000 });
    expect(serialized).toContain('psql');
    expect(serialized).toContain('--no-psqlrc');
    expect(serialized).toContain('--no-password');
    expect(serialized).toContain('--set=ON_ERROR_STOP=1');
    expect(serialized).toContain('--command="\\conninfo"');
    expect(serialized).toContain('PGPASSWORD="$POSTGRES_PASSWORD"');
    expect(serialized).toContain(`RAILWAY_SERVICE_NAME" = "${GATE_R_POSTGRES_SERVICE_NAME}`);
    expect(serialized).toContain('>/dev/null 2>&1');
    expect(serialized).not.toContain('pg_isready');
    expect(serialized).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  });

  it('uses an injected process runner and returns only safe status metadata', () => {
    const fakeExecFile = jest.fn(() => Buffer.alloc(0));

    const result = runPostgresReadiness({
      serviceId: REPLACEMENT_SERVICE_ID,
      execFile: fakeExecFile
    });

    expect(fakeExecFile).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      code: 'GATE_R_POSTGRES_AUTHENTICATED_READINESS_PASSED',
      environmentId: GATE_R_ENVIRONMENT_ID,
      projectId: GATE_R_PROJECT_ID,
      serviceId: REPLACEMENT_SERVICE_ID,
      status: 'PASS'
    });
  });

  it('rejects wrong project, environment, malformed, and quarantined service targets before execution', () => {
    const fakeExecFile = jest.fn();

    expect(() =>
      runPostgresReadiness({
        projectId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID,
        execFile: fakeExecFile
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() =>
      runPostgresReadiness({
        environmentId: '00000000-0000-4000-8000-000000000000',
        serviceId: REPLACEMENT_SERVICE_ID,
        execFile: fakeExecFile
      })
    ).toThrow('GATE_R_TARGET_MISMATCH');
    expect(() => runPostgresReadiness({ serviceId: 'not-a-uuid', execFile: fakeExecFile })).toThrow(
      'GATE_R_POSTGRES_READINESS_SERVICE_INVALID'
    );
    expect(() =>
      runPostgresReadiness({
        serviceId: 'b7789306-8aef-4113-add5-02883a6cc087',
        execFile: fakeExecFile
      })
    ).toThrow('GATE_R_POSTGRES_READINESS_SERVICE_FORBIDDEN');
    expect(fakeExecFile).not.toHaveBeenCalled();
  });

  it('maps child failures to a fixed message without exposing raw diagnostics', () => {
    const fakeExecFile = jest.fn(() => {
      const error = new Error('credential-sentinel-should-not-escape');
      error.stderr = Buffer.from('internal-provider-detail');
      throw error;
    });

    let observed;
    try {
      runPostgresReadiness({ serviceId: REPLACEMENT_SERVICE_ID, execFile: fakeExecFile });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect(observed.message).toBe('GATE_R_POSTGRES_AUTHENTICATED_READINESS_FAILED');
    expect(observed.message).not.toContain('credential-sentinel');
    expect(observed.message).not.toContain('internal-provider-detail');
  });
});
