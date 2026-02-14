/**
 * Execution Watchdog
 *
 * Wraps async task execution with model-aware adaptive timeouts.
 * Uses AbortController for clean cancellation and integrates with
 * the platform telemetry service for observability.
 */

import { resolveTimeout } from "@platform/runtime/watchdogConfig.js";
import { recordLogEvent } from "@platform/logging/telemetry.js";

const NEAR_TIMEOUT_THRESHOLD_RATIO = 0.85;

export interface WatchdogOptions<T> {
  model: string;
  reasoningDepth?: number;
  taskFn: (signal: AbortSignal) => Promise<T>;
}

export async function executeWithWatchdog<T>({
  model,
  reasoningDepth = 1,
  taskFn
}: WatchdogOptions<T>): Promise<T> {
  const timeout = resolveTimeout(model, reasoningDepth);
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    recordLogEvent({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: `Watchdog triggered at ${timeout}ms`,
      context: { model, reasoningDepth, timeout }
    });
    controller.abort();
  }, timeout);

  const start = Date.now();

  try {
    const result = await taskFn(controller.signal);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Execution aborted by watchdog");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);

    const duration = Date.now() - start;
    if (duration > timeout * NEAR_TIMEOUT_THRESHOLD_RATIO) {
      recordLogEvent({
        timestamp: new Date().toISOString(),
        level: 'warn',
        message: `Execution nearing watchdog limit: ${duration}ms / ${timeout}ms`,
        context: { model, reasoningDepth, duration, timeout }
      });
    }
  }
}
