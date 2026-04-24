import { jest } from "@jest/globals";

import {
  ARCANOS_DEGRADED_FALLBACK_MESSAGE,
  type ArcanosJobResult,
} from "../src/client/arcanosJob.js";
import {
  generateDocsUpdate,
  type DocsGenerationSection,
} from "../src/client/docsGenerator.js";

const TEST_SECTION: DocsGenerationSection = {
  id: "test-section",
  title: "Test Section",
  prompt: "Write the test section.",
  retryPrompt: "Write only a compact test section.",
};

function completedResult(markdown: string, jobId = "job-ok"): ArcanosJobResult {
  return {
    ok: true,
    status: "completed",
    jobStatus: "completed",
    jobId,
    poll: `/jobs/${jobId}/result`,
    stream: `/jobs/${jobId}/stream`,
    timedOut: false,
    degraded: false,
    result: { markdown },
    raw: {
      ok: true,
      status: "completed",
      jobId,
      result: { markdown },
    },
  };
}

function degradedResult(jobId = "job-degraded"): ArcanosJobResult {
  return {
    ok: false,
    status: "degraded",
    jobStatus: "completed",
    jobId,
    poll: `/jobs/${jobId}/result`,
    stream: `/jobs/${jobId}/stream`,
    timedOut: false,
    degraded: true,
    result: {
      text: "fallback text",
      fallbackFlag: true,
      timeoutKind: "pipeline_timeout",
      activeModel: "arcanos-core:static-timeout-fallback",
    },
    raw: {
      ok: true,
      status: "completed",
      jobId,
      result: {
        fallbackFlag: true,
      },
    },
  };
}

describe("docs generator", () => {
  it("retries with the narrower prompt when fallback is detected", async () => {
    const runJob = jest.fn<(prompt: string) => Promise<ArcanosJobResult>>()
      .mockResolvedValueOnce(degradedResult("job-first"))
      .mockResolvedValueOnce(completedResult("## Retried Section\n\nRecovered.", "job-retry"));

    const result = await generateDocsUpdate({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
      sections: [TEST_SECTION],
      strict: true,
      generatedAt: "2026-04-24T00:00:00.000Z",
      runJob,
    });

    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob.mock.calls[0]?.[0]).toBe(TEST_SECTION.prompt);
    expect(runJob.mock.calls[1]?.[0]).toBe(TEST_SECTION.retryPrompt);
    expect(result.ok).toBe(true);
    expect(result.sections[0]).toMatchObject({
      id: "test-section",
      attempts: 2,
      degraded: false,
    });
    expect(result.updates[0]?.content).toContain("## Retried Section");
  });

  it("fails clearly after repeated degraded fallback", async () => {
    const runJob = jest.fn<(prompt: string) => Promise<ArcanosJobResult>>()
      .mockResolvedValueOnce(degradedResult("job-first"))
      .mockResolvedValueOnce(degradedResult("job-retry"));

    await expect(
      generateDocsUpdate({
        baseUrl: "http://127.0.0.1:3000",
        gptId: "arcanos-core",
        sections: [TEST_SECTION],
        strict: true,
        runJob,
      })
    ).rejects.toThrow(ARCANOS_DEGRADED_FALLBACK_MESSAGE);
  });
});
