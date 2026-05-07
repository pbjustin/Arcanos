import path from "node:path";

import {
  DEFAULT_CLI_POLICY,
  buildCliPolicyAuditEvent,
  evaluateCliCommandPolicy,
  redactCliEnv,
  redactCliOutput,
  resolveCliTimeoutMs
} from "../src/security/cliPolicy.js";

describe("CLI security policy helpers", () => {
  const workspaceRoot = path.resolve(process.cwd(), "test-workspace");

  it.each([
    "rm -rf /",
    "Remove-Item C:\\important -Recurse -Force",
    "reg delete HKCU\\Software\\Arcanos /f",
    "shutdown /s /t 0"
  ])("denies dangerous command %s", (command) => {
    const decision = evaluateCliCommandPolicy({
      command,
      workspaceRoot
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "command_denied_by_policy"
    });
    expect(decision.matchedPattern).toBeDefined();
  });

  it("denies cwd outside the workspace sandbox", () => {
    const decision = evaluateCliCommandPolicy({
      command: "npm test",
      cwd: "..",
      workspaceRoot
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "cwd_outside_workspace"
    });
  });

  it("allows safe commands inside the workspace with bounded timeout defaults", () => {
    const decision = evaluateCliCommandPolicy({
      command: "npm run probe",
      cwd: "packages/cli",
      workspaceRoot,
      timeoutMs: 999999
    });

    expect(decision).toMatchObject({
      allowed: true,
      cwd: path.resolve(workspaceRoot, "packages/cli"),
      timeoutMs: DEFAULT_CLI_POLICY.timeoutPolicy.maxMs
    });
  });

  it("redacts sensitive env and output while truncating long strings", () => {
    const policy = {
      ...DEFAULT_CLI_POLICY,
      outputPolicy: {
        maxChars: 60,
        truncationMarker: "\n[truncated]"
      }
    };

    expect(redactCliEnv({
      OPENAI_API_KEY: "sk-test-secret-value",
      SAFE_FLAG: "true"
    })).toEqual({
      OPENAI_API_KEY: "[REDACTED]",
      SAFE_FLAG: "true"
    });

    const output = redactCliOutput(
      `OPENAI_API_KEY=sk-test-secret-value Bearer test-token-value-123456 ${"x".repeat(80)}`,
      policy
    );

    expect(output).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(output).toContain("Bearer [REDACTED]");
    expect(output).toContain("[truncated]");
    expect(output).not.toContain("sk-test-secret-value");
    expect(output).not.toContain("test-token-value-123456");
  });

  it("builds deterministic audit event records from policy decisions", () => {
    const decision = evaluateCliCommandPolicy({
      command: "rm -rf /",
      workspaceRoot,
      timeoutMs: undefined
    });
    const event = buildCliPolicyAuditEvent(
      "rm -rf / OPENAI_API_KEY=sk-test-secret-value",
      decision,
      new Date("2026-05-07T12:00:00.000Z")
    );

    expect(event).toEqual({
      event: "cli.command.policy",
      decision: "denied",
      reason: "command_denied_by_policy",
      command: "rm -rf / OPENAI_API_KEY=[REDACTED]",
      cwd: workspaceRoot,
      timeoutMs: resolveCliTimeoutMs(undefined),
      timestamp: "2026-05-07T12:00:00.000Z"
    });
  });
});
