import type { MemoryEntry } from './types.js';

export function getMetadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  return typeof record[key] === 'string' ? record[key] : undefined;
}

export function getMetadataTags(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  const record = metadata as Record<string, unknown>;
  const tags = record.tags;
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter(tag => typeof tag === 'string');
}

export function getMetadataLoopState(metadata: unknown): MemoryEntry['metadata']['loopState'] {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  const loopState = record.loopState;
  return loopState === 'init' || loopState === 'active' || loopState === 'complete'
    ? loopState
    : undefined;
}
