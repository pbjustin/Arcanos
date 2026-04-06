import { jest } from "@jest/globals";

import {
  createProtocolRequest,
  type DaemonCapabilitiesResponseData,
  type ToolRegistryResponseData
} from "@arcanos/protocol";

import { dispatchProtocolRequest } from "../src/transport.js";

const PYTHON_BINARY = process.env.PYTHON ?? "python";
const IS_CI = Boolean(process.env.CI);

function createRequest(
  requestId: string,
  command: "daemon.capabilities" | "tool.registry" | "tool.describe" | "tool.invoke",
  payload: Record<string, unknown> = {},
  context: Record<string, unknown> = {}
) {
  return createProtocolRequest({
    requestId,
    command,
    payload,
    context
  });
}

describe("protocol transport matrix", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps local capabilities explicit and reserves tool describe/invoke for python transport", async () => {
    const [localCapabilitiesResponse, localRegistryResponse] = await Promise.all([
      dispatchProtocolRequest(
        createRequest("req-local-capabilities", "daemon.capabilities"),
        "local",
        {}
      ),
      dispatchProtocolRequest(
        createRequest("req-local-registry", "tool.registry"),
        "local",
        {}
      )
    ]);

    const pythonCapabilitiesResponse = await dispatchPythonRequestOrSkip(
      createRequest("req-python-capabilities", "daemon.capabilities")
    );
    if (!pythonCapabilitiesResponse) {
      return;
    }

    const pythonRegistryResponse = await dispatchPythonRequestOrSkip(
      createRequest("req-python-registry", "tool.registry")
    );
    if (!pythonRegistryResponse) {
      return;
    }

    expect(localCapabilitiesResponse.ok).toBe(true);
    expect(pythonCapabilitiesResponse.ok).toBe(true);
    expect(localRegistryResponse.ok).toBe(true);
    expect(pythonRegistryResponse.ok).toBe(true);

    const localCapabilities = localCapabilitiesResponse.data as DaemonCapabilitiesResponseData;
    const pythonCapabilities = pythonCapabilitiesResponse.data as DaemonCapabilitiesResponseData;
    const localRegistry = localRegistryResponse.data as ToolRegistryResponseData;
    const pythonRegistry = pythonRegistryResponse.data as ToolRegistryResponseData;

    expect(localCapabilities.supportedCommands).toEqual([
      "context.inspect",
      "daemon.capabilities",
      "exec.resume",
      "exec.start",
      "exec.status",
      "tool.registry"
    ]);
    expect(localCapabilities.supportedCommands).not.toContain("tool.describe");
    expect(localCapabilities.supportedCommands).not.toContain("tool.invoke");
    expect(localCapabilities.schemaRoot).toBe("embedded://packages/protocol/schemas/v1");

    expect(pythonCapabilities.supportedCommands).toEqual(
      expect.arrayContaining([
        "artifact.store",
        "context.inspect",
        "daemon.capabilities",
        "exec.resume",
        "exec.start",
        "exec.status",
        "state.snapshot",
        "tool.describe",
        "tool.invoke",
        "tool.registry"
      ])
    );

    const localToolIds = localRegistry.tools.map((tool) => tool.id).sort();
    const pythonToolIds = pythonRegistry.tools.map((tool) => tool.id).sort();

    expect(localToolIds).toEqual([
      "context.inspect",
      "daemon.capabilities",
      "exec.resume",
      "exec.start",
      "exec.status",
      "tool.registry"
    ]);
    expect(pythonToolIds).toEqual(
      expect.arrayContaining([
        "daemon.capabilities",
        "doctor.implementation",
        "repo.getDiff",
        "repo.getLog",
        "repo.getStatus",
        "repo.list",
        "repo.listTree",
        "repo.readFile",
        "repo.read_file",
        "repo.search",
        "tool.describe",
        "tool.invoke"
      ])
    );
  });

  it("returns deterministic unsupported errors for local tool describe/invoke requests", async () => {
    const [toolDescribeResponse, toolInvokeResponse] = await Promise.all([
      dispatchProtocolRequest(
        createRequest("req-local-tool-describe", "tool.describe", {
          toolId: "repo.readFile"
        }),
        "local",
        {}
      ),
      dispatchProtocolRequest(
        createRequest(
          "req-local-tool-invoke",
          "tool.invoke",
          {
            toolId: "doctor.implementation",
            input: {}
          },
          {
            environment: "workspace",
            cwd: process.cwd(),
            caller: {
              id: "jest",
              type: "cli",
              scopes: ["repo:read", "tools:invoke"]
            }
          }
        ),
        "local",
        {}
      )
    ]);

    expect(toolDescribeResponse).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_command"
      }
    });
    expect(toolInvokeResponse).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_command"
      }
    });
  });
});

async function dispatchPythonRequestOrSkip(request: ReturnType<typeof createRequest>) {
  try {
    return await dispatchProtocolRequest(
      request,
      "python",
      { pythonBinary: PYTHON_BINARY }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!IS_CI && isMissingPythonRuntimeDependency(message)) {
      console.warn(`Skipping python transport matrix assertions: ${message}`);
      return null;
    }

    throw error;
  }
}

function isMissingPythonRuntimeDependency(message: string): boolean {
  return message.includes("ModuleNotFoundError")
    || message.includes("No module named");
}
