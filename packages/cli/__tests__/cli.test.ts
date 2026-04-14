import path from "node:path";
import { Writable } from "node:stream";

import { jest } from "@jest/globals";

import { runCli } from "../src/cli.js";
import { buildTaskCreateRequest } from "../src/client/protocol.js";
import { runProtocolCli } from "../src/protocolCli.js";
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

    expect(
      parseCliInvocation([
        "generate-and-wait",
        "--gpt",
        "arcanos-core",
        "--prompt",
        "Generate a Seth Rollins promo prompt",
        "--timeout-ms",
        "20000",
        "--poll-interval-ms",
        "125"
      ])
    ).toMatchObject({
      kind: "generate-and-wait",
      gptId: "arcanos-core",
      prompt: "Generate a Seth Rollins promo prompt",
      timeoutMs: 20000,
      pollIntervalMs: 125
    });

    expect(parseCliInvocation(["job-status", "job-123", "--json"])).toMatchObject({
      kind: "job-status",
      jobId: "job-123",
      options: {
        json: true
      }
    });

    expect(parseCliInvocation(["job-result", "job-123"])).toMatchObject({
      kind: "job-result",
      jobId: "job-123"
    });

    expect(parseCliInvocation(["doctor", "implementation"])).toMatchObject({
      kind: "doctor",
      subject: "implementation"
    });

    expect(parseCliInvocation(["workers", "--json"])).toMatchObject({
      kind: "workers",
      options: {
        json: true,
      }
    });

    expect(parseCliInvocation(["logs", "--recent"])).toMatchObject({
      kind: "logs",
      recent: true,
    });

    expect(parseCliInvocation(["inspect", "self-heal"])).toMatchObject({
      kind: "inspect",
      subject: "self-heal",
    });
  });

  it("rejects non-integer wait-control flags for generate-and-wait", () => {
    expect(() =>
      parseCliInvocation([
        "generate-and-wait",
        "--gpt",
        "arcanos-core",
        "--prompt",
        "Generate a Seth Rollins promo prompt",
        "--timeout-ms",
        "1.9"
      ])
    ).toThrow('Flag "--timeout-ms" must be a non-negative integer.');

    expect(() =>
      parseCliInvocation([
        "generate-and-wait",
        "--gpt",
        "arcanos-core",
        "--prompt",
        "Generate a Seth Rollins promo prompt",
        "--poll-interval-ms",
        "0.5"
      ])
    ).toThrow('Flag "--poll-interval-ms" must be a positive integer.');
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

  it("sends generate-and-wait requests to the canonical backend GPT route with explicit wait controls", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      createJsonResponse({ ok: true, result: "Generated Seth Rollins prompt" })
    );
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(
      [
        "generate-and-wait",
        "--gpt",
        "arcanos-core",
        "--prompt",
        "Generate a Seth Rollins promo prompt",
        "--timeout-ms",
        "20000",
        "--poll-interval-ms",
        "125",
        "--base-url",
        "http://127.0.0.1:3000"
      ],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain("Generated Seth Rollins prompt");
    expect(stderr.read()).toBe("");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/gpt/arcanos-core", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "Generate a Seth Rollins promo prompt",
          executionMode: "async",
          waitForResultMs: 20000,
          pollIntervalMs: 125
        })
      })
    );
  });

  it("routes explicit job control commands to the canonical jobs endpoints", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const pathname = url instanceof URL ? url.pathname : String(url);
      if (pathname.endsWith("/jobs/job-123")) {
        return createJsonResponse({ id: "job-123", status: "completed" });
      }
      if (pathname.endsWith("/jobs/job-123/result")) {
        return createJsonResponse({ status: "completed", result: "final output" });
      }
      throw new Error(`Unexpected URL: ${pathname}`);
    });

    const statusStdout = createWritableCapture();
    const statusStderr = createWritableCapture();
    const statusExitCode = await runCli(
      ["job-status", "job-123", "--base-url", "http://127.0.0.1:3000"],
      statusStdout.stream,
      statusStderr.stream
    );

    expect(statusExitCode).toBe(0);
    expect(statusStdout.read()).toContain("Job job-123: completed");
    expect(statusStderr.read()).toBe("");

    const resultStdout = createWritableCapture();
    const resultStderr = createWritableCapture();
    const resultExitCode = await runCli(
      ["job-result", "job-123", "--base-url", "http://127.0.0.1:3000"],
      resultStdout.stream,
      resultStderr.stream
    );

    expect(resultExitCode).toBe(0);
    expect(resultStdout.read()).toContain("final output");
    expect(resultStderr.read()).toBe("");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/jobs/job-123", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        headers: {}
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/jobs/job-123/result", "http://127.0.0.1:3000/"),
      expect.objectContaining({
        headers: {}
      })
    );
  });

  it("queries runtime routes for workers and self-heal inspection commands", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const pathname = url instanceof URL ? url.pathname : String(url);
      if (pathname.endsWith("/workers/status")) {
        return createJsonResponse({ totalWorkers: 2 });
      }
      if (pathname.endsWith("/worker-helper/health")) {
        return createJsonResponse({ overallStatus: "healthy" });
      }
      if (pathname.endsWith("/status/safety/self-heal")) {
        return createJsonResponse({ status: "ok", lastHealResult: "success" });
      }
      if (pathname.includes("/api/self-heal/events")) {
        return createJsonResponse({ count: 1, events: [{ id: "evt-1" }] });
      }
      throw new Error(`Unexpected URL: ${pathname}`);
    });

    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const workersExitCode = await runCli(
      ["workers", "--json", "--base-url", "http://127.0.0.1:3000"],
      stdout.stream,
      stderr.stream
    );

    expect(workersExitCode).toBe(0);
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: true,
      data: {
        command: "workers",
        response: {
          ok: true,
          data: {
            workers: { totalWorkers: 2 },
            health: { overallStatus: "healthy" },
          }
        }
      }
    });

    const inspectStdout = createWritableCapture();
    const inspectExitCode = await runCli(
      ["inspect", "self-heal", "--json", "--base-url", "http://127.0.0.1:3000"],
      inspectStdout.stream,
      stderr.stream
    );
    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectStdout.read())).toMatchObject({
      ok: true,
      data: {
        command: "inspect",
        response: {
          ok: true,
          data: {
            status: "ok",
            lastHealResult: "success",
          }
        }
      }
    });

    const logsStdout = createWritableCapture();
    const logsExitCode = await runCli(
      ["logs", "--recent", "--json", "--base-url", "http://127.0.0.1:3000"],
      logsStdout.stream,
      stderr.stream
    );
    expect(logsExitCode).toBe(0);
    expect(JSON.parse(logsStdout.read())).toMatchObject({
      ok: true,
      data: {
        command: "logs",
        response: {
          ok: true,
          data: {
            source: "runtime-events",
            events: {
              count: 1,
            }
          }
        }
      }
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("prints a friendly human error for doctor implementation on explicit local transport", async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(
      ["doctor", "implementation", "--transport", "local"],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("doctor implementation requires the python transport");
    expect(stderr.read()).toContain("--transport python");
  });

  it("prints a friendly human error for CLI parse failures", async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runCli(
      ["doctor"],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Supported doctor command");
    expect(stderr.read().trim().startsWith("{")).toBe(false);
  });

  it("returns a structured protocol error for explicit local tool.invoke requests", async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runProtocolCli(
      [
        "tool.invoke",
        "--payload-json",
        "{\"toolId\":\"doctor.implementation\",\"input\":{}}",
        "--transport",
        "local"
      ],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(JSON.parse(stderr.read())).toMatchObject({
      ok: false,
      error: {
        code: "cli_validation_error",
        message: expect.stringContaining("Protocol command \"tool.invoke\" requires the python transport")
      }
    });
  });

  it("returns a structured protocol error for explicit local tool.describe requests", async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();

    const exitCode = await runProtocolCli(
      [
        "tool.describe",
        "--payload-json",
        "{\"toolId\":\"repo.readFile\"}",
        "--transport",
        "local"
      ],
      stdout.stream,
      stderr.stream
    );

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(JSON.parse(stderr.read())).toMatchObject({
      ok: false,
      error: {
        code: "cli_validation_error",
        message: expect.stringContaining("Protocol command \"tool.describe\" requires the python transport")
      }
    });
  });
});
