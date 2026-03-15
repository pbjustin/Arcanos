import { createHash } from "node:crypto";

import {
  ARCANOS_PROTOCOL_COMMAND_IDS,
  assertValidProtocolRequest,
  createProtocolRequest,
  type ProtocolCommandId,
  type ProtocolAuth,
  type ProtocolRequest,
  type ProtocolResponse
} from "../../protocol/dist/src/index.js";

import { dispatchProtocolRequest, type ProtocolTransportName } from "./transport.js";

interface ParsedCliArguments {
  command?: string;
  payloadJson?: string;
  requestId?: string;
  sessionId?: string;
  projectId?: string;
  environment?: string;
  cwd?: string;
  shell?: string;
  authStrategy?: string;
  authToken?: string;
  transport?: ProtocolTransportName;
  pythonBinary?: string;
}

/**
 * Runs the protocol CLI entrypoint.
 * Inputs: argv tokens plus writable stdout and stderr streams.
 * Outputs: process-style exit code.
 * Edge cases: validation and usage failures still emit protocol-shaped JSON so automation surfaces stay deterministic.
 */
export async function runCli(argv: string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): Promise<number> {
  try {
    const parsedArguments = parseCliArguments(argv);
    const request = buildProtocolRequestFromCliArguments(parsedArguments);
    const response = await dispatchProtocolRequest(
      request,
      parsedArguments.transport ?? "python",
      { pythonBinary: parsedArguments.pythonBinary }
    );

    stdout.write(`${serializeDeterministicJson(response)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    const failureResponse: ProtocolResponse<never> = {
      protocol: "arcanos-v1",
      requestId: "cli-error",
      ok: false,
      error: {
        code: "cli_validation_error",
        message: error instanceof Error ? error.message : "Unknown CLI failure.",
        retryable: false
      },
      meta: {
        version: "0.1.0",
        executedBy: "local-cli"
      }
    };

    stderr.write(`${serializeDeterministicJson(failureResponse)}\n`);
    return 1;
  }
}

/**
 * Parses CLI flags into a stable intermediate representation.
 * Inputs: raw argv tokens after the executable name.
 * Outputs: parsed command name and supported options.
 * Edge cases: unknown flags and missing values throw deterministic usage errors instead of being ignored.
 */
export function parseCliArguments(argv: string[]): ParsedCliArguments {
  const parsedArguments: ParsedCliArguments = {};

  for (let index = 0; index < argv.length; index += 1) {
    const currentArgument = argv[index];

    //audit assumption: the first non-flag token is the command identifier. failure risk: later parsing could reinterpret payload values as commands. invariant: command is assigned once from the first positional token. handling: capture the first positional token and continue parsing flags normally.
    if (!currentArgument.startsWith("--")) {
      if (!parsedArguments.command) {
        parsedArguments.command = currentArgument;
        continue;
      }

      throw new Error(`Unexpected positional argument "${currentArgument}".`);
    }

    const value = argv[index + 1];

    //audit assumption: every supported flag requires an explicit value. failure risk: partial argument pairs would shift later parsing and corrupt requests. invariant: flagged options always read a following token. handling: reject flags without values before continuing.
    if (!value) {
      throw new Error(`Flag "${currentArgument}" requires a value.`);
    }

    switch (currentArgument) {
      case "--payload-json":
        parsedArguments.payloadJson = value;
        break;
      case "--request-id":
        parsedArguments.requestId = value;
        break;
      case "--session-id":
        parsedArguments.sessionId = value;
        break;
      case "--project-id":
        parsedArguments.projectId = value;
        break;
      case "--environment":
        parsedArguments.environment = value;
        break;
      case "--cwd":
        parsedArguments.cwd = value;
        break;
      case "--shell":
        parsedArguments.shell = value;
        break;
      case "--auth-strategy":
        parsedArguments.authStrategy = value;
        break;
      case "--auth-token":
        parsedArguments.authToken = value;
        break;
      case "--transport":
        if (value !== "local" && value !== "python") {
          throw new Error('Flag "--transport" must be "local" or "python".');
        }
        parsedArguments.transport = value;
        break;
      case "--python-bin":
        parsedArguments.pythonBinary = value;
        break;
      default:
        throw new Error(`Unknown flag "${currentArgument}".`);
    }

    index += 1;
  }

  return parsedArguments;
}

/**
 * Builds and validates a protocol request from parsed CLI arguments.
 * Inputs: parsed CLI argument object.
 * Outputs: validated protocol request envelope.
 * Edge cases: missing commands, invalid JSON payloads, and unsupported command identifiers fail before dispatch.
 */
export function buildProtocolRequestFromCliArguments(parsedArguments: ParsedCliArguments): ProtocolRequest<unknown> {
  if (!parsedArguments.command) {
    throw new Error("A protocol command is required.");
  }

  if (!(ARCANOS_PROTOCOL_COMMAND_IDS as readonly string[]).includes(parsedArguments.command)) {
    throw new Error(`Unsupported protocol command "${parsedArguments.command}".`);
  }

  const payload = parsePayloadJson(parsedArguments.payloadJson);
  const request = createProtocolRequest({
    requestId: parsedArguments.requestId ?? createDeterministicRequestId(parsedArguments.command, payload, parsedArguments),
    command: parsedArguments.command as ProtocolCommandId,
    auth: buildProtocolAuth(parsedArguments),
    context: {
      sessionId: parsedArguments.sessionId,
      projectId: parsedArguments.projectId,
      environment: parsedArguments.environment,
      cwd: parsedArguments.cwd,
      shell: parsedArguments.shell
    },
    payload
  });

  return assertValidProtocolRequest(request);
}

/**
 * Serializes JSON with a deterministic key order.
 * Inputs: any JSON-serializable value.
 * Outputs: stable JSON string.
 * Edge cases: arrays preserve order while object keys are sorted recursively for reproducible output.
 */
export function serializeDeterministicJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function buildProtocolAuth(parsedArguments: ParsedCliArguments): ProtocolAuth | undefined {
  //audit assumption: auth is only valid when both strategy and secret material are present. failure risk: half-configured auth objects would drift from the shared schema. invariant: auth is either fully populated or omitted. handling: return undefined until both fields exist.
  if (!parsedArguments.authStrategy || !parsedArguments.authToken) {
    return undefined;
  }

  const protocolAuth = {
    strategy: parsedArguments.authStrategy
  } as Record<string, string>;
  protocolAuth["token"] = parsedArguments.authToken;
  return protocolAuth as unknown as ProtocolAuth;
}

function parsePayloadJson(payloadJson: string | undefined): unknown {
  if (!payloadJson) {
    return {};
  }

  try {
    return JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Invalid JSON passed to --payload-json: ${error.message}` : "Invalid JSON passed to --payload-json."
    );
  }
}

function createDeterministicRequestId(command: string, payload: unknown, parsedArguments: ParsedCliArguments): string {
  const hash = createHash("sha1")
    .update(
      serializeDeterministicJson({
        command,
        payload,
        context: {
          sessionId: parsedArguments.sessionId,
          projectId: parsedArguments.projectId,
          environment: parsedArguments.environment,
          cwd: parsedArguments.cwd,
          shell: parsedArguments.shell
        }
      })
    )
    .digest("hex")
    .slice(0, 12);

  return `req-${hash}`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey, sortJsonValue(entryValue)]));
  }

  return value;
}
