import { performanceMonitor } from '../utils/performance';
import { getHeapStatistics } from 'v8';
import { maybeReflect } from '../utils/executionGuard';

class MemoryMonitor {
  private logIntervalId?: NodeJS.Timeout;
  private gcIntervalId?: NodeJS.Timeout;
  private usageIntervalId?: NodeJS.Timeout;

  start(logIntervalMs = 5 * 60 * 1000, threshold = 0.8) {
    if (this.logIntervalId) return;

    this.logUsage();
    this.logIntervalId = setInterval(() => this.logUsage(), logIntervalMs);
    this.usageIntervalId = setInterval(() => this.checkUsage(threshold), 30 * 1000);

    if (typeof global.gc === 'function') {
      console.log('[Memory] GC enabled and scheduled.');
      const gc = global.gc;
      this.gcIntervalId = setInterval(() => {
        gc();
        console.log('[Memory] Garbage collection triggered.');
      }, 60 * 1000);
    } else {
      console.warn('[Memory] GC is not exposed. Start Node with --expose-gc');
    }

    process.on('exit', () => this.stop());
  }

  stop() {
    if (this.logIntervalId) clearInterval(this.logIntervalId);
    if (this.gcIntervalId) clearInterval(this.gcIntervalId);
    if (this.usageIntervalId) clearInterval(this.usageIntervalId);
    this.logIntervalId = undefined;
    this.gcIntervalId = undefined;
    this.usageIntervalId = undefined;
  }

  private checkUsage(threshold: number) {
    const mem = process.memoryUsage();
    const heapUsed = mem.heapUsed / mem.heapTotal;
    const rssRatio = mem.rss / (mem.heapTotal + mem.external + mem.arrayBuffers);

    if (heapUsed > threshold) {
      console.warn(`[Memory] High heap usage detected: ${(heapUsed * 100).toFixed(1)}%`);
    }
    if (rssRatio > 0.25) {
      console.warn(
        `[Memory] High RSS ratio detected: ${(rssRatio * 100).toFixed(1)}% — consider optimizing object lifetimes.`
      );
    }
  }

  private logUsage() {
    const mem = process.memoryUsage();
    const heapStats = getHeapStatistics();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
    const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(2);
    const externalMB = (mem.external / 1024 / 1024).toFixed(2);
    const bufferMB = (mem.arrayBuffers / 1024 / 1024).toFixed(2);
    const diffMB = ((mem.rss - mem.heapTotal) / 1024 / 1024).toFixed(2);
    const heapLimitGB = (heapStats.heap_size_limit / 1024 / 1024 / 1024).toFixed(2);

    console.log(
      `🧠 [MEMORY_MONITOR] RSS: ${rssMB}MB, Heap: ${heapUsedMB}/${heapTotalMB}MB, External: ${externalMB}MB, Buffers: ${bufferMB}MB, RSS-HeapDiff: ${diffMB}MB, HeapLimit: ${heapLimitGB}GB`
    );

    performanceMonitor.updateMemorySnapshot();
    maybeReflect();
  }
}

export const memoryMonitor = new MemoryMonitor();
