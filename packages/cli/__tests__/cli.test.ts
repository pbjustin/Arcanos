import path from "node:path";
import { Writable } from "node:stream";

import { jest } from "@jest/globals";

import { runCli } from "../src/cli.js";
import { buildTaskCreateRequest } from "../src/client/protocol.js";
import { parseCliInvocation } from "../src/commands/parse.js";

function createWritableCapture() {
  let buffer = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    }
  });

  return {
    stream,
    read: () => buffer
  };
}

function createJsonResponse(payload: Record<string, unknown>, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

describe("Arcanos CLI", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("parses the supported command surface", () => {
    expect(parseCliInvocation(["ask", "test", "--json"])).toMatchObject({
      kind: "ask",
      prompt: "test",
      options: {
        json: true
      }
    });

    expect(parseCliInvocation(["doctor", "implementation"])).toMatchObject({
      kind: "doctor",
      subject: "implementation"
    });
  });

  it("builds a validated task.create request payload", () => {
    const request = buildTaskCreateRequest("add auth", {
      json: false,
      baseUrl: "http://127.0.0.1:3000",
      cwd: path.resolve("tmp", "arcanos-test"),
      shell: "powershell",
      transport: "python",
      sessionId: "session-1",
      projectId: "project-1"
    });

    expect(request.command).toBe("task.create");
    expect(request.payload).toEqual({ prompt: "add auth" });
    expect(request.context).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1"
    });
  });

  it("emits deterministic JSON output for ask", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ result: "planned answer" })
    );
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(
      ["ask", "test", "--json", "--base-url", "http://127.0.0.1:3000"],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: true,
      data: {
        command: "task.create",
        response: {
          ok: true,
          data: {
            backendResponse: {
              result: "planned answer"
            }
          }
        }
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends ask requests to the canonical backend GPT route", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ result: "backend ok" })
    );
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(
      ["ask", "ship it", "--base-url", "http://127.0.0.1:3000"],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("backend ok");
    expect(stderr.read()).toBe("");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/gpt/arcanos-daemon", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("\"prompt\":\"ship it\"")
      })
    );
  });
});
