import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerDebugMock = jest.fn();
const invokeToolMock = jest.fn(async () => { throw new Error('Offline fixture: no tooling.'); });
const dispatchProtocolRequestMock = jest.fn(async () => { throw new Error('Offline fixture: no execution state.'); });
const spawnMock = jest.fn(() => { throw new Error('Offline fixture: no subprocess.'); });
const getDiagnosticsSnapshotMock = jest.fn(async () => ({ error_rate: 0 }));
const actualUnifiedConfig = await import('../src/platform/runtime/unifiedConfig.js');
const getConfigMock = jest.fn(() => actualUnifiedConfig.getConfig());
const loggerMock = {
  info: loggerInfoMock,
  warn: loggerWarnMock,
  error: loggerErrorMock,
  debug: loggerDebugMock,
  child: jest.fn(() => ({
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: loggerDebugMock
  }))
};

jest.unstable_mockModule('@arcanos/cli/client', () => ({ invokeTool: invokeToolMock }));
jest.unstable_mockModule('@arcanos/cli/transport', () => ({ dispatchProtocolRequest: dispatchProtocolRequestMock }));
jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: { getDiagnosticsSnapshot: getDiagnosticsSnapshotMock }
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  logger: loggerMock
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: jest.fn((_name: string, fallback?: string) => fallback),
  getEnvBoolean: jest.fn((_name: string, fallback: boolean) => fallback),
  getEnvNumber: jest.fn((_name: string, fallback: number) => fallback)
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock,
  getStableWorkerRuntimeMode: jest.fn(() => ({
    requestedRunWorkers: true,
    resolvedRunWorkers: true,
    processKind: 'web',
    railwayServiceName: 'ARCANOS V2',
    reason: 'configured'
  })),
  isWorkerRuntimeSuppressedForServiceRole: jest.fn(() => false)
}));

const {
  getSelfHealingControlLoopStatus,
  requestSelfHealingLoopEvaluation,
  startSelfHealingControlLoop,
  stopSelfHealingControlLoopForTests
} = await import('../src/services/selfImprove/controlLoop.js');

describe('self-heal control loop startup in tests', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableLoopInTests = process.env.ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS;
    getConfigMock.mockReturnValue({
      ...actualUnifiedConfig.getConfig(),
      selfImproveEnabled: true,
      selfImproveActuatorMode: 'daemon',
      selfImproveAutonomyLevel: 3,
      selfImproveFrozen: false
    });
    stopSelfHealingControlLoopForTests();
  });

  afterEach(() => {
    stopSelfHealingControlLoopForTests();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnableLoopInTests === undefined) {
      delete process.env.ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS;
    } else {
      process.env.ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS = originalEnableLoopInTests;
    }
  });

  it('does not start background timers or async probes during Jest by default', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    startSelfHealingControlLoop({} as never);
    await requestSelfHealingLoopEvaluation('test');

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(invokeToolMock).not.toHaveBeenCalled();
    expect(dispatchProtocolRequestMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(getDiagnosticsSnapshotMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'self_heal.loop.disabled_for_test',
      expect.objectContaining({
        module: 'self_heal.loop',
        reason: 'test_environment'
      })
    );
    expect(getSelfHealingControlLoopStatus()).toEqual(expect.objectContaining({
      active: false,
      loopRunning: false
    }));
  });

  it('cannot start a competing legacy scheduler even when explicitly requested', async () => {
    process.env.ENABLE_SELF_HEAL_CONTROL_LOOP_IN_TESTS = 'true';
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    startSelfHealingControlLoop({} as never);
    await requestSelfHealingLoopEvaluation('legacy_caller');

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(getSelfHealingControlLoopStatus()).toMatchObject({
      active: false,
      loopRunning: false,
      incidentActive: false,
      mitigation: { activeAction: null }
    });
  });
});
