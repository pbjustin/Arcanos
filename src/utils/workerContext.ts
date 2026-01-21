/**
 * Worker Context Factory
 * Provides context object for workers with db, ai, and logging capabilities
 */

import { query as dbQuery, logExecution } from '../db.js';
import { getOpenAIClient, generateMockResponse } from '../services/openai.js';
import { runThroughBrain } from '../logic/trinity.js';

export interface WorkerContext {
  log: (message: string) => Promise<void>;
  error: (message: string, ...args: any[]) => Promise<void>;
  db: {
    query: (text: string, params?: any[]) => Promise<any>;
  };
  ai: {
    ask: (prompt: string) => Promise<string>;
  };
}

/**
 * Create a context object for a worker
 */
export function createWorkerContext(workerId: string): WorkerContext {
  return {
    log: async (message: string) => {
      console.log(`[${workerId}] ${message}`);
      try {
        await logExecution(workerId, 'info', message);
      } catch {
        // Fallback logging already handled in logExecution
      }
    },

    error: async (message: string, ...args: any[]) => {
      const fullMessage = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      console.error(`[${workerId}] ERROR: ${fullMessage}`);
      try {
        await logExecution(workerId, 'error', fullMessage);
      } catch {
        // Fallback logging already handled in logExecution
      }
    },

    db: {
      query: async (text: string, params: any[] = []) => {
        try {
          const result = await dbQuery(text, params);
          return result;
        } catch (error) {
          throw error;
        }
      }
    },

    ai: {
      ask: async (prompt: string) => {
        try {
          const client = getOpenAIClient();
          if (!client) {
            // Return mock response when API key not available
            const mockResponse = generateMockResponse(prompt, 'ask');
            return mockResponse.result || 'Hello from the AI mock system!';
          }

          // Use the trinity brain system for AI processing
          const result = await runThroughBrain(client, prompt);
          return result.result;
        } catch (error) {
          throw new Error(`AI request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }
  };
}