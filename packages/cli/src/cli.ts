import { runAskCommand } from "./commands/ask.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runExecCommand } from "./commands/exec.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runLogsCommand } from "./commands/logs.js";
import { parseCliInvocation, renderUsage } from "./commands/parse.js";
import { runPlanCommand } from "./commands/plan.js";
import { runStatusCommand } from "./commands/status.js";
import { runWorkersCommand } from "./commands/workers.js";
import type { CliJsonEnvelope, CliProtocolCommandResult } from "./commands/types.js";
import { serializeDeterministicJson } from "./client/protocol.js";
import { runProtocolCli } from "./protocolCli.js";

export async function runCli(
  argv: string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): Promise<number> {
  let invocation: ReturnType<typeof parseCliInvocation> | undefined;

  try {
    invocation = parseCliInvocation(argv);

    if (invocation.kind === "help") {
      stdout.write(`${renderUsage()}\n`);
      return 0;
    }

    if (invocation.kind === "protocol") {
      return runProtocolCli(invocation.argv, stdout, stderr);
    }

    const result = await runCommand(invocation);
    if (invocation.options.json) {
      stdout.write(`${serializeDeterministicJson(toJsonEnvelope(result))}\n`);
    } else {
      stdout.write(`${result.humanOutput}\n`);
    }

    return result.response.ok ? 0 : 1;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown CLI failure.";
    const failureEnvelope: CliJsonEnvelope<never> = {
      ok: false,
      error: {
        code: "cli_error",
        message: errorMessage
      }
    };

    if (shouldRenderHumanError(invocation)) {
      stderr.write(`${errorMessage}\n`);
    } else {
      stderr.write(`${serializeDeterministicJson(failureEnvelope)}\n`);
    }
    return 1;
  }
}

async function runCommand(invocation: Exclude<ReturnType<typeof parseCliInvocation>, { kind: "help" | "protocol" }>) {
  switch (invocation.kind) {
    case "ask":
      return runAskCommand(invocation);
    case "plan":
      return runPlanCommand(invocation);
    case "exec":
      return runExecCommand(invocation);
    case "status":
      return runStatusCommand(invocation);
    case "workers":
      return runWorkersCommand(invocation);
    case "logs":
      return runLogsCommand(invocation);
    case "inspect":
      return runInspectCommand(invocation);
    case "doctor":
      return runDoctorCommand(invocation);
  }
}

function toJsonEnvelope(result: CliProtocolCommandResult<unknown>): CliJsonEnvelope<Record<string, unknown>> {
  return {
    ok: result.response.ok,
    data: {
      command: result.command,
      request: result.request,
      response: result.response,
      ...(result.extraJson ?? {})
    }
  };
}

function shouldRenderHumanError(
  invocation: ReturnType<typeof parseCliInvocation> | undefined
): boolean {
  if (!invocation) {
    return false;
  }

  return invocation.kind !== "help"
    && invocation.kind !== "protocol"
    && invocation.options.json !== true;
}
