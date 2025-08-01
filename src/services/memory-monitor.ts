import { performanceMonitor } from '../utils/performance';
import { getHeapStatistics } from 'v8';
import { maybeReflect } from '../utils/executionGuard';

class MemoryMonitor {
  private intervalId?: NodeJS.Timeout;

  start(intervalMs = 5 * 60 * 1000) {
    if (this.intervalId) return;
    this.logUsage();
    this.intervalId = setInterval(() => this.logUsage(), intervalMs);
    process.on('exit', () => this.stop());
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = undefined;
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
