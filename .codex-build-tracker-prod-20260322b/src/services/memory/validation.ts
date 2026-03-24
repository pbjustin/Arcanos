import type { MemoryEntry } from './types.js';

/**
 * Validate memory entry before committing to storage
 */
export function isValidMemoryEntry(entry: MemoryEntry): boolean {
  //audit Assumption: valid entries require key/value/moduleId
  if (!entry.key || !entry.value || !entry.metadata.moduleId) return false;
  //audit Assumption: incomplete loop states should be suppressed
  if (entry.metadata.loopState && entry.metadata.loopState !== 'complete') return false;
  return true;
}
