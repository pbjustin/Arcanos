/**
 * Simple memory watchdog that logs usage every interval.
 */
export function runMemoryWatchdog(intervalMs = 60_000) {
  const log = () => {
    const mem = process.memoryUsage();
    const rss = (mem.rss / 1024 / 1024).toFixed(2);
    const heap = (mem.heapUsed / 1024 / 1024).toFixed(2);
    console.log(`\uD83D\uDEE1 Memory Watchdog -> RSS: ${rss}MB Heap: ${heap}MB`);
  };

  log();
  setInterval(log, intervalMs);
}
