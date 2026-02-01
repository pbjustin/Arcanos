import { generateRequestId } from '../../utils/idGenerator.js';
import { getMetadataLoopState, getMetadataString, getMetadataTags } from './metadata.js';
import type { MemoryEntry } from './types.js';
import { isValidMemoryEntry } from './validation.js';

/**
 * Sanitize a raw memory entry to match current schema
 */
export function sanitizeMemoryEntry(raw: unknown): MemoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const entry: MemoryEntry = {
    id: typeof record.id === 'string' ? record.id : generateRequestId('mem'),
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
    key: typeof record.key === 'string' ? record.key : '',
    value: typeof record.value === 'string' ? record.value : '',
    type: record.type === 'fact' || record.type === 'preference' || record.type === 'decision' || record.type === 'pattern'
      ? record.type
      : 'context',
    relevanceScore: record.relevanceScore as number | undefined,
    accessCount: typeof record.accessCount === 'number' ? record.accessCount : 0,
    lastAccessed: typeof record.lastAccessed === 'string' ? record.lastAccessed : new Date().toISOString(),
    metadata: {
      source: getMetadataString(record.metadata, 'source') || 'arcanos',
      tags: getMetadataTags(record.metadata),
      sessionId: getMetadataString(record.metadata, 'sessionId'),
      userId: getMetadataString(record.metadata, 'userId'),
      moduleId: getMetadataString(record.metadata, 'moduleId'),
      loopState: getMetadataLoopState(record.metadata),
    },
  };

  return isValidMemoryEntry(entry) ? entry : null;
}

export function sanitizeMemoryIndex(rawEntries: unknown[]): MemoryEntry[] {
  const sanitized: MemoryEntry[] = [];
  for (const raw of rawEntries) {
    const entry = sanitizeMemoryEntry(raw);
    if (entry) sanitized.push(entry);
  }
  return sanitized;
}
