import {
  spawn,
  type ChildProcess
} from "node:child_process";
import path from "node:path";

const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export interface ProcessTreeTerminationResult {
  method: "posix-process-group" | "windows-taskkill" | "direct-child-fallback";
  treeTerminationConfirmed: boolean;
}

interface ProcessTreeTerminationDependencies {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  spawnProcess?: typeof spawn;
  windowsTaskkillTimeoutMs?: number;
}

/**
 * Requests forceful cleanup of a Python transport process tree.
 *
 * POSIX process-group signaling and a successful Windows taskkill invocation
 * are treated as confirmed tree-wide requests. If either mechanism is
 * unavailable, the direct child is still killed but descendant cleanup remains
 * explicitly best-effort.
 */
export function requestPythonTransportProcessTreeTermination(
  childProcess: Pick<ChildProcess, "pid" | "kill">,
  dependencies: ProcessTreeTerminationDependencies = {}
): Promise<ProcessTreeTerminationResult> {
  const platform = dependencies.platform ?? process.platform;
  const pid = childProcess.pid;

  if (!Number.isInteger(pid) || (pid ?? 0) < 1) {
    killDirectChild(childProcess);
    return Promise.resolve({
      method: "direct-child-fallback",
      treeTerminationConfirmed: false
    });
  }

  if (platform !== "win32") {
    try {
      const killProcessGroup = dependencies.killProcessGroup
        ?? ((processId: number, signal: NodeJS.Signals) => process.kill(processId, signal));
      killProcessGroup(-pid!, "SIGKILL");
      return Promise.resolve({
        method: "posix-process-group",
        treeTerminationConfirmed: true
      });
    } catch {
      killDirectChild(childProcess);
      return Promise.resolve({
        method: "direct-child-fallback",
        treeTerminationConfirmed: false
      });
    }
  }

  const systemRoot = dependencies.systemRoot
    ?? process.env.SystemRoot
    ?? process.env.WINDIR;
  if (
    typeof systemRoot !== "string"
    || systemRoot.includes("\0")
    || !path.win32.isAbsolute(systemRoot)
  ) {
    killDirectChild(childProcess);
    return Promise.resolve({
      method: "direct-child-fallback",
      treeTerminationConfirmed: false
    });
  }

  return requestWindowsTaskkill(
    childProcess,
    pid!,
    path.win32.join(systemRoot, "System32", "taskkill.exe"),
    dependencies
  );
}

function requestWindowsTaskkill(
  childProcess: Pick<ChildProcess, "kill">,
  pid: number,
  taskkillPath: string,
  dependencies: ProcessTreeTerminationDependencies
): Promise<ProcessTreeTerminationResult> {
  return new Promise(resolve => {
    let taskkillProcess: ReturnType<typeof spawn>;
    try {
      const spawnProcess = dependencies.spawnProcess ?? spawn;
      taskkillProcess = spawnProcess(
        taskkillPath,
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore"
        }
      );
    } catch {
      killDirectChild(childProcess);
      resolve({
        method: "direct-child-fallback",
        treeTerminationConfirmed: false
      });
      return;
    }

    let finished = false;
    const finish = (result: ProcessTreeTerminationResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(taskkillDeadline);
      resolve(result);
    };
    const fallback = (): void => {
      if (finished) {
        return;
      }
      killDirectChild(childProcess);
      finish({
        method: "direct-child-fallback",
        treeTerminationConfirmed: false
      });
    };
    const timeoutMs = dependencies.windowsTaskkillTimeoutMs
      ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS;
    const taskkillDeadline = setTimeout(() => {
      try {
        taskkillProcess.kill("SIGKILL");
      } catch {
        // Direct-child fallback below remains the fail-closed transport boundary.
      }
      fallback();
    }, timeoutMs);
    taskkillDeadline.unref();

    taskkillProcess.once("error", fallback);
    taskkillProcess.once("close", exitCode => {
      if (exitCode === 0) {
        finish({
          method: "windows-taskkill",
          treeTerminationConfirmed: true
        });
        return;
      }
      fallback();
    });
    taskkillProcess.unref();
  });
}

function killDirectChild(childProcess: Pick<ChildProcess, "kill">): void {
  try {
    childProcess.kill("SIGKILL");
  } catch {
    // The transport request has already failed closed; cleanup is best-effort.
  }
}
