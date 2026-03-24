/**
 * Simple in-memory store for worker data persistence
 * This is a lightweight store for worker-specific data, separate from the main session store
 */

import { randomUUID } from 'crypto';

interface MemoryEnvelopeMetadata {
  versionId: string;
  monotonicTimestampMs: number;
}

interface MemoryEnvelope<T = unknown> {
  metadata: MemoryEnvelopeMetadata;
  payload: T;
}

const monotonicBaseEpochMs = Date.now();
const monotonicBaseHrNs = process.hrtime.bigint();
let monotonicLastMs = 0;

function getMonotonicTimestampMs(): number {
  const elapsedNs = process.hrtime.bigint() - monotonicBaseHrNs;
  const elapsedMs = Number(elapsedNs / 1_000_000n);
  const computed = monotonicBaseEpochMs + elapsedMs;
  //audit Assumption: timestamp monotonicity must be strict for envelope ordering; risk: duplicate ordering keys under clock jitter; invariant: strictly increasing millis; handling: force increment when computed <= last.
  if (computed <= monotonicLastMs) {
    monotonicLastMs += 1;
    return monotonicLastMs;
  }
  monotonicLastMs = computed;
  return computed;
}

function createEnvelope<T>(payload: T): MemoryEnvelope<T> {
  const monotonicTimestampMs = getMonotonicTimestampMs();
  return {
    metadata: {
      versionId: `worker-memory-${monotonicTimestampMs}-${randomUUID().slice(0, 8)}`,
      monotonicTimestampMs
    },
    payload
  };
}

function isEnvelope(value: unknown): value is MemoryEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!candidate.metadata || typeof candidate.metadata !== 'object' || Array.isArray(candidate.metadata)) {
    return false;
  }
  const metadata = candidate.metadata as Record<string, unknown>;
  return (
    typeof candidate.payload !== 'undefined' &&
    typeof metadata.versionId === 'string' &&
    typeof metadata.monotonicTimestampMs === 'number'
  );
}

function unwrapEnvelope<T = unknown>(value: unknown): { payload: T; metadata?: MemoryEnvelopeMetadata } {
  if (!isEnvelope(value)) {
    return { payload: value as T };
  }
  return { payload: value.payload as T, metadata: value.metadata };
}

const store = new Map<string, unknown>();

export const MemoryStore = {
  /**
   * Set a value in the memory store
   * @param key - The key to store the value under
   * @param value - The value to store
   */
  async set(key: string, value: unknown): Promise<void> {
    const envelope = createEnvelope(value);
    store.set(key, envelope);
  },

  /**
   * Get a value from the memory store
   * @param key - The key to retrieve
   * @returns The stored value or undefined if not found
   */
  async get(key: string): Promise<unknown> {
    const value = store.get(key);
    //audit Assumption: worker store may contain legacy direct values; risk: read compatibility break; invariant: get() returns payload shape; handling: unwrap envelopes and passthrough legacy values.
    return unwrapEnvelope(value).payload;
  },

  /**
   * Delete a value from the memory store
   * @param key - The key to delete
   */
  async delete(key: string): Promise<void> {
    store.delete(key);
  },

  /**
   * Check if a key exists in the store
   * @param key - The key to check
   */
  async has(key: string): Promise<boolean> {
    return store.has(key);
  },

  /**
   * Get all keys in the store
   */
  async keys(): Promise<string[]> {
    return Array.from(store.keys());
  },

  /**
   * Clear all data from the store
   */
  async clear(): Promise<void> {
    store.clear();
  },

  /**
   * Get metadata envelope for a key (diagnostics only).
   * @param key - Key to inspect.
   * @returns Envelope metadata when present.
   */
  async getEnvelopeMetadata(key: string): Promise<MemoryEnvelopeMetadata | undefined> {
    const value = store.get(key);
    const unwrapped = unwrapEnvelope(value);
    return unwrapped.metadata;
  }
};
