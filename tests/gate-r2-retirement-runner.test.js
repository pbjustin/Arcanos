import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_RUNNER_EXIT_TIMEOUT_MS,
  inspectGateR2WindowsSessionProcess,
  parseGateR2RetirementRunnerArgs,
  runGateR2RetirementRunner,
  runGateR2RetirementRunnerCli
} from '../scripts/gate-r2-retirement-runner.js';

const SESSION_DIRECTORY =
  'C:\\Users\\test\\AppData\\Local\\Temp\\arcanos-gate-r2-projector-0123456789abcdef0123456789abcdef';
const PID = 4242;
const IDENTITY = '638886240000000000';
const SESSION_SCRIPT_SHA256 = 'B'.repeat(64);

function coordinatorResult(overrides = {}) {
  return {
    code: 'GATE_R2_COORDINATOR_COMPLETE',
    environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
    finalOldVolumeState: 'ABSENT',
    projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
    requestsConsumed: 14,
    serviceRetirementCount: 3,
    sessionExitVerified: true,
    status: 'PASS',
    validatorCutoverCount: 2,
    volumeDispositionCount: 3,
    ...overrides
  };
}

function createHarness({
  inspections = [
    { alive: true, identity: IDENTITY, pid: PID },
    { alive: false, pid: PID }
  ],
  directoryRetained = false,
  coordinatorImpl,
  now = () => 0
} = {}) {
  const inspectionQueue = [...inspections];
  const fileAdapter = Object.freeze({
    readReady: jest.fn(() => ({
      protocolVersion: 1,
      status: 'ready',
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      maximumRequests: 14,
      createdAt: '2026-07-20T21:00:00.000Z',
      sessionProcessId: PID,
      sessionProcessIdentity: IDENTITY,
      sessionScriptSha256: SESSION_SCRIPT_SHA256
    })),
    writeRequest: jest.fn(),
    waitForResponse: jest.fn(),
    writeAcknowledgement: jest.fn()
  });
  const inspectProcess = jest.fn(async () => {
    if (inspectionQueue.length === 0) throw new Error('raw-inspection-exhausted');
    return inspectionQueue.shift();
  });
  const isDirectoryAbsent = jest.fn(() => !directoryRetained);
  const sleep = jest.fn(async () => {});
  const createFileAdapter = jest.fn(() => fileAdapter);
  const createProcessAdapter = jest.fn(({ waitForSessionExit }) => ({
    disposeVolume: jest.fn(),
    retireService: jest.fn(),
    validatorCutover: jest.fn(),
    waitForSessionExit
  }));
  const coordinator = jest.fn(coordinatorImpl ?? (async ({ fileAdapter: boundFileAdapter, processAdapter }) => {
    boundFileAdapter.readReady();
    const exitCode = await processAdapter.waitForSessionExit();
    if (exitCode !== 0) throw new Error('raw-exit-code-sentinel');
    return coordinatorResult();
  }));
  return {
    coordinator,
    createFileAdapter,
    createProcessAdapter,
    isDirectoryAbsent,
    fileAdapter,
    inspectProcess,
    now,
    sessionScriptSha256: jest.fn(() => SESSION_SCRIPT_SHA256),
    sleep
  };
}

function runnerOptions(harness, overrides = {}) {
  return {
    argv: ['--session-directory', SESSION_DIRECTORY, '--session-pid', String(PID)],
    environment: {},
    platform: 'win32',
    inspectProcess: harness.inspectProcess,
    isDirectoryAbsent: harness.isDirectoryAbsent,
    sleep: harness.sleep,
    now: harness.now,
    createFileAdapter: harness.createFileAdapter,
    createProcessAdapter: harness.createProcessAdapter,
    coordinator: harness.coordinator,
    sessionScriptSha256: harness.sessionScriptSha256,
    ...overrides
  };
}

describe('Gate R2 retirement runner', () => {
  it('accepts only the exact session-directory and positive session-pid CLI shape', () => {
    expect(parseGateR2RetirementRunnerArgs([
      '--session-directory', SESSION_DIRECTORY, '--session-pid', String(PID)
    ])).toEqual({ pid: PID, sessionDirectory: SESSION_DIRECTORY });

    for (const argv of [
      [],
      ['--session-directory', SESSION_DIRECTORY],
      ['--session-pid', String(PID), '--session-directory', SESSION_DIRECTORY],
      ['--session-directory', SESSION_DIRECTORY, '--session-pid', '0'],
      ['--session-directory', SESSION_DIRECTORY, '--session-pid', '-1'],
      ['--session-directory', SESSION_DIRECTORY, '--session-pid', '04242'],
      ['--session-directory', SESSION_DIRECTORY, '--session-pid', '4294967296'],
      ['--session-directory', SESSION_DIRECTORY, '--session-pid', String(PID), '--extra']
    ]) {
      expect(() => parseGateR2RetirementRunnerArgs(argv)).toThrow(
        'GATE_R2_RETIREMENT_RUNNER_ARGUMENT_INVALID'
      );
    }
  });

  it('binds the exact existing process and session adapter, waits for cleanup, and emits fixed PASS', async () => {
    const harness = createHarness();
    const result = await runGateR2RetirementRunner(runnerOptions(harness));

    expect(result).toEqual({
      code: 'GATE_R2_RETIREMENT_RUNNER_COMPLETE',
      environmentId: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
      finalOldVolumeState: 'ABSENT',
      projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
      requestsConsumed: 14,
      serviceRetirementCount: 3,
      sessionExitVerified: true,
      status: 'PASS',
      validatorCutoverCount: 2,
      volumeDispositionCount: 3
    });
    expect(harness.inspectProcess).toHaveBeenNthCalledWith(1, { pid: PID });
    expect(harness.inspectProcess).toHaveBeenNthCalledWith(2, { pid: PID });
    expect(harness.createFileAdapter).toHaveBeenCalledWith({ sessionDirectory: SESSION_DIRECTORY });
    expect(harness.fileAdapter.readReady).toHaveBeenCalledTimes(2);
    expect(harness.sessionScriptSha256).toHaveBeenCalledTimes(1);
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
    expect(harness.coordinator).toHaveBeenCalledWith(expect.objectContaining({
      environment: {},
      fileAdapter: expect.not.objectContaining({ marker: expect.anything() })
    }));
    expect(harness.isDirectoryAbsent).toHaveBeenCalledWith(SESSION_DIRECTORY);
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN'],
    ['ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN'],
    ['RAILWAY_API_TOKEN'],
    ['RAILWAY_PROJECT_TOKEN'],
    ['RAILWAY_TOKEN'],
    ['Railway_Token']
  ])('rejects ambient token variable %s before process or session access', async tokenName => {
    const harness = createHarness();
    await expect(runGateR2RetirementRunner(runnerOptions(harness, {
      environment: { [tokenName]: 'must-not-be-read' }
    }))).rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_AMBIENT_TOKEN_FORBIDDEN');
    expect(harness.inspectProcess).not.toHaveBeenCalled();
    expect(harness.createFileAdapter).not.toHaveBeenCalled();
    expect(harness.coordinator).not.toHaveBeenCalled();
  });

  it('fails closed outside Windows before process or session access', async () => {
    const harness = createHarness();
    await expect(runGateR2RetirementRunner(runnerOptions(harness, {
      platform: 'linux'
    }))).rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_PLATFORM_UNSUPPORTED');
    expect(harness.inspectProcess).not.toHaveBeenCalled();
    expect(harness.createFileAdapter).not.toHaveBeenCalled();
  });

  it('rejects an absent or malformed initial session process before coordinator invocation', async () => {
    for (const initial of [
      { alive: false, pid: PID },
      { alive: true, identity: IDENTITY, pid: PID + 1 },
      { alive: true, identity: 'invalid', pid: PID }
    ]) {
      const harness = createHarness({ inspections: [initial] });
      await expect(runGateR2RetirementRunner(runnerOptions(harness)))
        .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_PROCESS_INVALID');
      expect(harness.coordinator).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['wrong PID', { sessionProcessId: PID + 1 }],
    ['malformed process identity', { sessionProcessIdentity: 'invalid' }],
    ['wrong script hash', { sessionScriptSha256: 'C'.repeat(64) }]
  ])('rejects ready.json bound to the %s before process inspection or mutation', async (_name, override) => {
    const harness = createHarness();
    harness.fileAdapter.readReady.mockReturnValue({
      ...harness.fileAdapter.readReady(),
      ...override
    });
    harness.fileAdapter.readReady.mockClear();
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_PROCESS_INVALID');
    expect(harness.inspectProcess).not.toHaveBeenCalled();
    expect(harness.coordinator).not.toHaveBeenCalled();
  });

  it('rejects a ready session whose authored start identity does not match the live process', async () => {
    const harness = createHarness();
    harness.fileAdapter.readReady.mockReturnValue({
      ...harness.fileAdapter.readReady(),
      sessionProcessIdentity: '638886240000000001'
    });
    harness.fileAdapter.readReady.mockClear();
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_PROCESS_INVALID');
    expect(harness.inspectProcess).toHaveBeenCalledTimes(1);
    expect(harness.coordinator).not.toHaveBeenCalled();
  });

  it('revalidates the PID and script binding when the coordinator reads ready.json', async () => {
    const harness = createHarness();
    const validReady = harness.fileAdapter.readReady();
    harness.fileAdapter.readReady
      .mockReturnValueOnce(validReady)
      .mockReturnValueOnce({ ...validReady, sessionProcessIdentity: '638886240000000001' });
    harness.fileAdapter.readReady.mockClear();
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_COORDINATOR_FAILED');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
    expect(harness.inspectProcess).toHaveBeenCalledTimes(1);
  });

  it('detects PID reuse during exit polling and never reruns the coordinator', async () => {
    const harness = createHarness({
      inspections: [
        { alive: true, identity: IDENTITY, pid: PID },
        { alive: true, identity: '638886240000000001', pid: PID }
      ]
    });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_PID_REUSED');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
    expect(harness.inspectProcess).toHaveBeenCalledTimes(2);
  });

  it('fails on a bounded exit timeout without retrying the coordinator', async () => {
    const times = [0, GATE_R2_RUNNER_EXIT_TIMEOUT_MS];
    const harness = createHarness({
      inspections: [
        { alive: true, identity: IDENTITY, pid: PID },
        { alive: true, identity: IDENTITY, pid: PID }
      ],
      now: () => times.shift()
    });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_EXIT_TIMEOUT');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('rejects a dead session whose error directory remains present', async () => {
    const harness = createHarness({ directoryRetained: true });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_CLEANUP_REQUIRED');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
    expect(harness.isDirectoryAbsent).toHaveBeenCalledWith(SESSION_DIRECTORY);
  });

  it('does not treat a session-directory access error as proof of absence', async () => {
    const harness = createHarness();
    harness.isDirectoryAbsent.mockImplementation(() => {
      const error = new Error('raw-access-sentinel');
      error.code = 'EACCES';
      throw error;
    });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_CLEANUP_REQUIRED');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
    expect(harness.isDirectoryAbsent).toHaveBeenCalledWith(SESSION_DIRECTORY);
  });

  it('maps an invalid secure-session adapter to a fixed argument error before coordinator invocation', async () => {
    const harness = createHarness();
    harness.createFileAdapter.mockImplementation(() => {
      throw new Error('raw-path-sentinel');
    });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_ARGUMENT_INVALID');
    expect(harness.coordinator).not.toHaveBeenCalled();
  });

  it('invokes the coordinator exactly once and exposes no raw failure diagnostics', async () => {
    const harness = createHarness({
      coordinatorImpl: async () => {
        throw new Error('credential-path-sql-sentinel');
      }
    });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_COORDINATOR_FAILED');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed coordinator PASS without printing or retrying it', async () => {
    const harness = createHarness({
      coordinatorImpl: async () => coordinatorResult({ extra: 'raw-result-sentinel' })
    });
    await expect(runGateR2RetirementRunner(runnerOptions(harness)))
      .rejects.toThrow('GATE_R2_RETIREMENT_RUNNER_OUTPUT_INVALID');
    expect(harness.coordinator).toHaveBeenCalledTimes(1);
  });

  it('emits only fixed sanitized PASS JSON or a fixed safe error at the CLI boundary', async () => {
    const successHarness = createHarness();
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    await expect(runGateR2RetirementRunnerCli({
      ...runnerOptions(successHarness), stdout, stderr
    })).resolves.toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.write.mock.calls[0][0])).toMatchObject({
      code: 'GATE_R2_RETIREMENT_RUNNER_COMPLETE',
      status: 'PASS'
    });
    expect(stdout.write.mock.calls[0][0]).not.toMatch(/token|password|postgres:\/\/|redis:\/\//iu);

    const failureHarness = createHarness({
      coordinatorImpl: async () => { throw new Error('raw-secret-sentinel'); }
    });
    const failureStdout = { write: jest.fn() };
    const failureStderr = { write: jest.fn() };
    await expect(runGateR2RetirementRunnerCli({
      ...runnerOptions(failureHarness),
      stdout: failureStdout,
      stderr: failureStderr
    })).resolves.toBe(1);
    expect(failureStdout.write).not.toHaveBeenCalled();
    expect(failureStderr.write).toHaveBeenCalledWith(
      'GATE_R2_RETIREMENT_RUNNER_COORDINATOR_FAILED\n'
    );
  });

  it('schema-checks and clears bounded Windows process inspection output', () => {
    const stdout = Buffer.from(JSON.stringify({ alive: true, pid: PID, identity: IDENTITY }));
    const stderr = Buffer.alloc(0);
    const spawn = jest.fn(() => ({ error: undefined, status: 0, stdout, stderr }));
    expect(inspectGateR2WindowsSessionProcess({
      pid: PID,
      environment: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
      powerShellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawn
    })).toEqual({ alive: true, identity: IDENTITY, pid: PID });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
    expect(stdout.every(byte => byte === 0)).toBe(true);
  });

  it('fails closed on malformed Windows process inspection without exposing child output', () => {
    const sentinel = Buffer.from('credential-path-sentinel');
    const spawn = jest.fn(() => ({ error: undefined, status: 0, stdout: sentinel, stderr: Buffer.alloc(0) }));
    expect(() => inspectGateR2WindowsSessionProcess({
      pid: PID,
      environment: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
      powerShellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawn
    })).toThrow('GATE_R2_RETIREMENT_RUNNER_SESSION_PROCESS_INVALID');
    expect(sentinel.every(byte => byte === 0)).toBe(true);
  });
});
