export interface NormalizedMemoryStats {
  heap: {
    total: string;
    used: string;
    percent: string; // percent of heap used vs heap total
  };
  rss: {
    total: string;
    percent: string; // percent of rss used by heap
  };
}

function toMB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Normalize Node.js memoryUsage metrics into consistent MB and percent values
 * across Node versions.
 */
export function normalizeMemoryUsage(memory: NodeJS.MemoryUsage): NormalizedMemoryStats {
  const heapTotalMB = toMB(memory.heapTotal);
  const heapUsedMB = toMB(memory.heapUsed);
  const rssMB = toMB(memory.rss);

  const heapPercent = heapTotalMB > 0 ? Math.round((heapUsedMB / heapTotalMB) * 100) : 0;
  const rssPercent = rssMB > 0 ? Math.round((heapTotalMB / rssMB) * 100) : 0;

  return {
    heap: {
      total: `${heapTotalMB} MB`,
      used: `${heapUsedMB} MB`,
      percent: `${heapPercent}%`,
    },
    rss: {
      total: `${rssMB} MB`,
      percent: `${rssPercent}%`,
    },
  };
}
