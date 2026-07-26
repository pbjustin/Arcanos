export type RuntimeShutdownSignal = "SIGINT" | "SIGTERM";

export interface RuntimeShutdownLogger {
  error(event: string): void;
}

export interface RuntimeShutdownResult {
  forced: boolean;
  ok: boolean;
  signal: RuntimeShutdownSignal;
}

export interface CreateRuntimeShutdownCoordinatorOptions {
  force(): Promise<void> | void;
  graceful(): Promise<void>;
  logger?: RuntimeShutdownLogger;
  timeoutMs: number;
}

export interface RuntimeShutdownCoordinator {
  isShuttingDown(): boolean;
  shutdown(
    signal: RuntimeShutdownSignal
  ): Promise<RuntimeShutdownResult>;
}

export interface RuntimeSignalTarget {
  exitCode: string | number | null | undefined;
  exit(code: number): never | void;
  once(
    signal: RuntimeShutdownSignal,
    listener: () => void
  ): unknown;
}

export interface RuntimeWorkerShutdownPort {
  close(force?: boolean): Promise<void>;
  pause(doNotWaitActive?: boolean): Promise<void>;
}

export interface RuntimeWorkerShutdownHandlers {
  force(): Promise<void>;
  graceful(): Promise<void>;
}

export interface CreateRuntimeWorkerShutdownHandlersOptions {
  closeQueue(): Promise<void>;
  waitForTerminalReleases(): Promise<void>;
  worker: RuntimeWorkerShutdownPort;
}

type ShutdownRaceOutcome =
  | "failed"
  | "graceful"
  | "timeout";

export function createRuntimeShutdownCoordinator(
  options: CreateRuntimeShutdownCoordinatorOptions
): RuntimeShutdownCoordinator {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new Error("Invalid AI runtime shutdown timeout");
  }
  const logger = options.logger ?? console;
  let activeShutdown:
    | Promise<RuntimeShutdownResult>
    | undefined;

  function logError(event: string): void {
    try {
      logger.error(event);
    } catch {
      // Shutdown must continue even when the logger is unavailable.
    }
  }

  function shutdown(
    signal: RuntimeShutdownSignal
  ): Promise<RuntimeShutdownResult> {
    if (activeShutdown) {
      return activeShutdown;
    }

    activeShutdown = (async () => {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeout = new Promise<ShutdownRaceOutcome>(
        (resolve) => {
          timeoutHandle = setTimeout(
            () => resolve("timeout"),
            options.timeoutMs
          );
        }
      );
      const graceful: Promise<ShutdownRaceOutcome> =
        Promise.resolve()
        .then(() => options.graceful())
        .then(
          () => "graceful",
          () => "failed"
        );
      const outcome = await Promise.race([
        graceful,
        timeout
      ]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (outcome === "graceful") {
        return { forced: false, ok: true, signal };
      }

      logError(
        outcome === "timeout"
          ? "ai_runtime.shutdown.timeout"
          : "ai_runtime.shutdown.failed"
      );
      try {
        await options.force();
      } catch {
        logError("ai_runtime.shutdown.force_failed");
      }
      return { forced: true, ok: false, signal };
    })();
    return activeShutdown;
  }

  return {
    isShuttingDown() {
      return activeShutdown !== undefined;
    },
    shutdown
  };
}

export function createRuntimeWorkerShutdownHandlers(
  options: CreateRuntimeWorkerShutdownHandlersOptions
): RuntimeWorkerShutdownHandlers {
  return {
    async graceful() {
      await options.worker.pause(false);
      await options.worker.close(true);
      await options.waitForTerminalReleases();
      await options.closeQueue();
    },
    async force() {
      const results = await Promise.allSettled([
        options.worker.close(true),
        options.closeQueue()
      ]);
      if (
        results.some(({ status }) => status === "rejected")
      ) {
        throw new Error(
          "AI runtime forced worker shutdown failed"
        );
      }
    }
  };
}

export function installRuntimeSignalHandlers(
  coordinator: RuntimeShutdownCoordinator,
  target: RuntimeSignalTarget = process
): void {
  for (const signal of [
    "SIGTERM",
    "SIGINT"
  ] satisfies RuntimeShutdownSignal[]) {
    target.once(signal, () => {
      void coordinator
        .shutdown(signal)
        .then((result) => {
          if (!result.ok) {
            target.exitCode = 1;
            target.exit(1);
          }
        })
        .catch(() => {
          target.exitCode = 1;
          target.exit(1);
        });
    });
  }
}
