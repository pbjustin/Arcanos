import { jest } from "@jest/globals";

import {
  buildJobResultPollUrl,
  isPipelineFallback,
  normalizeArcanosResult,
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

  it("uses the injected fetchFn for the initial query_and_wait request", async () => {
    const globalFetchMock = jest.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("global fetch should not be used")
    );
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        ok: true,
        status: "completed",
        jobId: "job-injected",
        result: { text: "done" },
      })
    );

    const result = await runArcanosJob("Write one section.", {
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
      fetchFn: fetchMock,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      jobId: "job-injected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(globalFetchMock).not.toHaveBeenCalled();
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
      timedOut: true,
      result: { text: "final" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3000/jobs/job-timeout/result");
  });

  it("normalizes poll URLs that already point to result endpoints with trailing slashes", () => {
    expect(
      buildJobResultPollUrl("http://127.0.0.1:3000", "/jobs/job-123/result/", "job-123")
    ).toBe("http://127.0.0.1:3000/jobs/job-123/result");

    expect(
      normalizeArcanosResult({
        ok: true,
        status: "completed",
        jobId: "job-123",
        poll: "/jobs/job-123/result/",
        result: { text: "done" },
      }).poll
    ).toBe("/jobs/job-123/result");
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

  it("jitters poll backoff delays", async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-jitter",
        status: "running",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-jitter",
        status: "running",
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-jitter",
        status: "completed",
        result: { text: "done" },
      }));
    const sleepCalls: number[] = [];

    const result = await pollArcanosJob("job-jitter", {
      baseUrl: "http://127.0.0.1:3000",
      timeoutMs: 10_000,
      intervalMs: 100,
      maxIntervalMs: 1_000,
      fetchFn: fetchMock,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      nowFn: () => 0,
      randomFn: () => 0,
    });

    expect(result.status).toBe("completed");
    expect(sleepCalls).toEqual([80, 120]);
  });

  it("retries HTTP 429 poll responses using Retry-After", async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2",
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-rate-limited",
        status: "completed",
        result: { text: "done" },
      }));
    const sleepCalls: number[] = [];

    const result = await pollArcanosJob("job-rate-limited", {
      baseUrl: "http://127.0.0.1:3000",
      timeoutMs: 10_000,
      intervalMs: 100,
      fetchFn: fetchMock,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      nowFn: () => 0,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      jobId: "job-rate-limited",
      result: { text: "done" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([2_000]);
  });

  it("uses the injected clock for absolute Retry-After dates", async () => {
    const baseNowMs = Date.UTC(2026, 3, 24, 12, 0, 0);
    const retryAt = new Date(baseNowMs + 3_000).toUTCString();
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": retryAt,
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        jobId: "job-rate-limited-date",
        status: "completed",
        result: { text: "done" },
      }));
    const sleepCalls: number[] = [];

    const result = await pollArcanosJob("job-rate-limited-date", {
      baseUrl: "http://127.0.0.1:3000",
      timeoutMs: 10_000,
      intervalMs: 100,
      fetchFn: fetchMock,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      nowFn: () => baseNowMs,
    });

    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([3_000]);
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
