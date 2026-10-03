import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  getGamingConfiguredStageTimeoutMs, getGamingExecutionBudget,
  getGamingModuleTimeoutMs, getGamingPipelineTimeoutMs, getGamingStageTimeoutMs
} from "../src/services/gamingConfig.js";

const envKeys = [
  "ARCANOS_GAMING_MODULE_TIMEOUT_MS", "ARCANOS_GAMING_PIPELINE_TIMEOUT_MS",
  "ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS", "ARCANOS_GAMING_BUILD_PIPELINE_TIMEOUT_MS",
  "ARCANOS_GAMING_META_PIPELINE_TIMEOUT_MS", "ARCANOS_GAMING_STAGE_TIMEOUT_MS",
  "ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS", "ARCANOS_GAMING_BUILD_STAGE_TIMEOUT_MS",
  "ARCANOS_GAMING_META_STAGE_TIMEOUT_MS"
] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of envKeys) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  jest.resetModules();
});

describe("ArcanosGaming configuration", () => {
  it.each([["45000", 45_000], ["90000ms", 60_000]] as const)(
    "advertises configured module timeout %s to dispatch within the safe envelope", async (configured, expected) => {
      jest.resetModules();
      process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = configured;

      jest.unstable_mockModule("@services/gaming.js", () => ({
        runGuidePipeline: jest.fn(),
        runBuildPipeline: jest.fn(),
        runMetaPipeline: jest.fn()
      }));
      jest.unstable_mockModule("../src/services/hrcWrapper.js", () => ({
        evaluateWithHRC: jest.fn()
      }));

      const { ArcanosGaming } = await import("../src/services/arcanos-gaming.js");

      expect(ArcanosGaming.defaultTimeoutMs).toBe(expected);
    });

  it.each(["guide", "build", "meta"] as const)("defaults %s to the same 50s provider pipeline", mode => {
    expect(getGamingModuleTimeoutMs()).toBe(60_000);
    expect(getGamingPipelineTimeoutMs(mode, null)).toBe(50_000);
    expect(getGamingExecutionBudget(mode, 60_000)).toMatchObject({
      mcpOperationTimeoutMs: 60_000, pipelineTimeoutMs: 50_000, outerHeadroomMs: 10_000
    });
  });

  it("respects lower pipeline and module operator caps together", () => {
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = "40000";
    process.env.ARCANOS_GAMING_PIPELINE_TIMEOUT_MS = "20000";
    expect(getGamingModuleTimeoutMs()).toBe(40_000);
    expect(getGamingPipelineTimeoutMs("build", null)).toBe(20_000);
    expect(getGamingPipelineTimeoutMs("build", 25_000)).toBe(15_000);
  });

  it("lets the mode-specific pipeline override win over the generic cap", () => {
    process.env.ARCANOS_GAMING_PIPELINE_TIMEOUT_MS = "12000";
    process.env.ARCANOS_GAMING_BUILD_PIPELINE_TIMEOUT_MS = "30000";
    expect(getGamingPipelineTimeoutMs("build", null)).toBe(30_000);
    expect(getGamingPipelineTimeoutMs("meta", null)).toBe(12_000);
    expect(getGamingPipelineTimeoutMs("build", 25_000)).toBe(15_000);
  });

  it("caps larger configuration at the safe envelope and the remaining caller", () => {
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = "90000";
    process.env.ARCANOS_GAMING_PIPELINE_TIMEOUT_MS = "80000";
    process.env.ARCANOS_GAMING_BUILD_PIPELINE_TIMEOUT_MS = "100000";
    expect(getGamingModuleTimeoutMs()).toBe(60_000);
    expect(getGamingPipelineTimeoutMs("build", null)).toBe(50_000);
    expect(getGamingPipelineTimeoutMs("build", 30_000)).toBe(20_000);
  });

  it("keeps lower stage overrides and mode precedence within pipeline reserves", () => {
    process.env.ARCANOS_GAMING_STAGE_TIMEOUT_MS = "4000";
    process.env.ARCANOS_GAMING_BUILD_STAGE_TIMEOUT_MS = "2000";
    expect(getGamingConfiguredStageTimeoutMs("build")).toBe(2_000);
    expect(getGamingStageTimeoutMs("build", 50_000)).toBe(2_000);
    expect(getGamingStageTimeoutMs("meta", 50_000)).toBe(4_000);
    process.env.ARCANOS_GAMING_BUILD_STAGE_TIMEOUT_MS = "90000";
    expect(getGamingStageTimeoutMs("build", 12_000)).toBe(2_500);
  });

  it("returns zero pipeline budget when the caller cannot supply required outer headroom", () => {
    expect(getGamingPipelineTimeoutMs("build", 10_000)).toBe(0);
    expect(getGamingPipelineTimeoutMs("build", 0)).toBe(0);
    process.env.ARCANOS_GAMING_MODULE_TIMEOUT_MS = "5000";
    expect(getGamingPipelineTimeoutMs("build", null)).toBe(0);
  });
});
