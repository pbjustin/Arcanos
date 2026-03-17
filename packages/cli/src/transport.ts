import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidProtocolResponse,
  isImplementedProtocolCommandId,
  type ProtocolRequest,
  type ProtocolResponse
} from "../../protocol/dist/src/index.js";

import { createLocalProtocolDispatcher } from "./dispatcher.js";

export type ProtocolTransportName = "local" | "python";

export interface ProtocolTransportOptions {
  pythonBinary?: string;
}

/**
 * Dispatches a protocol request over the selected transport.
 * Inputs: protocol request, transport name, and transport options.
 * Outputs: validated protocol response.
 * Edge cases: python transport failures are surfaced as deterministic errors rather than raw stderr strings.
 */
export async function dispatchProtocolRequest(
  request: ProtocolRequest<unknown>,
  transportName: ProtocolTransportName,
  options: ProtocolTransportOptions
): Promise<ProtocolResponse<unknown>> {
  const response = transportName === "local"
    ? await dispatchLocally(request)
    : await dispatchViaPythonRuntime(request, options);

  return isImplementedProtocolCommandId(request.command)
    ? assertValidProtocolResponse(request.command, response)
    : response;
}

async function dispatchLocally(request: ProtocolRequest<unknown>): Promise<ProtocolResponse<unknown>> {
  const dispatcher = createLocalProtocolDispatcher({
    now: () => new Date(),
    cwd: () => process.cwd(),
    platform: process.platform
  });
  return dispatcher.dispatch(request);
}

async function dispatchViaPythonRuntime(
  request: ProtocolRequest<unknown>,
  options: ProtocolTransportOptions
): Promise<ProtocolResponse<unknown>> {
  const daemonWorkingDirectory = path.join(resolveRepositoryRoot(), "daemon-python");
  const pythonBinary = options.pythonBinary ?? process.env.PYTHON ?? "python";

  return new Promise<ProtocolResponse<unknown>>((resolve, reject) => {
    const childProcess = spawn(
      pythonBinary,
      ["-m", "arcanos.protocol_runtime"],
      {
        cwd: daemonWorkingDirectory,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";

    childProcess.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
    });

    childProcess.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    childProcess.on("error", (error) => {
      reject(new Error(`Python transport failed to start: ${error.message}`));
    });

    childProcess.on("close", (exitCode) => {
      const trimmedOutput = stdoutBuffer.trim();

      //audit assumption: python transport must return exactly one JSON payload on stdout. failure risk: mixed stdout/stderr output would break deterministic parsing. invariant: stdout contains a parseable protocol response or the transport fails. handling: reject malformed responses with stderr context.
      if (!trimmedOutput) {
        reject(
          new Error(
            `Python transport returned no JSON output. Exit code: ${exitCode ?? "unknown"}. ${stderrBuffer.trim()}`
          )
        );
        return;
      }

      try {
        resolve(JSON.parse(trimmedOutput) as ProtocolResponse<unknown>);
      } catch (error) {
        reject(
          new Error(
            error instanceof Error
              ? `Python transport returned invalid JSON: ${error.message}. ${stderrBuffer.trim()}`
              : "Python transport returned invalid JSON."
          )
        );
      }
    });

    childProcess.stdin.write(JSON.stringify(request));
    childProcess.stdin.end();
  });
}

function resolveRepositoryRoot(): string {
  let currentPath = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    //audit assumption: repository discovery must follow stable project markers instead of fixed directory jumps. failure risk: moving the CLI entrypoint would silently break python transport resolution. invariant: the first ancestor with a repository marker becomes the root. handling: walk upward until a marker is found or throw deterministically.
    if (isRepositoryRoot(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error("Unable to resolve the repository root for the python transport.");
    }
    currentPath = parentPath;
  }
}

function isRepositoryRoot(candidatePath: string): boolean {
  return (
    existsSync(path.join(candidatePath, ".git"))
    || existsSync(path.join(candidatePath, "daemon-python"))
  );
}
