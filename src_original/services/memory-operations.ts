/**
 * OpenAI SDK-Compatible Memory Operations
 * Memory-optimized with efficient querying, batching, and caching
 */

import { coreAIService } from './ai-service-consolidated.js';
import { createServiceLogger } from '../utils/logger.js';
import { databaseService } from './database.js';

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
 * Memory-Optimized Operations Service
 * Enhanced with efficient indexing, batching, and caching strategies
 */
class MemoryOperationsService {
  private memoryCache = new Map<string, MemoryRecord>();
  private batchQueue: MemoryRecord[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = parseInt(process.env.MEMORY_BATCH_SIZE || '50');
  private readonly BATCH_TIMEOUT = parseInt(process.env.MEMORY_BATCH_TIMEOUT || '5000');
  
  // Optimized indexes for fast querying
  private userIndex = new Map<string, Set<string>>();
  private typeIndex = new Map<string, Set<string>>();
  private sessionIndex = new Map<string, Set<string>>();

  getStatus() {
    return {
      cacheEntries: this.memoryCache.size,
      batchQueueSize: this.batchQueue.length,
      indexSizes: {
        users: this.userIndex.size,
        types: this.typeIndex.size,
        sessions: this.sessionIndex.size
      }
    };
  }

  private updateIndexes(record: MemoryRecord): void {
    // Update user index
    if (!this.userIndex.has(record.userId)) {
      this.userIndex.set(record.userId, new Set());
    }
    this.userIndex.get(record.userId)!.add(record.id);
    
    // Update type index
    if (!this.typeIndex.has(record.metadata.type)) {
      this.typeIndex.set(record.metadata.type, new Set());
    }
    this.typeIndex.get(record.metadata.type)!.add(record.id);
    
    // Update session index
    if (!this.sessionIndex.has(record.sessionId)) {
      this.sessionIndex.set(record.sessionId, new Set());
    }
    this.sessionIndex.get(record.sessionId)!.add(record.id);
  }

  private async processBatch(): Promise<void> {
    if (this.batchQueue.length === 0) return;
    
    const batch = this.batchQueue.splice(0, this.BATCH_SIZE);
    
    try {
      // Batch persist to database
      const persistPromises = batch.map(record => this.persistMemory(record));
      await Promise.allSettled(persistPromises);
      
      logger.info('Batch processed', { size: batch.length });
    } catch (error: any) {
      logger.error('Batch processing failed', { error: error.message });
    }
    
    // Schedule next batch if queue still has items
    if (this.batchQueue.length > 0) {
      this.scheduleBatchProcessing();
    }
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }
    
    this.batchTimeout = setTimeout(() => {
      this.processBatch();
    }, this.BATCH_TIMEOUT);
  }

  /**
   * Store memory using optimized batching and indexing
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
    this.updateIndexes(memoryRecord);

    // Add to batch queue for optimized persistence
    this.batchQueue.push(memoryRecord);
    
    // Trigger batch processing if queue is full or schedule timeout
    if (this.batchQueue.length >= this.BATCH_SIZE) {
      await this.processBatch();
    } else {
      this.scheduleBatchProcessing();
    }

    logger.info('Memory stored with optimized batching', { 
      id, 
      type: memoryRecord.metadata.type,
      importance: memoryRecord.metadata.importance,
      batchQueueSize: this.batchQueue.length
    });

    return memoryRecord;
  }

  /**
   * Retrieve memories with memory-optimized search using indexes
   */
  async searchMemories(options: MemorySearchOptions = {}): Promise<MemoryRecord[]> {
    const { userId, sessionId, type, tags, limit = 50, importance } = options;

    // Memory-optimized search using indexes
    let candidateIds: Set<string> | undefined;
    
    // Start with the most restrictive filter to minimize candidate set
    if (userId) {
      candidateIds = this.userIndex.get(userId);
      if (!candidateIds || candidateIds.size === 0) {
        // Fallback to database search
        try {
          return await this.searchInDatabase(options);
        } catch (error: any) {
          logger.warning('Database search failed', { error: error.message });
          return [];
        }
      }
    }
    
    if (sessionId) {
      const sessionIds = this.sessionIndex.get(sessionId);
      if (sessionIds) {
        candidateIds = candidateIds 
          ? new Set([...candidateIds].filter(id => sessionIds.has(id)))
          : sessionIds;
      } else {
        candidateIds = new Set(); // No results for this session
      }
    }
    
    if (type) {
      const typeIds = this.typeIndex.get(type);
      if (typeIds) {
        candidateIds = candidateIds 
          ? new Set([...candidateIds].filter(id => typeIds.has(id)))
          : typeIds;
      } else {
        candidateIds = new Set(); // No results for this type
      }
    }
    
    // If no candidates found in cache, try database
    if (!candidateIds || candidateIds.size === 0) {
      try {
        return await this.searchInDatabase(options);
      } catch (error: any) {
        logger.warning('Database search failed, no cache results', { error: error.message });
        return [];
      }
    }

    // Retrieve records from cache
    const results: MemoryRecord[] = [];
    for (const id of candidateIds) {
      const record = this.memoryCache.get(id);
      if (record) {
        results.push(record);
      }
    }

    // Apply remaining filters
    let filtered = results;

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
      const analysis = await coreAIService.complete([
        {
          role: 'system',
          content: 'Analyze the provided memory context and create a concise summary of key information, patterns, and relevant context for the current conversation.'
        },
        {
          role: 'user',
          content: `Memory context:\n${memoryContent}`
        }
      ], 'memory-analysis', {
        model: 'gpt-4-turbo',
        temperature: 0.3,
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