import os from 'os';

const memoryState = {
  lastGC: 0,
  heapLimitMB: parseInt(process.env.HEAP_LIMIT_MB || 300), // Default: 300MB
  usageBufferMB: 20,
  gcCooldownMs: 30000,
};

function getHeapStats() {
  const mem = process.memoryUsage();
  return {
    rss: (mem.rss / 1024 / 1024).toFixed(2),
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
    heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2),
    external: (mem.external / 1024 / 1024).toFixed(2),
  };
}

function shouldTriggerGC() {
  const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
  const timeSinceLastGC = Date.now() - memoryState.lastGC;
  return heapUsedMB > (memoryState.heapLimitMB - memoryState.usageBufferMB)
    && timeSinceLastGC > memoryState.gcCooldownMs;
}

function performGC() {
  if (typeof global.gc !== 'function') {
    console.warn('[MEMORY] GC not exposed. Start Node with --expose-gc');
    return;
  }
  global.gc();
  memoryState.lastGC = Date.now();
  console.log('[MEMORY] Manual GC triggered');
}

export function monitorMemory() {
  const stats = getHeapStats();
  console.log(`[MEMORY] RSS: ${stats.rss}MB, Heap Used: ${stats.heapUsed}MB / ${memoryState.heapLimitMB}MB`);

  if (shouldTriggerGC()) {
    performGC();
  }

  // Optional fail-safe
  const heapUsedMB = parseFloat(stats.heapUsed);
  if (heapUsedMB > memoryState.heapLimitMB + 50) {
    console.warn('[MEMORY] CRITICAL: Heap usage too high, exiting to prevent crash...');
    process.exit(1);
  }
}
