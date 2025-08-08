/**
 * ARCANOS Memory-Aware Reasoning Service
 * 
 * Enhances AI reasoning with persistent memory context and continuity.
 * Integrates memory retrieval into all decision-making processes.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

export interface MemoryEntry {
  id: string;
  timestamp: string;
  key: string;
  value: string;
  type: 'context' | 'fact' | 'preference' | 'decision' | 'pattern';
  relevanceScore?: number;
  accessCount: number;
  lastAccessed: string;
  metadata: {
    source: string;
    tags: string[];
    sessionId?: string;
    userId?: string;
  };
}

export interface MemoryContext {
  relevantEntries: MemoryEntry[];
  contextSummary: string;
  memoryPrompt: string;
  accessLog: string[];
}

// Memory storage paths
const MEMORY_DIR = process.env.ARC_MEMORY_PATH || '/tmp/arc/memory';
// Ensure memory directory exists at runtime
mkdirSync(MEMORY_DIR, { recursive: true });
const MEMORY_INDEX_FILE = join(MEMORY_DIR, 'index.json');
const MEMORY_LOG_FILE = join(MEMORY_DIR, 'memory.log');

// In-memory cache for performance
let memoryIndex: MemoryEntry[] = [];
let memoryLoaded = false;

/**
 * Initialize memory system
 */
function initializeMemory() {
  if (memoryLoaded) return;

  try {
    if (existsSync(MEMORY_INDEX_FILE)) {
      const data = readFileSync(MEMORY_INDEX_FILE, 'utf-8');
      memoryIndex = JSON.parse(data);
      console.log(`🧠 [MEMORY] Loaded ${memoryIndex.length} memory entries`);
    } else {
      memoryIndex = [];
      saveMemoryIndex();
      console.log('🧠 [MEMORY] Initialized new memory system');
    }

    memoryLoaded = true;
  } catch (error) {
    console.error('❌ Failed to initialize memory:', error instanceof Error ? error.message : 'Unknown error');
    memoryIndex = [];
    memoryLoaded = true;
  }
}

/**
 * Save memory index to disk
 */
function saveMemoryIndex() {
  try {
    writeFileSync(MEMORY_INDEX_FILE, JSON.stringify(memoryIndex, null, 2));
  } catch (error) {
    console.error('❌ Failed to save memory index:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Store a memory entry
 */
export function storeMemory(
  key: string,
  value: string,
  type: MemoryEntry['type'] = 'context',
  metadata: Partial<MemoryEntry['metadata']> = {}
): MemoryEntry {
  initializeMemory();

  const entry: MemoryEntry = {
    id: generateMemoryId(),
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

  // Check if key already exists and update instead
  const existingIndex = memoryIndex.findIndex(m => m.key === key);
  if (existingIndex >= 0) {
    memoryIndex[existingIndex] = { ...entry, accessCount: memoryIndex[existingIndex].accessCount };
  } else {
    memoryIndex.push(entry);
  }

  saveMemoryIndex();
  logMemoryAccess('STORE', key, entry.id);

  console.log(`🧠 [MEMORY] Stored: ${key} (${type})`);
  return entry;
}

/**
 * Retrieve relevant memory context for a given input
 */
export function getMemoryContext(
  userInput: string,
  sessionId?: string,
  maxEntries: number = 5
): MemoryContext {
  initializeMemory();

  const inputLower = userInput.toLowerCase();
  const accessLog: string[] = [];

  // Calculate relevance scores for all memory entries
  const scoredEntries = memoryIndex.map(entry => {
    let score = 0;

    // Keyword matching
    const keyWords = inputLower.split(/\s+/).filter(word => word.length > 3);
    for (const word of keyWords) {
      if (entry.key.toLowerCase().includes(word)) score += 3;
      if (entry.value.toLowerCase().includes(word)) score += 2;
      if (entry.metadata.tags.some(tag => tag.toLowerCase().includes(word))) score += 1;
    }

    // Session matching bonus
    if (sessionId && entry.metadata.sessionId === sessionId) {
      score += 5;
    }

    // Recent access bonus
    const daysSinceAccess = (Date.now() - new Date(entry.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess < 1) score += 2;
    else if (daysSinceAccess < 7) score += 1;

    // Type-based scoring
    if (entry.type === 'decision' || entry.type === 'pattern') score += 1;

    return { ...entry, relevanceScore: score };
  }).filter(entry => entry.relevanceScore > 0)
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, maxEntries);

  // Update access counts and timestamps
  for (const entry of scoredEntries) {
    const originalEntry = memoryIndex.find(m => m.id === entry.id);
    if (originalEntry) {
      originalEntry.accessCount++;
      originalEntry.lastAccessed = new Date().toISOString();
      accessLog.push(entry.key);
    }
  }

  if (scoredEntries.length > 0) {
    saveMemoryIndex();
  }

  // Create context summary
  const contextSummary = scoredEntries.length > 0
    ? `Retrieved ${scoredEntries.length} relevant memory entries: ${scoredEntries.map(e => e.key).join(', ')}`
    : 'No relevant memory context found';

  // Create memory-aware prompt enhancement
  const memoryPrompt = createMemoryPrompt(scoredEntries, userInput);

  console.log(`🧠 [MEMORY] Context retrieval: ${scoredEntries.length} entries, accessed: [${accessLog.join(', ')}]`);

  return {
    relevantEntries: scoredEntries,
    contextSummary,
    memoryPrompt,
    accessLog
  };
}

/**
 * Create memory-enhanced prompt
 */
function createMemoryPrompt(entries: MemoryEntry[], userInput: string): string {
  if (entries.length === 0) {
    return `[MEMORY CONTEXT]
No directly relevant memory entries found for this request.
This appears to be a new or unique query requiring fresh analysis.

[USER REQUEST]
${userInput}`;
  }

  const memoryContext = entries.map(entry => 
    `- ${entry.key}: ${entry.value} (${entry.type}, accessed ${entry.accessCount} times)`
  ).join('\n');

  return `[MEMORY CONTEXT]
Relevant previous context and decisions:
${memoryContext}

[CONTINUITY DIRECTIVE]
Use the above memory context to maintain continuity with previous interactions.
Reference relevant patterns, decisions, and context where appropriate.
If the current request builds upon previous work, acknowledge that connection.

[USER REQUEST]
${userInput}`;
}

/**
 * Store a decision or pattern for future reference
 */
export function storeDecision(
  decision: string,
  reasoning: string,
  context: string,
  sessionId?: string
): MemoryEntry {
  const key = `decision_${Date.now()}`;
  const value = `Decision: ${decision}\nReasoning: ${reasoning}\nContext: ${context}`;
  
  return storeMemory(key, value, 'decision', {
    source: 'arcanos_decision',
    tags: ['decision', 'reasoning'],
    sessionId
  });
}

/**
 * Store a pattern recognition for learning
 */
export function storePattern(
  pattern: string,
  examples: string[],
  sessionId?: string
): MemoryEntry {
  const key = `pattern_${Date.now()}`;
  const value = `Pattern: ${pattern}\nExamples: ${examples.join('; ')}`;
  
  return storeMemory(key, value, 'pattern', {
    source: 'arcanos_pattern',
    tags: ['pattern', 'learning'],
    sessionId
  });
}

/**
 * Log memory access for audit trail
 */
function logMemoryAccess(operation: string, key: string, entryId: string) {
  try {
    const logEntry = `${new Date().toISOString()} | ${operation} | ${key} | ${entryId}\n`;
    appendFileSync(MEMORY_LOG_FILE, logEntry);
  } catch (error) {
    console.error('❌ Failed to log memory access:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Generate unique memory ID
 */
function generateMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Get memory statistics for diagnostics
 */
export function getMemoryStats(): {
  totalEntries: number;
  entriesByType: Record<string, number>;
  recentAccess: number;
  oldestEntry: string;
  newestEntry: string;
} {
  initializeMemory();

  const entriesByType: Record<string, number> = {};
  let recentAccess = 0;
  let oldestEntry = '';
  let newestEntry = '';

  for (const entry of memoryIndex) {
    // Count by type
    entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;

    // Count recent access (within 24 hours)
    const hoursSinceAccess = (Date.now() - new Date(entry.lastAccessed).getTime()) / (1000 * 60 * 60);
    if (hoursSinceAccess < 24) {
      recentAccess++;
    }

    // Track oldest and newest
    if (!oldestEntry || entry.timestamp < oldestEntry) {
      oldestEntry = entry.timestamp;
    }
    if (!newestEntry || entry.timestamp > newestEntry) {
      newestEntry = entry.timestamp;
    }
  }

  return {
    totalEntries: memoryIndex.length,
    entriesByType,
    recentAccess,
    oldestEntry,
    newestEntry
  };
}

/**
 * Clean up old or unused memory entries
 */
export function cleanupMemory(maxAge: number = 30, minAccessCount: number = 0): number {
  initializeMemory();

  const cutoffDate = new Date(Date.now() - (maxAge * 24 * 60 * 60 * 1000));
  const initialCount = memoryIndex.length;

  memoryIndex = memoryIndex.filter(entry => {
    const entryDate = new Date(entry.timestamp);
    return entryDate > cutoffDate || entry.accessCount > minAccessCount;
  });

  const removed = initialCount - memoryIndex.length;
  if (removed > 0) {
    saveMemoryIndex();
    console.log(`🧠 [MEMORY] Cleaned up ${removed} old memory entries`);
  }

  return removed;
}