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
const { runWithRequestAbortContext } = await import("@arcanos/runtime");

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

  it("accepts guideUrl as the single guide URL field", async () => {
    await ArcanosGaming.actions.query({
      mode: "guide",
      prompt: "Use this guide.",
      guideUrl: "https://example.com/guide"
    });

    expect(mockRunGuidePipeline).toHaveBeenCalledWith({
      prompt: "Use this guide.",
      game: undefined,
      guideUrl: "https://example.com/guide",
      guideUrls: [],
      auditEnabled: false,
    });
  });

  it("keeps url as a backward-compatible guide URL field", async () => {
    await ArcanosGaming.actions.query({
      mode: "guide",
      prompt: "Use this guide.",
      url: "https://example.com/guide"
    });

    expect(mockRunGuidePipeline).toHaveBeenCalledWith({
      prompt: "Use this guide.",
      game: undefined,
      guideUrl: "https://example.com/guide",
      guideUrls: [],
      auditEnabled: false,
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

  it("returns an incomplete generation error instead of a partial guide when the provider truncates", async () => {
    const incompleteError = Object.assign(new Error("provider output incomplete"), {
      code: "OPENAI_COMPLETION_INCOMPLETE",
      finishReason: "length",
      incompleteReason: "max_output_tokens",
      truncated: true,
      lengthTruncated: true,
      contentFiltered: false
    });
    mockRunGuidePipeline.mockRejectedValueOnce(incompleteError);

    const result = await ArcanosGaming.actions.query({
      mode: "guide",
      game: "Star Wars: The Old Republic",
      prompt: "Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips."
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "guide",
      error: {
        code: "GENERATION_INCOMPLETE",
        message: "Gaming generation did not complete cleanly; no partial answer was returned.",
        details: {
          finishReason: "length",
          incompleteReason: "max_output_tokens",
          truncated: true,
          lengthTruncated: true,
          contentFiltered: false,
          integrityIssues: undefined
        }
      }
    });
  });

  it("returns a controlled generation timeout when the provider aborts before module dispatch expires", async () => {
    const timeoutError = Object.assign(new Error("Request was aborted."), {
      name: "AbortError",
      code: "GAMING_PROVIDER_TIMEOUT",
      timeoutMs: 50_000,
      stageTimeoutMs: 15_000,
      timeoutPhase: "intake"
    });
    mockRunGuidePipeline.mockRejectedValueOnce(timeoutError);

    const result = await ArcanosGaming.actions.query({
      mode: "guide",
      game: "Star Wars: The Old Republic",
      prompt: "Regression check only: Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips. Return a complete coherent answer with valid numbering."
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "guide",
      error: {
        code: "GENERATION_TIMEOUT",
        message: "Gaming generation timed out before a complete answer was available.",
        details: {
          timeoutMs: 50_000,
          stageTimeoutMs: 15_000,
          timeoutPhase: "intake"
        }
      }
    });
  });

  it("returns a controlled generation timeout when the runtime budget expires before module dispatch", async () => {
    const timeoutError = Object.assign(new Error("Gaming guide generation timed out."), {
      code: "GAMING_PROVIDER_TIMEOUT",
      timeoutMs: 50_000,
      stageTimeoutMs: 15_000,
      timeoutPhase: "reasoning"
    });
    mockRunGuidePipeline.mockRejectedValueOnce(timeoutError);

    const result = await ArcanosGaming.actions.query({
      mode: "guide",
      game: "Star Wars: The Old Republic",
      prompt: "Regression check only: Beginner to intermediate guide for tanking in Star Wars The Old Republic including mechanics, threat management, mitigation, positioning, and group play tips. Return a complete coherent answer with valid numbering."
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      route: "gaming",
      mode: "guide",
      error: expect.objectContaining({
        code: "GENERATION_TIMEOUT",
        details: {
          timeoutMs: 50_000,
          stageTimeoutMs: 15_000,
          timeoutPhase: "reasoning"
        }
      })
    }));
  });

  it("preserves parent request aborts instead of mapping them to generation timeouts", async () => {
    const timeoutError = Object.assign(new Error("Outer request was aborted."), {
      name: "AbortError",
      code: "GAMING_PROVIDER_TIMEOUT",
      timeoutMs: 50_000,
      stageTimeoutMs: 15_000,
      timeoutPhase: "request"
    });
    mockRunGuidePipeline.mockRejectedValueOnce(timeoutError);
    const controller = new AbortController();
    controller.abort(timeoutError);

    await expect(runWithRequestAbortContext({
      requestId: "req-gaming-parent-abort",
      controller,
      signal: controller.signal,
      deadlineAt: Date.now(),
      timeoutMs: 1
    }, () => ArcanosGaming.actions.query({
      mode: "guide",
      game: "Star Wars: The Old Republic",
      prompt: "Smoke test: give three short tanking tips with valid numbering."
    }))).rejects.toBe(timeoutError);
  });
});
