import { readFileSync } from "node:fs";
import path from "node:path";

import { jest } from "@jest/globals";

import { invokeGptRoute } from "../src/client/backend.js";

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

    await invokeGptRoute({
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
        type: "object",
        additionalProperties: false,
      })
    );
    expect(requestSchema?.properties?.prompt).toBeDefined();
    expect(requestSchema?.required ?? []).not.toContain("action");
    expect(requestSchema?.properties?.gptId).toBeUndefined();
    expect(requestSchema?.not?.required).toContain("gptId");
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
});
