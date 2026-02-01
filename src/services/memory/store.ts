import { generateRequestId } from '../../utils/idGenerator.js';
import type { MemoryEntry } from './types.js';
import { initializeMemory, saveMemoryIndex } from './storage.js';
import { memoryState } from './state.js';
import { logMemoryAccess, logSuppressionEvent } from './logging.js';
import { isValidMemoryEntry } from './validation.js';

/**
 * Store a memory entry
 */
export function storeMemory(
  key: string,
  value: string,
  type: MemoryEntry['type'] = 'context',
  metadata: Partial<MemoryEntry['metadata']> = {}
): MemoryEntry | null {
  initializeMemory();

  const entry: MemoryEntry = {
    id: generateRequestId('mem'),
    timestamp: new Date().toISOString(),
    key,
    value,
    type,
    accessCount: 0,
    lastAccessed: new Date().toISOString(),
    metadata: {
      source: 'arcanos',
      tags: [],
      ...metadata
    }
  };

  //audit Assumption: invalid entries should not be stored
  if (!isValidMemoryEntry(entry)) {
    logSuppressionEvent(entry.metadata.moduleId || 'unknown', `INVALID_ENTRY:${key}`);
    return null;
  }

  // Check if key already exists and update instead
  const existingIndex = memoryState.index.findIndex(m => m.key === key);
  //audit Assumption: existing key should be updated in place
  if (existingIndex >= 0) {
    memoryState.index[existingIndex] = { ...entry, accessCount: memoryState.index[existingIndex].accessCount };
  } else {
    memoryState.index.push(entry);
  }

  saveMemoryIndex();
  logMemoryAccess('STORE', key, entry.id);

  console.log(`🧠 [MEMORY] Stored: ${key} (${type})`);
  return entry;
}

/**
 * Store a decision or pattern for future reference
 */
export function storeDecision(
  decision: string,
  reasoning: string,
  context: string,
  sessionId?: string
): MemoryEntry | null {
  const key = `decision_${Date.now()}`;
  const value = `Decision: ${decision}\nReasoning: ${reasoning}\nContext: ${context}`;
  
  return storeMemory(key, value, 'decision', {
    source: 'arcanos_decision',
    tags: ['decision', 'reasoning'],
    sessionId,
    moduleId: 'decision'
  });
}

/**
 * Store a pattern recognition for learning
 */
export function storePattern(
  pattern: string,
  examples: string[],
  sessionId?: string
): MemoryEntry | null {
  const key = `pattern_${Date.now()}`;
  const value = `Pattern: ${pattern}\nExamples: ${examples.join('; ')}`;
  
  return storeMemory(key, value, 'pattern', {
    source: 'arcanos_pattern',
    tags: ['pattern', 'learning'],
    sessionId,
    moduleId: 'pattern'
  });
}
