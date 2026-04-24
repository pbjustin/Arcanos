import { jest } from "@jest/globals";

import {
  isPipelineFallback,
  pollArcanosJob,
  runArcanosJob,
} from "../src/client/arcanosJob.js";

function createJsonResponse(payload: Record<string, unknown>, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

describe("ARCANOS async job client", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("returns an initial completed response immediately", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({
        ok: true,
        status: "completed",
        jobId: "job-complete",
        result: { text: "done" },
      })
    );

    const result = await runArcanosJob("Write one section.", {
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      jobId: "job-complete",
      result: { text: "done" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls a timedOut response until completed", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        status: "timeout",
        timedOut: true,
        jobId: "job-timeout",
        poll: "/jobs/job-timeout",
        stream: "/jobs/job-timeout/stream",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-timeout",
        status: "running",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-timeout",
        status: "completed",
        result: { text: "final" },
      }));

    const result = await runArcanosJob("Write one section.", {
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
      sleepFn: async () => {},
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      jobId: "job-timeout",
      poll: "http://127.0.0.1:3000/jobs/job-timeout/result",
      stream: "/jobs/job-timeout/stream",
      result: { text: "final" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3000/jobs/job-timeout/result");
  });

  it("polls a queued response until completed", async () => {
    jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        status: "queued",
        jobId: "job-queued",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-queued",
        status: "completed",
        result: { markdown: "## Done" },
      }));

    const result = await runArcanosJob("Write one section.", {
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
      sleepFn: async () => {},
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      jobId: "job-queued",
      result: { markdown: "## Done" },
    });
  });

  it("surfaces a failed polled job as an error", async () => {
    jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        status: "queued",
        jobId: "job-failed",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-failed",
        status: "failed",
        error: { message: "worker execution failed" },
      }));

    await expect(
      runArcanosJob("Write one section.", {
        baseUrl: "http://127.0.0.1:3000",
        gptId: "arcanos-core",
        sleepFn: async () => {},
      })
    ).rejects.toThrow("worker execution failed");
  });

  it("times out polling safely", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        jobId: "job-slow",
        status: "running",
      })
    );
    let now = 0;

    await expect(
      pollArcanosJob("job-slow", {
        baseUrl: "http://127.0.0.1:3000",
        timeoutMs: 1_000,
        intervalMs: 100,
        fetchFn: fetchMock,
        sleepFn: async () => {},
        nowFn: () => {
          const current = now;
          now += 600;
          return current;
        },
      })
    ).rejects.toThrow("polling timed out after 1000ms");
  });

  it("detects fallbackFlag fallback metadata", () => {
    expect(isPipelineFallback({ fallbackFlag: true })).toBe(true);
  });

  it("detects pipeline_timeout fallback metadata", () => {
    expect(isPipelineFallback({ timeoutKind: "pipeline_timeout" })).toBe(true);
  });

  it("detects static-timeout-fallback model metadata", () => {
    expect(isPipelineFallback({ activeModel: "arcanos-core:static-timeout-fallback" })).toBe(true);
  });

  it("detects auditSafe CORE_PIPELINE_TIMEOUT_FALLBACK metadata", () => {
    expect(isPipelineFallback({
      auditSafe: {
        auditFlags: ["CORE_PIPELINE_TIMEOUT_FALLBACK"],
      },
    })).toBe(true);
  });
});
