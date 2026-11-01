import { performance } from 'node:perf_hooks';

/** Keep fixture deadlines independent of wall-clock corrections and elapsedMs an integer. */
export function startFixtureClock() {
  const startedAt = performance.now();
  return () => Math.floor(performance.now() - startedAt);
}
