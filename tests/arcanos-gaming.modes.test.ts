import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRunGuidePipeline = jest.fn();
const mockRunBuildPipeline = jest.fn();
const mockRunMetaPipeline = jest.fn();
const mockEvaluateWithHRC = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  timed: jest.fn(),
  startTimer: jest.fn(() => jest.fn()),
  child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.unstable_mockModule("../src/services/gaming.js", () => ({
  runGuidePipeline: mockRunGuidePipeline,
  runBuildPipeline: mockRunBuildPipeline,
  runMetaPipeline: mockRunMetaPipeline,
}));

jest.unstable_mockModule("../src/services/hrcWrapper.js", () => ({
  evaluateWithHRC: mockEvaluateWithHRC,
}));

jest.unstable_mockModule("../src/platform/logging/structuredLogging.js", () => ({
  LogLevel: {
    DEBUG: "debug",
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
  },
  logger: mockLogger,
  apiLogger: mockLogger,
  dbLogger: mockLogger,
  aiLogger: mockLogger,
  workerLogger: mockLogger,
  sanitize: jest.fn((value: unknown) => value),
  getConfiguredLogLevel: jest.fn(() => "info"),
  requestLoggingMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  healthMetrics: {
    record: jest.fn(),
    increment: jest.fn(),
    getMetrics: jest.fn(() => ({})),
    getSnapshot: jest.fn(() => ({})),
  },
  default: mockLogger,
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
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: "gaming",
      mode: "guide",
      data: expect.objectContaining({
        response: expect.stringContaining("Guide response"),
        sources: [],
      }),
    }));
    expect((result as any).data.response).toContain("Quick Answer");
    expect((result as any).data.response).toContain("Why It Works");
    expect((result as any).data.response).toContain("Watch Outs");
  });

  it("returns a fixed-safe envelope when HRC verification fails", async () => {
    mockEvaluateWithHRC.mockRejectedValueOnce(new Error("secret provider response body"));

    const result = await ArcanosGaming.actions.query({
      mode: "guide",
      game: "Elden Ring",
      prompt: "Give me a concise beginner guide.",
      hrc: true
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "guide",
      error: {
        code: "MODULE_ERROR",
        message: "Gaming response verification could not be completed safely."
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret provider response body");
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

  it.each([
    ["build", mockRunBuildPipeline],
    ["meta", mockRunMetaPipeline],
  ] as const)("lets a supplied generic URL reach the %s pipeline before game clarification", async (mode, pipeline) => {
    const result = await ArcanosGaming.actions.query({
      mode,
      prompt: "Use the supplied article for this request.",
      guideUrl: "https://community.example/article/123",
    });

    expect(pipeline).toHaveBeenCalledWith({
      prompt: "Use the supplied article for this request.",
      game: undefined,
      guideUrl: "https://community.example/article/123",
      guideUrls: [],
      auditEnabled: false,
    });
    expect(result).toEqual(expect.objectContaining({ ok: true, mode }));
  });

  it("translates failed supplied-page game detection into build clarification", async () => {
    mockRunBuildPipeline.mockRejectedValueOnce(Object.assign(new Error("game could not be identified"), {
      code: "GAMING_GAME_REQUIRED",
    }));

    const result = await ArcanosGaming.actions.query({
      mode: "build",
      prompt: "best build for the current patch",
      guideUrl: "https://unknown.example/article/123",
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "build",
      error: {
        code: "CLARIFICATION_REQUIRED",
        message: "Which game should I use for this build request?",
        details: {
          missing: ["game"],
        },
      },
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

  it("returns a structured non-gaming error for a bare ping prompt", async () => {
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
        code: "NON_GAMING_REQUEST",
        message: "ARCANOS Gaming handles gameplay guide, build, and meta requests.",
      },
    });
  });

  it("returns a controlled fallback when the provider reports incomplete generation", async () => {
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

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: "gaming",
      mode: "guide",
      data: expect.objectContaining({
        response: expect.stringContaining("General Fallback (not backend-supported)")
      })
    }));
    expect((result as any).data.response).toContain("safe deterministic fallback was used");
    expect((result as any).data.response).not.toMatch(/timeout|incomplete|integrity/i);
  });

  it("returns build clarification without calling fallback or provider", async () => {
    const result = await ArcanosGaming.actions.query({
      mode: "build",
      prompt: "Make me a tank build."
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "build",
      error: {
        code: "CLARIFICATION_REQUIRED",
        message: "Which game should I use for this build request?",
        details: {
          missing: ["game"]
        }
      }
    });
    expect(mockRunBuildPipeline).not.toHaveBeenCalled();
    expect(mockRunGuidePipeline).not.toHaveBeenCalled();
    expect(mockRunMetaPipeline).not.toHaveBeenCalled();
  });

  it("returns meta clarification without calling fallback or provider", async () => {
    const result = await ArcanosGaming.actions.query({
      mode: "meta",
      prompt: "Is frost mage still viable this patch?"
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "meta",
      error: {
        code: "CLARIFICATION_REQUIRED",
        message: "Which game should I use for this meta request?",
        details: {
          missing: ["game"]
        }
      }
    });
    expect(mockRunMetaPipeline).not.toHaveBeenCalled();
    expect(mockRunBuildPipeline).not.toHaveBeenCalled();
    expect(mockRunGuidePipeline).not.toHaveBeenCalled();
  });

  it("surfaces genuine Trinity integrity failures as generation integrity errors", async () => {
    const integrityError = Object.assign(new Error("Trinity direct-answer output failed integrity validation."), {
      code: "TRINITY_OUTPUT_INTEGRITY_FAILED",
      integrityIssues: ["broken_numbering"]
    });
    mockRunMetaPipeline.mockRejectedValueOnce(integrityError);

    const result = await ArcanosGaming.actions.query({
      mode: "meta",
      game: "World of Warcraft",
      prompt: "Is frost mage still viable this patch?"
    });

    expect(result).toEqual({
      ok: false,
      route: "gaming",
      mode: "meta",
      error: {
        code: "GENERATION_INTEGRITY_FAILED",
        message: "Gaming generation did not complete cleanly; no partial answer was returned.",
        details: {
          finishReason: undefined,
          incompleteReason: undefined,
          truncated: undefined,
          lengthTruncated: undefined,
          contentFiltered: undefined,
          integrityIssues: ["broken_numbering"]
        }
      }
    });
  });

  it("returns a controlled fallback when the provider aborts before module dispatch expires", async () => {
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

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      route: "gaming",
      mode: "guide",
      data: expect.objectContaining({
        response: expect.stringContaining("General Fallback (not backend-supported)")
      })
    }));
    expect((result as any).data.response).toContain("safe deterministic fallback was used");
    expect((result as any).data.response).not.toMatch(/timeout|incomplete|integrity/i);
  });

  it("returns a controlled fallback when the runtime budget expires before module dispatch", async () => {
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
      ok: true,
      route: "gaming",
      mode: "guide",
      data: expect.objectContaining({
        response: expect.stringContaining("General Fallback (not backend-supported)")
      })
    }));
    expect((result as any).data.response).toContain("safe deterministic fallback was used");
    expect((result as any).data.response).not.toMatch(/timeout|incomplete|integrity/i);
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
