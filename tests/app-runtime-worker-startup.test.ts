import type { Express } from 'express';
import { describe, expect, it, jest } from '@jest/globals';

const startConfiguredWorkerRuntime = jest.fn(async () => null);
const startSelfHealingControlLoop = jest.fn();
const logStartupSummary = jest.fn(async () => undefined);
const configureDefaultArcanosCoreRuntimeProviders = jest.fn();

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  startConfiguredWorkerRuntime
}));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders
}));
jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  startSelfHealingControlLoop
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary,
    recordRequestCompletion: jest.fn()
  }
}));
jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn()
}));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn()
}));
jest.unstable_mockModule('@routes/register.js', () => ({
  registerRoutes: jest.fn()
}));
jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {}
}));
jest.unstable_mockModule('@services/gptAccessGateway.js', () => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    gptAccessAuthMiddleware: passThrough,
    requireGptAccessScope: () => passThrough
  };
});

const { startAppRuntimeOnce } = await import('../src/app.js');

describe('application runtime worker ownership', () => {
  it('starts background components once for the same application instance', () => {
    const app = {} as Express;

    expect(startAppRuntimeOnce(app)).toBe(true);
    expect(startAppRuntimeOnce(app)).toBe(false);

    expect(startConfiguredWorkerRuntime).toHaveBeenCalledTimes(1);
    expect(startSelfHealingControlLoop).toHaveBeenCalledTimes(1);
    expect(startSelfHealingControlLoop).toHaveBeenCalledWith(app);
    expect(logStartupSummary).toHaveBeenCalledTimes(1);
    expect(logStartupSummary).toHaveBeenCalledWith(app);
  });
});
