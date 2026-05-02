import { afterEach, describe, expect, it, jest } from "@jest/globals";

const originalModuleTimeout = process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS;

afterEach(() => {
  if (originalModuleTimeout === undefined) {
    delete process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS;
  } else {
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = originalModuleTimeout;
  }
  jest.resetModules();
});

describe("ArcanosGaming configuration", () => {
  it("advertises the configured gaming module timeout to dispatch", async () => {
    jest.resetModules();
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = "90000ms";

    jest.unstable_mockModule("@services/gaming.js", () => ({
      runGuidePipeline: jest.fn(),
      runBuildPipeline: jest.fn(),
      runMetaPipeline: jest.fn()
    }));
    jest.unstable_mockModule("../src/services/hrcWrapper.js", () => ({
      evaluateWithHRC: jest.fn()
    }));

    const { ArcanosGaming } = await import("../src/services/arcanos-gaming.js");

    expect(ArcanosGaming.defaultTimeoutMs).toBe(90_000);
  });
});
