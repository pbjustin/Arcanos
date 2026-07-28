export interface WaitForRuntimeWorkerStartupOptions {
  readonly readiness: readonly Promise<unknown>[];
  readonly timeoutMs: number;
}

export async function waitForRuntimeWorkerStartup(
  options: WaitForRuntimeWorkerStartupOptions
): Promise<void> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.readiness.length === 0
  ) {
    throw new Error("Invalid AI runtime worker startup gate");
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const readiness = Promise.all(options.readiness).then(
    () => undefined,
    () => {
      throw new Error("AI runtime worker startup failed");
    }
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error("AI runtime worker startup timed out")
      );
    }, options.timeoutMs);
  });

  try {
    await Promise.race([readiness, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
