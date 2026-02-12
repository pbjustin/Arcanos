/**
 * v2 Trust Verification — Hash-Chained Audit Logger
 *
 * Every audit event is chained to the previous via SHA-256, producing a
 * tamper-evident log sequence. Uses an async queue to serialize access
 * and prevent race conditions on the hash chain.
 */

import { createHash } from "node:crypto";

let previousHash: string | null = null;
let pendingFlush: Promise<void> = Promise.resolve();

export interface AuditEvent {
  type: string;
  [key: string]: unknown;
}

function deepSortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Log an audit event with hash-chain integrity.
 * Serialized via a promise queue to prevent race conditions.
 */
export function logAuditEvent(event: AuditEvent): void {
  pendingFlush = pendingFlush.then(() => {
    const timestamp = new Date().toISOString();
    const payload = { ...event, timestamp };
    const eventJson = JSON.stringify(deepSortKeys(payload));

    const hashInput = (previousHash ?? "") + eventJson;
    const currentHash = createHash("sha256").update(hashInput).digest("hex");

    const entry = {
      event: payload,
      chain_hash: currentHash,
      prev_hash: previousHash,
    };

    // Emit as structured JSON to stdout for log aggregation
    console.log(JSON.stringify(entry));

    previousHash = currentHash;
  }).catch(() => {
    // Audit logging must not throw and crash the caller
  });
}

/**
 * Wait for all pending audit entries to flush.
 */
export async function flushAuditLog(): Promise<void> {
  await pendingFlush;
}

/**
 * Reset the hash chain (for testing only).
 */
export function _resetAuditChain(): void {
  previousHash = null;
  pendingFlush = Promise.resolve();
}
