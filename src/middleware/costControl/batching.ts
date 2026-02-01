import type { AuditLogger } from '../../utils/auditLogger.js';
import type { BatchQueueItem, CacheEntry, CostControlConfig, OpenAIClient } from './types.js';

export const responseCache = new Map<string, CacheEntry>();
export const requestTimestamps: number[] = [];

const batchQueue: BatchQueueItem[] = [];
let batchTimer: NodeJS.Timeout | null = null;

export function trimRequestTimestamps(now: number, windowMs: number): void {
  //audit Assumption: timestamps are sorted by insertion; risk: stale timestamps accumulate; invariant: array holds recent entries; handling: shift until within window.
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > windowMs) {
    requestTimestamps.shift();
  }
}

async function flushBatch(
  openaiClient: OpenAIClient,
  audit: AuditLogger,
  now: () => number,
  config: CostControlConfig
): Promise<void> {
  //audit Assumption: empty batches require no work; risk: unnecessary processing; invariant: queue length zero means no items; handling: early return.
  if (batchQueue.length === 0) return;
  const items = batchQueue.splice(0, batchQueue.length);
  const payloads = items.map((item) => item.payload);
  //audit Assumption: batch flush processes all queued items; risk: partial flush; invariant: queue drained before execution; handling: copy then clear.
  audit.log({
    event: 'batch_flush',
    batchSize: items.length,
    timestamp: new Date(now()).toISOString()
  });

  try {
    const results = await openaiClient.batch(payloads);
    results.forEach((result, index) => {
      const item = items[index];
      responseCache.set(item.prompt, {
        prompt: item.prompt,
        response: result,
        timestamp: now()
      });
      //audit Assumption: batch response aligns with payload order; risk: mismatch; invariant: index maps to payloads; handling: use shared ordering.
      audit.log({
        event: 'batch_response',
        prompt: item.prompt,
        timestamp: new Date(now()).toISOString()
      });
      item.respond(result);
    });
  } catch (error) {
    //audit Assumption: batch failure should reject all queued items; risk: unhandled promises; invariant: each queued response receives error; handling: reject all.
    items.forEach((item) => item.reject(error as Error));
    audit.log({
      event: 'batch_error',
      details: (error as Error).message,
      timestamp: new Date(now()).toISOString()
    });
  }

  batchTimer = null;
  if (batchQueue.length > 0) {
    //audit Assumption: new items may arrive during flush; risk: dropped batches; invariant: queued items should still be processed; handling: reschedule timer.
    batchTimer = setTimeout(() => {
      void flushBatch(openaiClient, audit, now, config);
    }, config.batchWindowMs);
  }
}

export function scheduleBatch(
  item: BatchQueueItem,
  openaiClient: OpenAIClient,
  audit: AuditLogger,
  now: () => number,
  config: CostControlConfig
): void {
  batchQueue.push(item);
  //audit Assumption: batch timer should exist per window; risk: starvation; invariant: batch flush scheduled; handling: start timer when null.
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      void flushBatch(openaiClient, audit, now, config);
    }, config.batchWindowMs);
  }
}
