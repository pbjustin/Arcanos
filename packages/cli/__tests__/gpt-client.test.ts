import { readFileSync } from "node:fs";
import path from "node:path";

import { jest } from "@jest/globals";

import {
  createAsyncGptJob,
  generatePromptAndWait,
  fetchGptJobResult,
  getGptRouteJobResult,
  getGptRouteJobStatus,
  getJobResult,
  getJobStatus,
  invokeGptRoute,
  queryAndWaitGptRoute,
  requestGptJobResult,
  requestGptJobStatus,
  requestQuery,
  requestQueryAndWait
} from "../src/client/backend.js";

function createJsonResponse(payload: Record<string, unknown>, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

describe("GPT route OpenAPI contract and client", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("uses a path-bound gptId and omits body gptId and default ask action", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, result: "generic route ok" })
    );

    await createAsyncGptJob({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-gaming",
      prompt: "How do I beat the boss?"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/gpt/arcanos-gaming", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        method: "POST"
      })
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      prompt: "How do I beat the boss?"
    });
    expect(body).not.toHaveProperty("gptId");
    expect(body).not.toHaveProperty("action");
  });

  it("preserves an explicit supported action without injecting unsupported defaults", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, result: "explicit route ok" })
    );

    await invokeGptRoute({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "backstage-booker",
      prompt: "Build tonight's card.",
      action: "generateBooking",
      payload: {
        brand: "AEW"
      },
      context: {
        locale: "en-US"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      prompt: "Build tonight's card.",
      action: "generateBooking",
      payload: {
        brand: "AEW"
      },
      context: {
        locale: "en-US"
      }
    });
    expect(body.action).not.toBe("ask");
  });

  it("builds an explicit queue-backed direct-return GPT request", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, result: "Generated Seth Rollins prompt" })
    );

    await generatePromptAndWait({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
      prompt: "Generate a Seth Rollins promo prompt",
      timeoutMs: 20_000,
      pollIntervalMs: 125
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      prompt: "Generate a Seth Rollins promo prompt",
      executionMode: "async",
      waitForResultMs: 20_000,
      pollIntervalMs: 125
    });
  });

  it("builds the explicit query GPT action contract", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, jobId: "job-query-1", status: "pending" })
    );

    const payload = await requestQuery({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "backstage-booker",
      prompt: "Draft the next promo"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      prompt: "Draft the next promo",
      action: "query"
    });
    expect(payload).toMatchObject({
      ok: true,
      action: "query",
      jobId: "job-query-1",
      status: "pending"
    });
  });

  it("ignores wait controls when callers try to send them with the query action", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, jobId: "job-query-2", status: "pending" })
    );

    await requestQuery({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "backstage-booker",
      prompt: "Draft the next promo",
      timeoutMs: 25_000,
      pollIntervalMs: 500
    } as any);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      prompt: "Draft the next promo",
      action: "query"
    });
    expect(body).not.toHaveProperty("waitForResultMs");
    expect(body).not.toHaveProperty("pollIntervalMs");
  });

  it("builds the explicit query_and_wait GPT action contract", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, result: "Generated Seth Rollins prompt" })
    );

    await requestQueryAndWait({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "arcanos-core",
      prompt: "Generate a Seth Rollins promo prompt",
      timeoutMs: 25_000,
      pollIntervalMs: 500
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      prompt: "Generate a Seth Rollins promo prompt",
      action: "query_and_wait",
      waitForResultMs: 25_000,
      pollIntervalMs: 500
    });
  });

  it("builds the explicit get_status GPT action contract", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, action: "get_status", jobId: "job-123", status: "running" })
    );

    const payload = await requestGptJobStatus({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "backstage-booker",
      jobId: "job-123"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      action: "get_status",
      payload: {
        jobId: "job-123"
      }
    });
    expect(payload).toMatchObject({
      ok: true,
      action: "get_status",
      jobId: "job-123",
      status: "running"
    });
  });

  it("builds the explicit get_result GPT action contract", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, action: "get_result", jobId: "job-123", status: "completed", output: { text: "done" } })
    );

    const payload = await requestGptJobResult({
      baseUrl: "http://127.0.0.1:3000",
      gptId: "backstage-booker",
      jobId: "job-123"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body).toEqual({
      action: "get_result",
      payload: {
        jobId: "job-123"
      }
    });
    expect(payload).toMatchObject({
      ok: true,
      action: "get_result",
      jobId: "job-123",
      status: "completed",
      result: {
        text: "done"
      }
    });
  });

  it("reads job results from the canonical /jobs/{jobId}/result route", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ jobId: "job-123", status: "completed", result: { text: "final output" } })
    );

    const payload = await getJobResult({
      baseUrl: "http://127.0.0.1:3000",
      jobId: "job-123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/jobs/job-123/result", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        headers: {}
      })
    );
    expect(payload).toMatchObject({
      ok: true,
      action: "get_result",
      jobId: "job-123",
      status: "completed",
      result: {
        text: "final output"
      }
    });
  });

  it("reads job status from the canonical /jobs/{jobId} route", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ id: "job-123", status: "running" })
    );

    const payload = await getJobStatus({
      baseUrl: "http://127.0.0.1:3000",
      jobId: "job-123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/jobs/job-123", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        headers: {}
      })
    );
    expect(payload).toMatchObject({
      ok: true,
      action: "get_status",
      jobId: "job-123",
      status: "running"
    });
  });

  it("keeps fetchGptJobResult as a compatibility alias over the canonical jobs API", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, result: { status: "complete" } })
    );

    await fetchGptJobResult({
      baseUrl: "http://127.0.0.1:3000",
      jobId: "job-123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/jobs/job-123/result", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        headers: {}
      })
    );
  });

  it("rejects blank job ids before any jobs API call is attempted", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch");

    await expect(
      getJobResult({
        baseUrl: "http://127.0.0.1:3000",
        jobId: "   "
      })
    ).rejects.toThrow("Job lookup jobId is required.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defines the OpenAPI contract on POST /gpt/{gptId} with path-bound gptId only", () => {
    const specPath = path.resolve(process.cwd(), "contracts", "custom_gpt_route.openapi.v1.json");
    const spec = JSON.parse(readFileSync(specPath, "utf-8")) as Record<string, any>;

    expect(Object.keys(spec.paths ?? {})).toEqual(["/gpt/{gptId}"]);

    const operation = spec.paths?.["/gpt/{gptId}"]?.post;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "gptId",
          in: "path",
          required: true
        })
      ])
    );

    const requestSchema = spec.components?.schemas?.GptRouteRequest;
    expect(requestSchema).toEqual(
      expect.objectContaining({
        oneOf: expect.any(Array),
        discriminator: expect.objectContaining({
          propertyName: "action"
        })
      })
    );
    expect(requestSchema?.oneOf).toEqual(
      expect.arrayContaining([
        { $ref: "#/components/schemas/GenericPromptRequest" },
        { $ref: "#/components/schemas/QueryActionRequest" },
        { $ref: "#/components/schemas/QueryAndWaitActionRequest" },
        { $ref: "#/components/schemas/GetStatusActionRequest" },
        { $ref: "#/components/schemas/GetResultActionRequest" },
      ])
    );
    expect(spec.components?.schemas?.QueryActionRequest?.allOf?.[1]?.required ?? []).toEqual(
      expect.arrayContaining(["action", "prompt"])
    );
    expect(spec.components?.schemas?.QueryAndWaitActionRequest?.allOf?.[1]?.required ?? []).toEqual(
      expect.arrayContaining(["action", "prompt"])
    );
    expect(spec.components?.schemas?.GetStatusActionRequest?.required ?? []).toEqual(
      expect.arrayContaining(["action", "payload"])
    );
    expect(spec.components?.schemas?.GetResultActionRequest?.required ?? []).toEqual(
      expect.arrayContaining(["action", "payload"])
    );
    expect(
      spec.paths?.["/gpt/{gptId}"]?.post?.requestBody?.content?.["application/json"]?.examples?.genericPrompt?.value
    ).toEqual({
      prompt: "Help me with this module request."
    });
    expect(
      spec.paths?.["/gpt/{gptId}"]?.post?.requestBody?.content?.["application/json"]?.examples?.query?.value
    ).toEqual({
      action: "query",
      prompt: "Create the writing job and return its identifier."
    });
    expect(
      spec.paths?.["/gpt/{gptId}"]?.post?.requestBody?.content?.["application/json"]?.examples?.getResult?.value
    ).toEqual({
      action: "get_result",
      payload: {
        jobId: "59dbfb2b-0c64-4eda-8a1e-b950a63f7fe0"
      }
    });
    expect(
      spec.paths?.["/gpt/{gptId}"]?.post?.requestBody?.content?.["application/json"]?.examples?.getStatus?.value
    ).toEqual({
      action: "get_status",
      payload: {
        jobId: "59dbfb2b-0c64-4eda-8a1e-b950a63f7fe0"
      }
    });
    expect(
      spec.paths?.["/gpt/{gptId}"]?.post?.requestBody?.content?.["application/json"]?.examples?.queryAndWait?.value
    ).toEqual({
      action: "query_and_wait",
      prompt: "Wait briefly for a fast completion.",
      timeoutMs: 25000,
      pollIntervalMs: 500
    });
  });

  it("preserves backend HTTP status details when the error body is plain text", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("backend unavailable", {
        status: 503,
        headers: {
          "content-type": "text/plain"
        }
      })
    );

    await expect(
      invokeGptRoute({
        baseUrl: "http://127.0.0.1:3000",
        gptId: "arcanos-gaming",
        prompt: "Retry later?"
      })
    ).rejects.toThrow("Backend /gpt/arcanos-gaming failed with HTTP 503: backend unavailable");
  });

  it("preserves backend HTTP status details when the error body is empty", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 502
      })
    );

    await expect(
      invokeGptRoute({
        baseUrl: "http://127.0.0.1:3000",
        gptId: "arcanos-gaming",
        prompt: "Retry later?"
      })
    ).rejects.toThrow("Backend /gpt/arcanos-gaming failed with HTTP 502: <empty response body>");
  });

  it("truncates oversized non-JSON backend error bodies", async () => {
    const largeBody = "x".repeat(1105);
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(largeBody, {
        status: 504,
        headers: {
          "content-type": "text/html"
        }
      })
    );

    await expect(
      invokeGptRoute({
        baseUrl: "http://127.0.0.1:3000",
        gptId: "arcanos-gaming",
        prompt: "Retry later?"
      })
    ).rejects.toThrow(
      `Backend /gpt/arcanos-gaming failed with HTTP 504: ${"x".repeat(1000)}\n[truncated]`
    );
  });

  it("explains invalid success payloads when the backend returns non-JSON content", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream HTML error page", {
        status: 200,
        headers: {
          "content-type": "text/html"
        }
      })
    );

    await expect(
      invokeGptRoute({
        baseUrl: "http://127.0.0.1:3000",
        gptId: "arcanos-gaming",
        prompt: "Retry later?"
      })
    ).rejects.toThrow(
      "Backend returned a non-JSON or non-object JSON payload: upstream HTML error page"
    );
  });
});
