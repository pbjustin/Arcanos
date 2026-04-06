import type { ProtocolCommandId } from "@arcanos/protocol";

export interface TransportConstraintOptions {
  transport: "local" | "python";
  transportExplicit?: boolean;
}

const PYTHON_ONLY_PROTOCOL_COMMANDS = new Set<ProtocolCommandId>([
  "tool.describe",
  "tool.invoke"
]);

export function assertTransportSupportsProtocolCommand(
  command: ProtocolCommandId,
  options: TransportConstraintOptions
): void {
  if (
    options.transport === "local"
    && options.transportExplicit
    && PYTHON_ONLY_PROTOCOL_COMMANDS.has(command)
  ) {
    throw new Error(buildPythonOnlyTransportMessage(`Protocol command "${command}"`));
  }
}

export function assertTransportSupportsDoctorImplementation(
  options: TransportConstraintOptions
): void {
  if (options.transport === "local" && options.transportExplicit) {
    throw new Error(buildPythonOnlyTransportMessage("doctor implementation"));
  }
}

function buildPythonOnlyTransportMessage(operationLabel: string): string {
  return `${operationLabel} requires the python transport because the local dispatcher intentionally omits python-only schema introspection and repo tool execution. Remove --transport local or rerun with --transport python.`;
}
