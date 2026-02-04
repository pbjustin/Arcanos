import type { MemoryContext, MemoryEntry } from './types.js';
import { memoryState } from './state.js';
import { initializeMemory, saveMemoryIndex } from './storage.js';

/**
 * Retrieve and build memory context for AI reasoning
 * 
 * This function analyzes user input and retrieves relevant memory entries to enhance
 * AI responses with contextual continuity. It implements:
 * 
 * - Keyword-based relevance scoring for content matching
 * - Session-based relevance bonuses for conversation continuity 
 * - Recent activity prioritization for temporal relevance
 * - Access frequency weighting for important memories
 * - Comprehensive logging for memory access tracking
 * 
 * @param userInput - The user's input to find relevant context for
 * @param sessionId - Optional session ID for conversation continuity
 * @param maxEntries - Maximum number of memory entries to return (default: 5)
 * @returns MemoryContext - Object containing relevant memories and context summary
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
  const scoredEntries = memoryState.index.map(entry => {
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
    const originalEntry = memoryState.index.find(m => m.id === entry.id);
    if (originalEntry) {
      originalEntry.accessCount++;
      originalEntry.lastAccessed = new Date().toISOString();
      accessLog.push(entry.key);
    }
  }

  //audit Assumption: scoring updates should persist if any entries found
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
