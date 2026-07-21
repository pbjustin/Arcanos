import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let telemetryForCleanup: typeof import('../src/platform/logging/telemetry.js') | undefined;
let safetyStateForCleanup: typeof import('../src/services/safety/runtimeState.js') | undefined;

describe('prompt configuration startup log hygiene', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    telemetryForCleanup?.resetTelemetry();
    safetyStateForCleanup?.resetSafetyRuntimeStateForTests();
    telemetryForCleanup = undefined;
    safetyStateForCleanup = undefined;
  });

  it('uses a logical source in startup logs and integrity telemetry', async () => {
    const telemetry = await import('../src/platform/logging/telemetry.js');
    const safetyState = await import('../src/services/safety/runtimeState.js');
    telemetryForCleanup = telemetry;
    safetyStateForCleanup = safetyState;
    telemetry.resetTelemetry();
    safetyState.resetSafetyRuntimeStateForTests();

    const prompts = await import('../src/platform/runtime/prompts.js');
    const config = prompts.getPromptsConfig();
    const snapshot = telemetry.getTelemetrySnapshot();
    const promptLoadLog = snapshot.traces.recentLogs.find(
      entry => entry.message === 'Loaded prompts configuration'
    );
    const integrityEvent = snapshot.traces.recentEvents.find(
      entry => entry.name === 'safety.integrity_baseline_established'
        || entry.name === 'safety.integrity_validation_passed'
    );

    expect(config).toHaveProperty('arcanos');
    expect(promptLoadLog?.context).toMatchObject({
      configSource: 'protected-config:prompts_config'
    });
    expect(promptLoadLog?.context).not.toHaveProperty('configPath');
    expect(integrityEvent?.attributes).toMatchObject({
      source: 'protected-config:prompts_config'
    });

    const observableStartupRecords = JSON.stringify({ promptLoadLog, integrityEvent });
    expect(observableStartupRecords).not.toContain(process.cwd());
    expect(observableStartupRecords).not.toContain('/app/');
    expect(observableStartupRecords).not.toMatch(/[A-Za-z]:[\\/]/u);
  });
});
