function enableGC() {
  if (typeof global.gc === 'function') {
    setInterval(() => {
      global.gc();
      console.log('[Memory] Manual garbage collection triggered.');
    }, 60000);
  } else {
    console.warn('[Memory] GC not exposed. Use --expose-gc flag.');
  }
}

function memoryMonitor(threshold = 0.83) {
  setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsed = mem.heapUsed / mem.heapTotal;
    const rssRatio = mem.rss / (mem.heapTotal + mem.external + mem.arrayBuffers);

    if (heapUsed > threshold) {
      console.warn(`[Memory] High heap usage: ${(heapUsed * 100).toFixed(1)}%`);
    }
    if (rssRatio > 0.25) {
      console.warn(`[Memory] High RSS ratio: ${(rssRatio * 100).toFixed(1)}%`);
    }
  }, 30000);
}

enableGC();
memoryMonitor();

export { enableGC, memoryMonitor };
