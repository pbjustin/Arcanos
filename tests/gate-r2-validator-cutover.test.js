import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_CUTOVER_DATABASE_REFERENCE,
  GATE_R2_CUTOVER_ENVIRONMENT_ID,
  GATE_R2_CUTOVER_ENVIRONMENT_NAME,
  GATE_R2_CUTOVER_PROJECT_ID,
  GATE_R2_VALIDATOR_TARGETS,
  buildGateR2ValidatorCutover,
  parseGateR2ValidatorCutoverArgs,
  runGateR2ValidatorCutover
} from '../scripts/gate-r2-validator-cutover.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'validator-cutover-secret-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['DATABASE_URL', SECRET_SENTINEL],
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['PATH', 'C:\\safe']
]));

function statusBuffer({ project = 'Arcanos', environment = GATE_R2_CUTOVER_ENVIRONMENT_NAME, service = 'None' } = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function statusJsonBuffer() {
  return Buffer.from(JSON.stringify({
    environmentId: GATE_R2_CUTOVER_ENVIRONMENT_ID,
    environmentName: GATE_R2_CUTOVER_ENVIRONMENT_NAME,
    projectId: GATE_R2_CUTOVER_PROJECT_ID,
    projectName: 'Arcanos'
  }));
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

describe('Gate R2 fixed inactive-validator cutover', () => {
  it('hard-binds exactly the two inactive validator profiles and the R3 reference', () => {
    expect(GATE_R2_VALIDATOR_TARGETS).toEqual({
      'compatibility-validator': {
        serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
        serviceName: 'phase2e-compatibility-validator-20260718'
      },
      'migration-validator': {
        serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
        serviceName: 'phase2e-migration-validator-20260718'
      }
    });
    expect(GATE_R2_CUTOVER_DATABASE_REFERENCE)
      .toBe('${{phase2e-postgres-r3-20260720.DATABASE_URL}}');
    expect(GATE_R2_CUTOVER_DATABASE_REFERENCE)
      .not.toContain('phase2e-postgres-r2-20260718');
  });

  it.each(Object.keys(GATE_R2_VALIDATOR_TARGETS))(
    'constructs one exact deployment-suppressed stdin write for %s',
    profile => {
      const definition = buildGateR2ValidatorCutover(profile);
      expect(definition.args).toEqual([
        'variable', 'set',
        '--service', definition.serviceId,
        '--environment', GATE_R2_CUTOVER_ENVIRONMENT_ID,
        '--stdin',
        '--skip-deploys',
        '--json',
        'DATABASE_URL'
      ]);
      expect(definition.args.filter(value => value === '--service')).toHaveLength(1);
      expect(definition.args.filter(value => value === 'DATABASE_URL')).toHaveLength(1);
      const serialized = definition.args.join('\n');
      for (const forbidden of [
        'DATABASE_PUBLIC_URL',
        'REDIS_URL',
        'volume',
        'restart',
        'up'
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  );

  it('accepts only one exact profile and no caller-selected service or value', () => {
    for (const profile of Object.keys(GATE_R2_VALIDATOR_TARGETS)) {
      expect(parseGateR2ValidatorCutoverArgs(['--profile', profile])).toEqual({ profile });
    }
    for (const argv of [
      [],
      ['--profile'],
      ['--profile', 'migration-validator', '--service', 'arbitrary'],
      ['--service-id', 'd8d5181a-2f72-48d7-8413-6f05d113876c'],
      ['--profile', 'MIGRATION-VALIDATOR'],
      ['--value', GATE_R2_CUTOVER_DATABASE_REFERENCE]
    ]) {
      expect(() => parseGateR2ValidatorCutoverArgs(argv))
        .toThrow('GATE_R2_VALIDATOR_CUTOVER_ARGUMENT_INVALID');
    }
  });

  it.each(Object.keys(GATE_R2_VALIDATOR_TARGETS))(
    'checks the exact link and writes only the literal reference for %s',
    profile => {
      const definition = buildGateR2ValidatorCutover(profile);
      const statusStdout = statusBuffer();
      const statusJsonStdout = statusJsonBuffer();
      const mutationStdout = Buffer.from(SECRET_SENTINEL);
      let inputReference;
      let inputSnapshot;
      const spawn = jest.fn()
        .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
        .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
        .mockImplementationOnce((_file, _args, options) => {
          inputReference = options.input;
          inputSnapshot = Buffer.from(options.input);
          return { status: 0, stdout: mutationStdout, stderr: Buffer.alloc(0) };
        });

      const result = runGateR2ValidatorCutover({
        environment: SAFE_ENVIRONMENT,
        profile,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      });

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn.mock.calls[0][1]).toEqual([
        'link', '-p', GATE_R2_CUTOVER_PROJECT_ID,
        '-e', GATE_R2_CUTOVER_ENVIRONMENT_ID, '--json'
      ]);
      expect(spawn.mock.calls[0][2].env).toEqual({ PATH: 'C:\\safe' });
      expect(spawn.mock.calls[1][1]).toEqual(['status']);
      expect(spawn.mock.calls[2][2].cwd).toBe(spawn.mock.calls[0][2].cwd);
      expect(spawn.mock.calls[2][1]).toEqual(definition.args);
      expect(spawn.mock.calls[2][2]).toMatchObject({
        env: { PATH: 'C:\\safe' },
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 30_000,
        windowsHide: true
      });
      expect(inputSnapshot.toString('utf8')).toBe(GATE_R2_CUTOVER_DATABASE_REFERENCE);
      expect(result).toEqual({
        code: 'GATE_R2_VALIDATOR_CUTOVER_ACCEPTED_PENDING_PROJECTION',
        environmentId: GATE_R2_CUTOVER_ENVIRONMENT_ID,
        profile,
        projectId: GATE_R2_CUTOVER_PROJECT_ID,
        projectionRequired: true,
        retryAuthorized: false,
        serviceId: definition.serviceId,
        status: 'PENDING_PROJECTION'
      });
      expectZeroed(statusStdout);
      expectZeroed(statusJsonStdout);
      expectZeroed(mutationStdout);
      expectZeroed(inputReference);
    }
  );

  it.each([...GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES, 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN'])(
    'rejects ambient %s before checking the link',
    tokenName => {
      const spawn = jest.fn();
      expect(() => runGateR2ValidatorCutover({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        profile: 'migration-validator',
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R2_VALIDATOR_CUTOVER_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['wrong project', { project: 'Another' }],
    ['wrong environment', { environment: 'production' }],
    ['selected service', { service: 'phase2e-migration-validator-20260718' }]
  ])('stops before cutover for %s', (_name, statusOverrides) => {
    const stdout = statusBuffer(statusOverrides);
    const stderr = Buffer.alloc(0);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonBuffer(), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout, stderr });

    expect(() => runGateR2ValidatorCutover({
      environment: SAFE_ENVIRONMENT,
      profile: 'migration-validator',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VALIDATOR_CUTOVER_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(stdout);
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

    expect(() => runGateR2ValidatorCutover({
      environment: SAFE_ENVIRONMENT,
      profile: 'compatibility-validator',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it('does not parse mutation stdout or retry after an accepted invocation', () => {
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

    expect(runGateR2ValidatorCutover({
      environment: SAFE_ENVIRONMENT,
      profile: 'migration-validator',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toMatchObject({
      code: 'GATE_R2_VALIDATOR_CUTOVER_ACCEPTED_PENDING_PROJECTION',
      projectionRequired: true,
      retryAuthorized: false
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(mutationStdout);
  });

  it('treats fixed-link cleanup failure after mutation invocation as ambiguous', () => {
    const spawn = jest.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const fixedLink = jest.fn(({ operation }) => {
      operation('C:\\fixed-temp\\arcanos-gate-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      throw new Error('GATE_R2_VALIDATOR_CUTOVER_TARGET_MISMATCH');
    });
    expect(() => runGateR2ValidatorCutover({
      environment: SAFE_ENVIRONMENT,
      fixedLink,
      profile: 'migration-validator',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
