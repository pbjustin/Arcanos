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
    moduleId?: string;
    loopState?: 'init' | 'active' | 'complete';
  };
}

export interface MemoryContext {
  relevantEntries: MemoryEntry[];
  contextSummary: string;
  memoryPrompt: string;
  accessLog: string[];
}
