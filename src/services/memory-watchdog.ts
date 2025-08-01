const MEMORY_THRESHOLD_MB = 512;

import { dispatchTask } from '../utils/executionGuard';

export function runMemoryWatchdog() {
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapMb = Math.round(usage.heapUsed / 1024 / 1024);
    if (heapMb > MEMORY_THRESHOLD_MB) {
      console.warn(`[WATCHDOG] High memory usage: ${heapMb} MB`);
      dispatchTask('system.memory.snapshot', { usage: heapMb }, 'high');
      // Optional: restart or garbage collection signal
    }
  }, 60 * 1000); // Every 60s
}

