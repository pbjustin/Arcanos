import { createVersionStamp } from './monotonicClock.js';

export interface MemoryMetadataEnvelope {
  versionId: string;
  monotonicTimestampMs: number;
  trustedSnapshotId?: string;
}

export interface VersionedMemoryEnvelope<T = unknown> {
  metadata: MemoryMetadataEnvelope;
  payload: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Purpose: Create a versioned memory envelope for durable writes.
 * Inputs/Outputs: Payload plus optional trusted snapshot id; returns envelope.
 * Edge cases: Always generates fresh monotonic metadata on write.
 */
export function createVersionedMemoryEnvelope<T>(
  payload: T,
  options: { trustedSnapshotId?: string; prefix?: string } = {}
): VersionedMemoryEnvelope<T> {
  const stamp = createVersionStamp(options.prefix || 'memory');
  return {
    metadata: {
      versionId: stamp.versionId,
      monotonicTimestampMs: stamp.monotonicTimestampMs,
      trustedSnapshotId: options.trustedSnapshotId
    },
    payload
  };
}

/**
 * Purpose: Detect whether a value is already a versioned memory envelope.
 * Inputs/Outputs: Unknown value; returns boolean type guard.
 * Edge cases: Rejects malformed metadata objects.
 */
export function isVersionedMemoryEnvelope<T = unknown>(
  value: unknown
): value is VersionedMemoryEnvelope<T> {
  //audit Assumption: envelope requires object shape with metadata and payload keys; failure risk: false positives on arbitrary objects; expected invariant: strict metadata typing; handling strategy: explicit guard checks.
  if (!isRecord(value) || !('metadata' in value) || !('payload' in value)) {
    return false;
  }

  const metadata = value.metadata;
  //audit Assumption: metadata fields are mandatory for sync logic; failure risk: stale or non-versioned reads; expected invariant: versionId string + monotonic number; handling strategy: validate exact primitives.
  if (!isRecord(metadata)) {
    return false;
  }

  return (
    typeof metadata.versionId === 'string' &&
    metadata.versionId.length > 0 &&
    typeof metadata.monotonicTimestampMs === 'number' &&
    Number.isFinite(metadata.monotonicTimestampMs)
  );
}

/**
 * Purpose: Unwrap stored memory payload while preserving metadata when present.
 * Inputs/Outputs: Raw stored value; returns { payload, metadata? }.
 * Edge cases: Backward compatible with legacy non-envelope values.
 */
export function unwrapVersionedMemoryEnvelope<T = unknown>(value: unknown): {
  payload: T;
  metadata?: MemoryMetadataEnvelope;
} {
  //audit Assumption: legacy memory rows may not yet be enveloped; failure risk: runtime breakage on old rows; expected invariant: caller always gets payload; handling strategy: passthrough for legacy values.
  if (!isVersionedMemoryEnvelope<T>(value)) {
    return { payload: value as T };
  }

  return {
    payload: value.payload,
    metadata: value.metadata
  };
}

