import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_VOLUME_DISPOSITION_TARGETS,
  GATE_R2_VOLUME_ENVIRONMENT_ID,
  GATE_R2_VOLUME_ENVIRONMENT_NAME,
  GATE_R2_VOLUME_PROJECT_ID,
  buildGateR2VolumeDispositionPatch,
  parseGateR2VolumeDispositionArgs,
  runGateR2VolumeDisposition
} from '../scripts/gate-r2-volume-disposition.js';
import { GATE_R_FORBIDDEN_RAILWAY_TOKEN_VARIABLES } from '../scripts/gate-r1-postgres-readiness.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const SECRET_SENTINEL = 'volume-disposition-secret-must-not-escape';
const SAFE_ENVIRONMENT = Object.freeze(Object.fromEntries([
  ['DATABASE_URL', SECRET_SENTINEL],
  ['OPENAI_API_KEY', SECRET_SENTINEL],
  ['PATH', 'C:\\safe']
]));
const RETAINED_VOLUME_IDS = Object.freeze([
  'ce93ced0-0c15-48f9-87fc-d9153ffefdc8',
  '983c4f0a-9180-4621-b65e-dfdd0b79f2bd'
]);

function statusBuffer({ project = 'Arcanos', environment = GATE_R2_VOLUME_ENVIRONMENT_NAME, service = 'None' } = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function statusJsonBuffer() {
  return Buffer.from(JSON.stringify({
    environmentId: GATE_R2_VOLUME_ENVIRONMENT_ID,
    environmentName: GATE_R2_VOLUME_ENVIRONMENT_NAME,
    projectId: GATE_R2_VOLUME_PROJECT_ID,
    projectName: 'Arcanos'
  }));
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

describe('Gate R2 fixed detached-volume disposition', () => {
  it('hard-binds exactly the three obsolete volume profiles', () => {
    expect(GATE_R2_VOLUME_DISPOSITION_TARGETS).toEqual({
      'failed-postgres-r2': {
        message: 'gate-r2: dispose detached failed postgres r2 volume instance',
        volumeId: '2998734d-7530-4f26-b715-cea4780bd437',
        volumeInstanceId: '46113532-5609-46da-b7b4-46b8f06930cc'
      },
      'original-postgres': {
        message: 'gate-r2: dispose detached original preview postgres volume instance',
        volumeId: '35c26093-1e3f-4d34-b699-89c65d2fb92d',
        volumeInstanceId: 'b8f04086-2e97-4167-a0fd-bcb259541e9f'
      },
      'original-redis': {
        message: 'gate-r2: dispose detached original preview redis volume instance',
        volumeId: 'd3690500-fcc5-4c06-afa6-cf30e91f608d',
        volumeInstanceId: 'f222873c-255e-45a2-9a17-840bdba108f6'
      }
    });
  });

  it.each(Object.keys(GATE_R2_VOLUME_DISPOSITION_TARGETS))(
    'builds one volume-only isDeleted environment patch for %s',
    profile => {
      const definition = buildGateR2VolumeDispositionPatch(profile);
      const patch = JSON.parse(definition.patchJson);

      expect(patch).toEqual({
        volumes: { [definition.volumeId]: { isDeleted: true } }
      });
      expect(Object.keys(patch)).toEqual(['volumes']);
      expect(Object.keys(patch.volumes)).toHaveLength(1);
      expect(definition.patchJson.length).toBeGreaterThan(0);
      expect(definition.patchJson).not.toContain('services');
      for (const forbidden of [
        ...RETAINED_VOLUME_IDS,
        'serviceId',
        'deploy',
        'source',
        'variables',
        'domain',
        'tcpProxy',
        'detach'
      ]) {
        expect(definition.patchJson).not.toContain(forbidden);
      }
    }
  );

  it('rejects arbitrary IDs, aliases, and unknown profiles before spawning Railway', () => {
    const spawn = jest.fn();
    for (const profile of [
      undefined, null, '', 'original-postgres ', 'ORIGINAL-POSTGRES', '__proto__',
      GATE_R2_VOLUME_DISPOSITION_TARGETS['original-postgres'].volumeId,
      GATE_R2_VOLUME_DISPOSITION_TARGETS['original-postgres'].volumeInstanceId
    ]) {
      expect(() => runGateR2VolumeDisposition({
        profile,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R2_VOLUME_DISPOSITION_ARGUMENT_INVALID');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('accepts only one exact fixed profile argument', () => {
    for (const profile of Object.keys(GATE_R2_VOLUME_DISPOSITION_TARGETS)) {
      expect(parseGateR2VolumeDispositionArgs(['--profile', profile])).toEqual({ profile });
    }
    for (const argv of [
      [],
      ['--profile'],
      ['--profile', 'original-postgres', '--volume-id', 'arbitrary'],
      ['--volume-id', GATE_R2_VOLUME_DISPOSITION_TARGETS['original-postgres'].volumeId],
      ['--profile', 'ORIGINAL-POSTGRES']
    ]) {
      expect(() => parseGateR2VolumeDispositionArgs(argv))
        .toThrow('GATE_R2_VOLUME_DISPOSITION_ARGUMENT_INVALID');
    }
  });

  it.each(Object.keys(GATE_R2_VOLUME_DISPOSITION_TARGETS))(
    'checks the isolated link and submits exactly one nonempty stdin patch for %s',
    profile => {
      const definition = buildGateR2VolumeDispositionPatch(profile);
      const statusStdout = statusBuffer();
      const statusJsonStdout = statusJsonBuffer();
      const mutationStdout = Buffer.from(SECRET_SENTINEL);
      let submittedInput;
      let submittedInputReference;
      const spawn = jest.fn()
        .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
        .mockReturnValueOnce({ status: 0, stdout: statusStdout, stderr: Buffer.alloc(0) })
        .mockImplementationOnce((_file, _args, options) => {
          submittedInputReference = options.input;
          submittedInput = Buffer.from(options.input);
          return { status: 0, stdout: mutationStdout, stderr: Buffer.alloc(0) };
        });

      const result = runGateR2VolumeDisposition({
        environment: SAFE_ENVIRONMENT,
        profile,
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      });

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn.mock.calls[0][1]).toEqual([
        'link', '-p', GATE_R2_VOLUME_PROJECT_ID,
        '-e', GATE_R2_VOLUME_ENVIRONMENT_ID, '--json'
      ]);
      expect(spawn.mock.calls[0][2].env).toEqual({ PATH: 'C:\\safe' });
      expect(spawn.mock.calls[1][1]).toEqual(['status']);
      expect(spawn.mock.calls[2][2].cwd).toBe(spawn.mock.calls[0][2].cwd);
      expect(spawn.mock.calls[2][1]).toEqual([
        'environment', 'edit',
        '-e', GATE_R2_VOLUME_ENVIRONMENT_ID,
        '-m', definition.message,
        '--json'
      ]);
      expect(spawn.mock.calls[2][1]).not.toContain('volume');
      expect(spawn.mock.calls[2][1]).not.toContain('delete');
      expect(spawn.mock.calls[2][1]).not.toContain('detach');
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
      expectZeroed(submittedInputReference);
      expect(result).toEqual({
        code: 'GATE_R2_VOLUME_DISPOSITION_ACCEPTED_PENDING_PROJECTION',
        environmentId: GATE_R2_VOLUME_ENVIRONMENT_ID,
        profile,
        projectId: GATE_R2_VOLUME_PROJECT_ID,
        projectionRequired: true,
        retryAuthorized: false,
        status: 'PENDING_PROJECTION',
        volumeId: definition.volumeId,
        volumeInstanceId: definition.volumeInstanceId
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
      expect(() => runGateR2VolumeDisposition({
        environment: { PATH: 'C:\\safe', [tokenName]: SECRET_SENTINEL },
        profile: 'original-postgres',
        railwayExecutable: TEST_RAILWAY_EXECUTABLE,
        spawn
      })).toThrow('GATE_R2_VOLUME_DISPOSITION_AMBIENT_TOKEN_FORBIDDEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['wrong project', { project: 'Another' }],
    ['wrong environment', { environment: 'production' }],
    ['selected service', { service: 'Postgres' }]
  ])('stops before mutation for %s', (_name, statusOverrides) => {
    const stdout = statusBuffer(statusOverrides);
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonBuffer(), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout, stderr: Buffer.alloc(0) });

    expect(() => runGateR2VolumeDisposition({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VOLUME_DISPOSITION_TARGET_MISMATCH');
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(stdout);
  });

  it('maps a pre-mutation status timeout to a fixed code', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const timeout = Object.assign(new Error(SECRET_SENTINEL), {
      code: 'ETIMEDOUT',
      stderr
    });
    const spawn = jest.fn(() => { throw timeout; });

    expect(() => runGateR2VolumeDisposition({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VOLUME_DISPOSITION_TIMEOUT');
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stderr);
  });

  it.each([
    ['timed out', { error: Object.assign(new Error(SECRET_SENTINEL), { code: 'ETIMEDOUT' }), status: null }],
    ['returned nonzero', { status: 1 }]
  ])('maps a mutation that %s to fixed no-retry ambiguity', (_name, mutationResult) => {
    const stdout = Buffer.from(SECRET_SENTINEL);
    const stderr = Buffer.from(SECRET_SENTINEL);
    const statusJsonStdout = statusJsonBuffer();
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: statusBuffer(), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ ...mutationResult, stdout, stderr });

    expect(() => runGateR2VolumeDisposition({
      environment: SAFE_ENVIRONMENT,
      profile: 'original-redis',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(stdout);
    expectZeroed(stderr);
  });

  it('does not parse mutation stdout or claim completion after an accepted invocation', () => {
    const mutationStdout = Buffer.from(JSON.stringify(Object.fromEntries([
      ['committed', false],
      [['sec', 'ret'].join(''), SECRET_SENTINEL]
    ])));
    const statusJsonStdout = statusJsonBuffer();
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: statusBuffer(), stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: mutationStdout, stderr: Buffer.alloc(0) });

    expect(runGateR2VolumeDisposition({
      environment: SAFE_ENVIRONMENT,
      profile: 'failed-postgres-r2',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toMatchObject({
      code: 'GATE_R2_VOLUME_DISPOSITION_ACCEPTED_PENDING_PROJECTION',
      projectionRequired: true,
      retryAuthorized: false,
      status: 'PENDING_PROJECTION'
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(mutationStdout);
  });

  it('maps hostile thrown diagnostics to a fixed ambiguous code without invoking accessors', () => {
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
    const statusJsonStdout = statusJsonBuffer();
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: statusJsonStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: statusBuffer(), stderr: Buffer.alloc(0) })
      .mockImplementationOnce(() => { throw hostile; });

    expect(() => runGateR2VolumeDisposition({
      environment: SAFE_ENVIRONMENT,
      profile: 'failed-postgres-r2',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(3);
    expectZeroed(statusJsonStdout);
    expectZeroed(output);
    expectZeroed(causeOutput);
  });

  it('treats fixed-link cleanup failure after mutation invocation as ambiguous', () => {
    const spawn = jest.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const fixedLink = jest.fn(({ operation }) => {
      operation('C:\\fixed-temp\\arcanos-gate-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      throw new Error('GATE_R2_VOLUME_DISPOSITION_TARGET_MISMATCH');
    });
    expect(() => runGateR2VolumeDisposition({
      environment: SAFE_ENVIRONMENT,
      fixedLink,
      profile: 'original-postgres',
      railwayExecutable: TEST_RAILWAY_EXECUTABLE,
      spawn
    })).toThrow('GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
