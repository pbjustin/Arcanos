import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerDebugMock = jest.fn();
const getConfigMock = jest.fn();
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
});
