/**
 * Worker Context Factory
 * Provides context object for workers with db, ai, and logging capabilities
 */

import { query as dbQuery, logExecution } from "@core/db/index.js";
import { generateMockResponse } from "@services/openai.js";
import { runThroughBrain } from "@core/logic/trinity.js";
import type { QueryResult } from 'pg';
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';

export interface WorkerContext {
  log: (message: string) => Promise<void>;
  error: (message: string, ...args: unknown[]) => Promise<void>;
  db: {
    query: (text: string, params?: unknown[]) => Promise<QueryResult<Record<string, unknown>>>;
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
      } catch (error: unknown) {
        //audit Assumption: logging failures should not break worker flow
        void error;
      }
    },

    error: async (message: string, ...args: unknown[]) => {
      const fullMessage = args.length > 0 ? `${message} ${args.join(' ')}` : message;
      console.error(`[${workerId}] ERROR: ${fullMessage}`);
      try {
        await logExecution(workerId, 'error', fullMessage);
      } catch (error: unknown) {
        //audit Assumption: error logging failures should not break worker flow
        void error;
      }
    },

    db: {
      query: async (text: string, params: unknown[] = []) => {
        try {
          //audit Assumption: dbQuery returns QueryResult; Handling: pass through
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
          const { client } = getOpenAIClientOrAdapter();
          if (!client) {
            // Return mock response when API key not available
            const mockResponse = generateMockResponse(prompt, 'ask');
            return mockResponse.result || 'Hello from the AI mock system!';
          }

          // Use the trinity brain system for AI processing (pass adapter's client)
          const runtimeBudget = createRuntimeBudget();
          const result = await runThroughBrain(client, prompt, undefined, undefined, {}, runtimeBudget);
          return result.result;
        } catch (error: unknown) {
          //audit Assumption: AI failures should propagate with safe message
          throw new Error(`AI request failed: ${resolveErrorMessage(error)}`);
        }
      }
    }
  };
}
