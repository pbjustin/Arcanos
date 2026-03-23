import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRunGuidePipeline = jest.fn();
const mockRunBuildPipeline = jest.fn();
const mockRunMetaPipeline = jest.fn();
const mockEvaluateWithHRC = jest.fn();

jest.unstable_mockModule("../src/services/gaming.js", () => ({
  runGuidePipeline: mockRunGuidePipeline,
  runBuildPipeline: mockRunBuildPipeline,
  runMetaPipeline: mockRunMetaPipeline,
}));

jest.unstable_mockModule("../src/services/hrcWrapper.js", () => ({
  evaluateWithHRC: mockEvaluateWithHRC,
}));

const { ArcanosGaming } = await import("../src/services/arcanos-gaming.js");

describe("ArcanosGaming mode routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunGuidePipeline.mockResolvedValue({
      ok: true,
      route: "gaming",
      mode: "guide",
      data: {
        response: "Guide response",
        sources: [],
      },
    });
    mockRunBuildPipeline.mockResolvedValue({
      ok: true,
      route: "gaming",
      mode: "build",
      data: {
        response: "Build response",
        sources: [],
      },
    });
    mockRunMetaPipeline.mockResolvedValue({
      ok: true,
      route: "gaming",
      mode: "meta",
      data: {
        response: "Meta response",
        sources: [],
      },
    });
    mockEvaluateWithHRC.mockResolvedValue({ fidelity: 1, resilience: 1, verdict: "ok" });
  });

  it("routes guide mode to the guide pipeline only", async () => {
    const result = await ArcanosGaming.actions.query({
      mode: "guide",
      prompt: "Where do I go next?",
    });

    expect(mockRunGuidePipeline).toHaveBeenCalledWith({
      prompt: "Where do I go next?",
      game: undefined,
      guideUrl: undefined,
      guideUrls: [],
      auditEnabled: false,
    });
    expect(mockRunBuildPipeline).not.toHaveBeenCalled();
    expect(mockRunMetaPipeline).not.toHaveBeenCalled();
    expect(mockEvaluateWithHRC).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      route: "gaming",
      mode: "guide",
      data: {
        response: "Guide response",
        sources: [],
      },
    });
  });

  it("routes build mode to the build pipeline only", async () => {
    const result = await ArcanosGaming.actions.query({
      mode: "build",
      prompt: "What is the best burst build?",
      game: "SWTOR",
    });

    expect(mockRunBuildPipeline).toHaveBeenCalledWith({
      prompt: "What is the best burst build?",
      game: "SWTOR",
      guideUrl: undefined,
      guideUrls: [],
      auditEnabled: false,
    });
    expect(mockRunGuidePipeline).not.toHaveBeenCalled();
    expect(mockRunMetaPipeline).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        mode: "build",
      })
    );
  });

  it("routes meta mode to the meta pipeline only", async () => {
    const result = await ArcanosGaming.actions.query({
      mode: "meta",
      prompt: "What is strong in ranked right now?",
      game: "SWTOR",
    });

    expect(mockRunMetaPipeline).toHaveBeenCalledWith({
      prompt: "What is strong in ranked right now?",
      game: "SWTOR",
      guideUrl: undefined,
      guideUrls: [],
      auditEnabled: false,
    });
    expect(mockRunGuidePipeline).not.toHaveBeenCalled();
    expect(mockRunBuildPipeline).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        mode: "meta",
      })
    );
  });

  it("returns a structured error when mode is missing", async () => {
    const result = await ArcanosGaming.actions.query({
      prompt: "ping",
    });

    expect(mockRunGuidePipeline).not.toHaveBeenCalled();
    expect(mockRunBuildPipeline).not.toHaveBeenCalled();
    expect(mockRunMetaPipeline).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: null,
      error: {
        code: "GAMEPLAY_MODE_REQUIRED",
        message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
      },
    });
  });
});
