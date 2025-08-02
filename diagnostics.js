const os = require('os');
const isProd = process.env.NODE_ENV === 'production';

// Check Node.js version
if (!isProd) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 13)) {
    console.warn(`Node.js v${process.versions.node} detected. Please upgrade to LTS v20.13 or later.`);
  }
}

const hasGC = typeof global.gc === 'function';
if (!hasGC && !isProd) {
  console.warn('Garbage collection is not exposed. Run Node with --expose-gc to enable manual GC.');
}

// Trigger GC every 60 seconds if available
if (hasGC) {
  setInterval(() => {
    try {
      global.gc();
    } catch (err) {
      if (!isProd) {
        console.warn('Failed to run garbage collection:', err);
      }
    }
  }, 60_000).unref();
}

if (!isProd) {
  // Log memory usage every 30 seconds
  const logMemory = () => {
    const mem = process.memoryUsage();
    const heapUsed = mem.heapUsed / 1024 / 1024;
    const heapTotal = mem.heapTotal / 1024 / 1024;
    const rss = mem.rss / 1024 / 1024;
    console.log(`[Memory] Heap ${heapUsed.toFixed(2)} MB / ${heapTotal.toFixed(2)} MB, RSS ${rss.toFixed(2)} MB`);

    const heapUsageRatio = mem.heapTotal ? mem.heapUsed / mem.heapTotal : 0;
    const rssUsageRatio = mem.rss / os.totalmem();

    if (heapUsageRatio > 0.83) {
      console.warn(`[Memory] Warning: Heap usage ${(heapUsageRatio * 100).toFixed(2)}% exceeds 83%`);
    }
    if (rssUsageRatio > 0.25) {
      console.warn(`[Memory] Warning: RSS ${(rssUsageRatio * 100).toFixed(2)}% exceeds 25% of system memory`);
    }
  };

  setInterval(logMemory, 30_000).unref();
}
