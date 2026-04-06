import { createHash } from "node:crypto";

import {
  ARCANOS_PROTOCOL_COMMAND_IDS,
  assertValidProtocolRequest,
  createProtocolRequest,
  type ProtocolAuth,
  type ProtocolCommandId,
  type ProtocolRequest,
  type ProtocolResponse
} from "@arcanos/protocol";

import { serializeDeterministicJson } from "./client/protocol.js";
import { dispatchProtocolRequest, type ProtocolTransportName } from "./transport.js";
import { assertTransportSupportsProtocolCommand } from "./transportConstraints.js";

interface ParsedProtocolCliArguments {
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
  transportExplicit?: boolean;
  pythonBinary?: string;
}

export async function runProtocolCli(
  argv: string[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): Promise<number> {
  try {
    const parsedArguments = parseProtocolCliArguments(argv);
    const request = buildProtocolRequestFromCliArguments(parsedArguments);
    const resolvedTransport = parsedArguments.transport ?? "python";
    assertTransportSupportsProtocolCommand(request.command, {
      transport: resolvedTransport,
      transportExplicit: parsedArguments.transportExplicit
    });
    const response = await dispatchProtocolRequest(
      request,
      resolvedTransport,
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

export function parseProtocolCliArguments(argv: string[]): ParsedProtocolCliArguments {
  const parsedArguments: ParsedProtocolCliArguments = {};

  for (let index = 0; index < argv.length; index += 1) {
    const currentArgument = argv[index];

    if (!currentArgument.startsWith("--")) {
      if (!parsedArguments.command) {
        parsedArguments.command = currentArgument;
        continue;
      }

      throw new Error(`Unexpected positional argument "${currentArgument}".`);
    }

    const value = argv[index + 1];
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
        parsedArguments.transportExplicit = true;
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

export function buildProtocolRequestFromCliArguments(
  parsedArguments: ParsedProtocolCliArguments
): ProtocolRequest<unknown> {
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

function buildProtocolAuth(parsedArguments: ParsedProtocolCliArguments): ProtocolAuth | undefined {
  if (!parsedArguments.authStrategy || !parsedArguments.authToken) {
    return undefined;
  }

  const protocolAuth = {
    strategy: parsedArguments.authStrategy,
    ["token"]: parsedArguments.authToken
  } satisfies ProtocolAuth;

  return protocolAuth;
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

function createDeterministicRequestId(
  command: string,
  payload: unknown,
  parsedArguments: ParsedProtocolCliArguments
): string {
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
