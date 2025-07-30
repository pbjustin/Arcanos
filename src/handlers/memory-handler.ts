// ARCANOS:MEMORY-HANDLER - Streamlined memory route handler
// Uses new OpenAI SDK-compatible memory operations
// Enhanced with GPT-4 fallback for malformed memory outputs

import { Request, Response } from 'express';
import { memoryOperations } from '../services/memory-operations';
import { recoverOutput } from '../utils/output-recovery';

export class MemoryHandler {
  async handleMemoryRequest(req: Request, res: Response): Promise<void> {
    console.log('📝 MemoryHandler: Processing memory request with streamlined operations');
    const timestamp = new Date().toISOString();
    
    try {
      const { memory_key, memory_value, operation = 'store' } = req.body;
      
      if (!memory_key && operation !== 'list') {
        res.status(400).json({ 
          error: 'memory_key is required for non-list operations',
          example: { memory_key: 'user_preference', memory_value: { theme: 'dark' } },
          timestamp
        });
        return;
      }

      // Use streamlined memory operations based on operation type
      let result;
      
      try {
        switch (operation) {
          case 'store':
          case 'save':
            if (memory_value === undefined) {
              res.status(400).json({ 
                error: 'memory_value is required for store/save operations',
                timestamp
              });
              return;
            }
            
            result = await memoryOperations.storeMemory({
              userId: (req.headers['x-container-id'] as string) || 'default',
              sessionId: (req.headers['x-session-id'] as string) || 'default',
              content: typeof memory_value === 'string' ? memory_value : JSON.stringify(memory_value),
              metadata: {
                type: 'context',
                importance: 'medium',
                timestamp: new Date().toISOString(),
                tags: [memory_key]
              }
            });
            break;
            
          case 'load':
          case 'get':
            const searchResults = await memoryOperations.searchMemories({
              userId: (req.headers['x-container-id'] as string) || 'default',
              sessionId: (req.headers['x-session-id'] as string) || 'default',
              tags: [memory_key],
              limit: 1
            });
            result = searchResults[0] || null;
            break;
            
          case 'list':
            result = await memoryOperations.searchMemories({
              userId: (req.headers['x-container-id'] as string) || 'default',
              sessionId: (req.headers['x-session-id'] as string) || 'default',
              limit: 50
            });
            break;
            
          default:
            res.status(400).json({ 
              error: 'Invalid operation. Use: store, load, or list',
              timestamp
            });
            return;
        }

        
        console.log(`✅ Memory ${operation} operation successful:`, { memory_key, operation, timestamp });
        
        // Prepare response data
        const responseData = {
          success: true,
          message: `Memory ${operation} completed`,
          data: result,
          operation,
          timestamp
        };

        // Apply GPT-4 fallback if the response data appears malformed
        if (result && typeof result === 'object') {
          try {
            // Handle both single record and array results
            const records = Array.isArray(result) ? result : [result];
            let hasRecovery = false;
            
            for (const record of records) {
              if (record.content) {
                const recoveryResult = await recoverOutput(record.content, {
                  task: `Memory ${operation} operation`,
                  expectedFormat: 'text',
                  source: 'memory-handler'
                });
                
                if (recoveryResult.wasRecovered) {
                  record.content = recoveryResult.output;
                  hasRecovery = true;
                }
              }
            }
            
            if (hasRecovery) {
              responseData.data = result;
              res.setHeader('X-Output-Recovered', 'true');
              res.setHeader('X-Recovery-Source', 'gpt4-fallback');
              console.log(`🔄 Applied GPT-4 fallback for memory ${operation}`);
            }
          } catch (recoveryError: any) {
            console.warn(`⚠️ GPT-4 fallback failed for memory ${operation}:`, recoveryError.message);
            // Continue with original response
          }
        }
        
        res.status(200).json(responseData);
        
      } catch (error: any) {
        console.error(`❌ Memory ${operation} operation failed:`, error);
        res.status(500).json({ 
          error: `Failed to ${operation} memory`,
          details: error.message,
          timestamp 
        });
      }
      
    } catch (error: any) {
      console.error('❌ MEMORY-HANDLER: Request processing failed:', error);
      res.status(500).json({ 
        error: 'Failed to process memory request',
        details: error.message,
        timestamp 
      });
    }
  }

  // Enhanced memory snapshot saving every hour
  async startPeriodicMemorySnapshots(): Promise<void> {
    console.log('⏰ Starting periodic memory snapshots every hour');
    
    // Primary: setInterval approach
    setInterval(async () => {
      await this.performStreamlinedSnapshot();
    }, 60 * 60 * 1000); // 1 hour

    // CRON fallback - using node-cron as backup
    try {
      console.log('📸 Starting streamlined memory snapshots');
      // Simplified snapshot using the new memory operations
      const { default: cron } = await import('node-cron');
      cron.schedule('0 * * * *', async () => { // Every hour
        await this.performStreamlinedSnapshot();
      });
      console.log('✅ Streamlined memory snapshots scheduled');
    } catch (cronError: any) {
      console.warn('⚠️ CRON scheduling failed:', cronError.message);
    }
  }

  private async performStreamlinedSnapshot(): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`📸 STREAMLINED-SNAPSHOT: Performing memory snapshot at ${timestamp}`);
    
    try {
      // Create a snapshot using the new memory operations
      await memoryOperations.storeMemory({
        userId: 'system',
        sessionId: 'snapshots',
        content: `Memory snapshot created at ${timestamp}`,
        metadata: {
          type: 'system',
          importance: 'medium',
          timestamp,
          tags: ['snapshot', 'periodic', 'memory-maintenance']
        }
      });
      
      console.log('✅ STREAMLINED-SNAPSHOT: Snapshot created successfully');
    } catch (error: any) {
      console.error('❌ STREAMLINED-SNAPSHOT: Failed to perform snapshot:', error);
    }
  }
}

// Export singleton instance
export const memoryHandler = new MemoryHandler();