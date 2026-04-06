import { jest } from "@jest/globals";

import {
  createProtocolRequest,
  type ExecStartResponseData,
  type DaemonCapabilitiesResponseData
} from "@arcanos/protocol";

import { createLocalProtocolDispatcher } from "../src/dispatcher.js";

describe("local protocol dispatcher", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("advertises only locally supported registry tools", async () => {
    const dispatcher = createLocalProtocolDispatcher({
      now: () => new Date("2026-04-06T00:00:00.000Z"),
      cwd: () => "/workspace/arcanos",
      platform: "linux"
    });

    const response = await dispatcher.dispatch(
      createProtocolRequest({
        requestId: "req-tool-registry",
        command: "tool.registry",
        payload: {},
        context: {}
      })
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ id: "context.inspect" }),
        expect.objectContaining({ id: "tool.registry" }),
        expect.objectContaining({ id: "exec.start" }),
        expect.objectContaining({ id: "exec.resume" }),
        expect.objectContaining({ id: "exec.status" })
      ])
    });

    const toolIds = ((response.data as { tools: Array<{ id: string }> }).tools).map((tool) => tool.id);
    expect(toolIds).not.toContain("tool.describe");
    expect(toolIds).not.toContain("tool.invoke");
  });

  it("uses the platform shell fallback for linux context inspection", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";

    try {
      const dispatcher = createLocalProtocolDispatcher({
        now: () => new Date("2026-04-06T00:00:00.000Z"),
        cwd: () => "/workspace/arcanos",
        platform: "linux"
      });

      const response = await dispatcher.dispatch(
        createProtocolRequest({
          requestId: "req-context-inspect",
          command: "context.inspect",
          payload: {
            includeAvailableEnvironments: true
          },
          context: {}
        })
      );

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        environment: {
          shell: "/bin/zsh"
        },
        availableEnvironments: expect.arrayContaining([
          expect.objectContaining({
            type: "workspace",
            shell: "/bin/zsh"
          })
        ])
      });
    } finally {
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
    }
  });

  it("reports a truthful local capability surface", async () => {
    const dispatcher = createLocalProtocolDispatcher({
      now: () => new Date("2026-04-06T00:00:00.000Z"),
      cwd: () => "/workspace/arcanos",
      platform: "linux"
    });

    const response = await dispatcher.dispatch(
      createProtocolRequest({
        requestId: "req-local-capabilities",
        command: "daemon.capabilities",
        payload: {},
        context: {}
      })
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      protocolVersion: "arcanos-v1",
      runtimeVersion: "0.1.0",
      schemaRoot: "embedded://packages/protocol/schemas/v1"
    });

    const capabilities = response.data as DaemonCapabilitiesResponseData;
    expect(capabilities.supportedCommands).toEqual([
      "context.inspect",
      "daemon.capabilities",
      "exec.resume",
      "exec.start",
      "exec.status",
      "tool.registry"
    ]);
    expect(capabilities.toolCount).toBe(6);
  });

  it("keeps local capabilities and registry ids in lockstep", async () => {
    const dispatcher = createLocalProtocolDispatcher({
      now: () => new Date("2026-04-06T00:00:00.000Z"),
      cwd: () => "/workspace/arcanos",
      platform: "linux"
    });

    const [capabilitiesResponse, registryResponse] = await Promise.all([
      dispatcher.dispatch(
        createProtocolRequest({
          requestId: "req-local-capabilities-sync",
          command: "daemon.capabilities",
          payload: {},
          context: {}
        })
      ),
      dispatcher.dispatch(
        createProtocolRequest({
          requestId: "req-local-registry-sync",
          command: "tool.registry",
          payload: {},
          context: {}
        })
      )
    ]);

    expect(capabilitiesResponse.ok).toBe(true);
    expect(registryResponse.ok).toBe(true);

    const capabilities = capabilitiesResponse.data as DaemonCapabilitiesResponseData;
    const registryToolIds = (registryResponse.data as { tools: Array<{ id: string }> }).tools.map((tool) => tool.id);

    expect(capabilities.supportedCommands).toEqual(registryToolIds);
    expect(capabilities.toolCount).toBe(registryToolIds.length);
    expect(new Set(capabilities.supportedCommands).size).toBe(capabilities.supportedCommands.length);
    expect(new Set(registryToolIds).size).toBe(registryToolIds.length);
  });

  it("successfully dispatches every advertised local command", async () => {
    const dispatcher = createLocalProtocolDispatcher({
      now: () => new Date("2026-04-06T00:00:00.000Z"),
      cwd: () => "/workspace/arcanos",
      platform: "linux"
    });

    const capabilitiesResponse = await dispatcher.dispatch(
      createProtocolRequest({
        requestId: "req-local-capabilities-coverage",
        command: "daemon.capabilities",
        payload: {},
        context: {}
      })
    );

    expect(capabilitiesResponse.ok).toBe(true);
    const capabilities = capabilitiesResponse.data as DaemonCapabilitiesResponseData;

    const execStartResponse = await dispatcher.dispatch(
      createProtocolRequest({
        requestId: "req-local-exec-start",
        command: "exec.start",
        payload: {
          task: {
            id: "task-local-1",
            command: "task.create",
            payload: {},
            context: {}
          }
        },
        context: {}
      })
    );

    expect(execStartResponse.ok).toBe(true);
    const executionId = (execStartResponse.data as ExecStartResponseData).state.executionId;

    const requestsByCommand = new Map<string, ReturnType<typeof createProtocolRequest>>([
      ["context.inspect", createProtocolRequest({
        requestId: "req-local-context-inspect",
        command: "context.inspect",
        payload: {},
        context: {}
      })],
      ["daemon.capabilities", createProtocolRequest({
        requestId: "req-local-capabilities-repeat",
        command: "daemon.capabilities",
        payload: {},
        context: {}
      })],
      ["exec.resume", createProtocolRequest({
        requestId: "req-local-exec-resume",
        command: "exec.resume",
        payload: {
          executionId,
          status: "completed"
        },
        context: {}
      })],
      ["exec.start", createProtocolRequest({
        requestId: "req-local-exec-start-repeat",
        command: "exec.start",
        payload: {
          task: {
            id: "task-local-2",
            command: "task.create",
            payload: {},
            context: {}
          }
        },
        context: {}
      })],
      ["exec.status", createProtocolRequest({
        requestId: "req-local-exec-status",
        command: "exec.status",
        payload: {
          executionId
        },
        context: {}
      })],
      ["tool.registry", createProtocolRequest({
        requestId: "req-local-tool-registry-repeat",
        command: "tool.registry",
        payload: {},
        context: {}
      })]
    ]);

    for (const command of capabilities.supportedCommands) {
      const request = requestsByCommand.get(command);
      expect(request).toBeDefined();

      const response = await dispatcher.dispatch(request as ReturnType<typeof createProtocolRequest>);
      expect(response.ok).toBe(true);
    }
  });
});
