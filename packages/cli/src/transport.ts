import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidProtocolResponse,
  isImplementedProtocolCommandId,
  type ProtocolRequest,
  type ProtocolResponse
} from "@arcanos/protocol";

import { createLocalProtocolDispatcher } from "./dispatcher.js";
import { requestPythonTransportProcessTreeTermination } from "./internal/pythonTransportProcessTree.js";

export type ProtocolTransportName = "local" | "python";

export interface ProtocolTransportOptions {
  pythonBinary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const DEFAULT_PYTHON_TRANSPORT_TIMEOUT_MS = 30_000;
export const MAX_PYTHON_TRANSPORT_TIMEOUT_MS = 120_000;
export const DEFAULT_PYTHON_TRANSPORT_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_PYTHON_TRANSPORT_OUTPUT_BYTES = 8 * 1024 * 1024;

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

const localDispatcher = createLocalProtocolDispatcher({
  now: () => new Date(),
  cwd: () => process.cwd(),
  platform: process.platform
});

async function dispatchLocally(request: ProtocolRequest<unknown>): Promise<ProtocolResponse<unknown>> {
  return localDispatcher.dispatch(request);
}

async function dispatchViaPythonRuntime(
  request: ProtocolRequest<unknown>,
  options: ProtocolTransportOptions
): Promise<ProtocolResponse<unknown>> {
  const timeoutMs = resolveBoundedPositiveInteger(
    "timeoutMs",
    options.timeoutMs,
    DEFAULT_PYTHON_TRANSPORT_TIMEOUT_MS,
    MAX_PYTHON_TRANSPORT_TIMEOUT_MS
  );
  const maxOutputBytes = resolveBoundedPositiveInteger(
    "maxOutputBytes",
    options.maxOutputBytes,
    DEFAULT_PYTHON_TRANSPORT_OUTPUT_BYTES,
    MAX_PYTHON_TRANSPORT_OUTPUT_BYTES
  );
  const repositoryRoot = resolveRepositoryRoot();
  const daemonWorkingDirectory = resolvePythonRuntimeDirectory(repositoryRoot);
  const pythonBinary = options.pythonBinary ?? process.env.PYTHON ?? "python";

  return new Promise<ProtocolResponse<unknown>>((resolve, reject) => {
    let childProcess: ReturnType<typeof spawn>;
    try {
      childProcess = spawn(
        pythonBinary,
        ["-m", "arcanos.protocol_runtime"],
        {
          cwd: daemonWorkingDirectory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
          env: {
            ...process.env,
            ARCANOS_REPOSITORY_ROOT: repositoryRoot,
            ARCANOS_WORKSPACE_ROOT: process.env.ARCANOS_WORKSPACE_ROOT ?? repositoryRoot,
          }
        }
      );
    } catch {
      reject(new Error("Python transport failed to start."));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let retainedOutputBytes = 0;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;

    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };
    const rejectOnce = (error: Error, terminate = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearDeadline();
      reject(error);
      if (terminate) {
        void requestPythonTransportProcessTreeTermination(childProcess)
          .catch(() => undefined);
      }
    };
    const resolveOnce = (response: ProtocolResponse<unknown>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearDeadline();
      resolve(response);
    };
    const retainOutput = (chunk: unknown, destination: Buffer[]): void => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      retainedOutputBytes += buffer.byteLength;
      if (retainedOutputBytes > maxOutputBytes) {
        rejectOnce(
          new Error(`Python transport output exceeded ${maxOutputBytes} bytes.`),
          true
        );
        return;
      }
      destination.push(buffer);
    };

    deadline = setTimeout(() => {
      rejectOnce(
        new Error(`Python transport timed out after ${timeoutMs}ms.`),
        true
      );
    }, timeoutMs);

    childProcess.stdout?.on("data", chunk => retainOutput(chunk, stdoutChunks));
    childProcess.stderr?.on("data", chunk => retainOutput(chunk, stderrChunks));

    childProcess.on("error", () => {
      rejectOnce(new Error("Python transport failed to start."));
    });

    childProcess.on("close", () => {
      if (settled) {
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (!stdout) {
        if (/ModuleNotFoundError|No module named/u.test(stderr)) {
          rejectOnce(new Error("Python transport runtime dependency is unavailable."));
          return;
        }
        rejectOnce(new Error("Python transport returned no JSON output."));
        return;
      }

      try {
        resolveOnce(JSON.parse(stdout) as ProtocolResponse<unknown>);
      } catch {
        rejectOnce(new Error("Python transport returned invalid JSON."));
      }
    });

    childProcess.stdin?.on("error", () => undefined);
    try {
      childProcess.stdin?.write(JSON.stringify(request));
      childProcess.stdin?.end();
    } catch {
      rejectOnce(new Error("Python transport failed to start."), true);
    }
  });
}

function resolveBoundedPositiveInteger(
  optionName: string,
  value: number | undefined,
  defaultValue: number,
  maximum: number
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `Python transport ${optionName} must be a positive integer no greater than ${maximum}.`
    );
  }
  return value;
}

function resolveRepositoryRoot(): string {
  const configuredRoot = resolveConfiguredDirectory(
    process.env.ARCANOS_REPOSITORY_ROOT ?? process.env.ARCANOS_WORKSPACE_ROOT
  );
  if (configuredRoot && isRepositoryRoot(configuredRoot)) {
    return configuredRoot;
  }

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

function resolvePythonRuntimeDirectory(repositoryRoot: string): string {
  const configuredRuntimeDirectory = resolveConfiguredDirectory(process.env.ARCANOS_PYTHON_RUNTIME_DIR);
  if (configuredRuntimeDirectory) {
    return configuredRuntimeDirectory;
  }

  const defaultRuntimeDirectory = path.join(repositoryRoot, "daemon-python");
  if (existsSync(defaultRuntimeDirectory)) {
    return defaultRuntimeDirectory;
  }

  throw new Error(
    `Unable to locate the python transport runtime directory. Expected "${defaultRuntimeDirectory}" or set ARCANOS_PYTHON_RUNTIME_DIR.`
  );
}

function resolveConfiguredDirectory(rawPath: string | undefined): string | null {
  if (!rawPath || rawPath.trim().length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(rawPath);
  return existsSync(resolvedPath) ? resolvedPath : null;
}

function isRepositoryRoot(candidatePath: string): boolean {
  return (
    existsSync(path.join(candidatePath, ".git"))
    || existsSync(path.join(candidatePath, "daemon-python"))
    || (
      existsSync(path.join(candidatePath, "package.json"))
      && existsSync(path.join(candidatePath, "packages", "protocol"))
    )
  );
}
