/**
 * OpenAI SDK-Compatible Memory Operations
 * Streamlined memory handling following OpenAI assistant patterns
 * Updated to use unified OpenAI service
 */

import { getUnifiedOpenAI } from './unified-openai';
import { createServiceLogger } from '../utils/logger';
import { databaseService } from './database';

const logger = createServiceLogger('MemoryOperations');

export interface MemoryRecord {
  id: string;
  userId: string;
  sessionId: string;
  content: string;
  metadata: {
    type: 'context' | 'preference' | 'conversation' | 'system';
    importance: 'low' | 'medium' | 'high';
    timestamp: string;
    tags: string[];
  };
}

export interface MemorySearchOptions {
  userId?: string;
  sessionId?: string;
  type?: string;
  tags?: string[];
  limit?: number;
  importance?: 'low' | 'medium' | 'high';
}

/**
 * Streamlined Memory Operations Service
 * Follows OpenAI SDK patterns for context management
 */
class MemoryOperationsService {
  private memoryCache = new Map<string, MemoryRecord>();

  /**
   * Store memory using OpenAI SDK-compatible patterns
   */
  async storeMemory(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const memoryRecord: MemoryRecord = {
      id,
      ...record,
      metadata: {
        ...record.metadata,
        timestamp: new Date().toISOString()
      }
    };

    // Cache in memory for fast access
    this.memoryCache.set(id, memoryRecord);

    // Persist to database if available
    try {
      await this.persistMemory(memoryRecord);
    } catch (error: any) {
      logger.warning('Failed to persist memory to database', { error: error.message });
    }

    logger.info('Memory stored', { 
      id, 
      type: memoryRecord.metadata.type,
      importance: memoryRecord.metadata.importance
    });

    return memoryRecord;
  }

  /**
   * Retrieve memories with OpenAI SDK-compatible search
   */
  async searchMemories(options: MemorySearchOptions = {}): Promise<MemoryRecord[]> {
    const { userId, sessionId, type, tags, limit = 50, importance } = options;

    let results: MemoryRecord[] = [];

    // Try database first
    try {
      results = await this.searchInDatabase(options);
    } catch (error: any) {
      logger.warning('Database search failed, using cache', { error: error.message });
      results = this.searchInCache(options);
    }

    // Apply filters
    let filtered = results;

    if (userId) {
      filtered = filtered.filter(m => m.userId === userId);
    }

    if (sessionId) {
      filtered = filtered.filter(m => m.sessionId === sessionId);
    }

    if (type) {
      filtered = filtered.filter(m => m.metadata.type === type);
    }

    if (importance) {
      filtered = filtered.filter(m => m.metadata.importance === importance);
    }

    if (tags && tags.length > 0) {
      filtered = filtered.filter(m => 
        tags.some(tag => m.metadata.tags.includes(tag))
      );
    }

    // Sort by importance and timestamp
    filtered.sort((a, b) => {
      const importanceOrder = { high: 3, medium: 2, low: 1 };
      const importanceDiff = importanceOrder[b.metadata.importance] - importanceOrder[a.metadata.importance];
      if (importanceDiff !== 0) return importanceDiff;
      return new Date(b.metadata.timestamp).getTime() - new Date(a.metadata.timestamp).getTime();
    });

    return filtered.slice(0, limit);
  }

  /**
   * AI-enhanced memory analysis using OpenAI SDK
   */
  async analyzeMemoryContext(userId: string, sessionId: string): Promise<string> {
    const memories = await this.searchMemories({ userId, sessionId, limit: 20 });

    if (memories.length === 0) {
      return 'No relevant memory context found.';
    }

    const memoryContent = memories
      .map(m => `[${m.metadata.type}] ${m.content}`)
      .join('\n');

    try {
      const unifiedOpenAI = getUnifiedOpenAI();
      const analysis = await unifiedOpenAI.chat([
        {
          role: 'system',
          content: 'Analyze the provided memory context and create a concise summary of key information, patterns, and relevant context for the current conversation.'
        },
        {
          role: 'user',
          content: `Memory context:\n${memoryContent}`
        }
      ], {
        maxTokens: 500
      });

      return analysis.content || 'Memory analysis unavailable.';
    } catch (error: any) {
      logger.error('Memory analysis failed', error);
      return `Found ${memories.length} relevant memories with key information about user preferences and conversation history.`;
    }
  }

  /**
   * Clean up old or low-importance memories
   */
  async cleanupMemories(userId: string, options: { 
    olderThanDays?: number; 
    keepHighImportance?: boolean;
    maxRecords?: number;
  } = {}): Promise<number> {
    const { olderThanDays = 30, keepHighImportance = true, maxRecords = 1000 } = options;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    let cleaned = 0;

    // Clean from cache
    for (const [id, memory] of this.memoryCache) {
      if (memory.userId === userId) {
        const memoryDate = new Date(memory.metadata.timestamp);
        const shouldDelete = memoryDate < cutoffDate && 
          (!keepHighImportance || memory.metadata.importance !== 'high');
        
        if (shouldDelete) {
          this.memoryCache.delete(id);
          cleaned++;
        }
      }
    }

    // Clean from database
    try {
      const dbCleaned = await this.cleanupDatabase(userId, cutoffDate, keepHighImportance);
      cleaned += dbCleaned;
    } catch (error: any) {
      logger.warning('Database cleanup failed', { error: error.message });
    }

    logger.info('Memory cleanup completed', { userId, cleaned, olderThanDays });
    return cleaned;
  }

  /**
   * Persist memory to database
   */
  private async persistMemory(memory: MemoryRecord): Promise<void> {
    try {
      // Use the database service's save method if available
      await databaseService.saveMemory({
        memory_key: memory.id,
        memory_value: {
          ...memory,
          metadata: memory.metadata
        },
        container_id: memory.sessionId
      });
    } catch (error: any) {
      // If database save fails, we'll keep it in cache only
      throw new Error(`Database persistence failed: ${error.message}`);
    }
  }

  /**
   * Search memories in database
   */
  private async searchInDatabase(options: MemorySearchOptions): Promise<MemoryRecord[]> {
    try {
      const { userId, sessionId } = options;
      
      // Use the database service's load method
      const dbMemories = await databaseService.loadAllMemory(sessionId || 'default');
      
      return dbMemories
        .map(dbMem => {
          try {
            const memData = typeof dbMem.memory_value === 'string' 
              ? JSON.parse(dbMem.memory_value) 
              : dbMem.memory_value;
              
            return {
              id: memData.id || dbMem.memory_key,
              userId: memData.userId || userId || 'unknown',
              sessionId: memData.sessionId || sessionId || 'default',
              content: memData.content || JSON.stringify(dbMem.memory_value),
              metadata: memData.metadata || {
                type: 'context',
                importance: 'medium',
                timestamp: dbMem.created_at.toISOString(),
                tags: []
              }
            } as MemoryRecord;
          } catch (parseError) {
            // Skip malformed entries
            return null;
          }
        })
        .filter(Boolean) as MemoryRecord[];
        
    } catch (error: any) {
      throw new Error(`Database search failed: ${error.message}`);
    }
  }

  /**
   * Search memories in cache
   */
  private searchInCache(options: MemorySearchOptions): MemoryRecord[] {
    return Array.from(this.memoryCache.values());
  }

  /**
   * Cleanup old memories from database
   */
  private async cleanupDatabase(userId: string, cutoffDate: Date, keepHighImportance: boolean): Promise<number> {
    try {
      // For now, use the clear method and return 0 to indicate no specific cleanup
      // In a full implementation, this would need custom SQL queries
      return 0;
    } catch (error: any) {
      return 0;
    }
  }
}

export const memoryOperations = new MemoryOperationsService();