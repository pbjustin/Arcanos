/**
 * Shared async sleep helper.
 *
 * Purpose:
 * - Provide one reusable Promise-based delay primitive across services, workers, and tests.
 *
 * Inputs/outputs:
 * - Input: delay in milliseconds and optional timer behavior flags.
 * - Output: Promise that resolves after the requested delay.
 *
 * Edge case behavior:
 * - Non-finite or negative delays are clamped to `0` so callers never schedule invalid timers.
 */
export function sleep(
  milliseconds: number,
  options: { unref?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
  //audit Assumption: callers may pass derived values that are negative or non-finite; failure risk: invalid timer scheduling and inconsistent wait behavior; expected invariant: timer delay is always a finite non-negative integer; handling strategy: clamp before scheduling.
  const normalizedDelayMs = Number.isFinite(milliseconds)
    ? Math.max(0, Math.floor(milliseconds))
    : 0;

  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('sleep_aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('sleep_aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, normalizedDelayMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    //audit Assumption: only selected long-poll or background waits should be detached from the event loop; failure risk: unintended early process exit if all timers unref indiscriminately; expected invariant: `unref` stays opt-in; handling strategy: gate the call behind an explicit option.
    if (options.unref && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}
