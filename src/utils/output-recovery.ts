/**
 * Output Recovery Utilities for ARCANOS
 * Provides easy integration of GPT-4 fallback functionality across the codebase
 */

import { getGPT4FallbackService, FallbackOptions, FallbackResult } from '../services/gpt4-fallback';
import { createServiceLogger } from './logger';

const logger = createServiceLogger('OutputRecovery');

/**
 * Quick output validation and recovery utility
 */
export async function recoverOutput(
  output: string,
  context: {
    task?: string;
    expectedFormat?: 'json' | 'markdown' | 'text';
    source?: string;
  } = {}
): Promise<{
  output: string;
  wasRecovered: boolean;
  error?: string;
}> {
  try {
    const fallbackService = getGPT4FallbackService();
    
    // Check if recovery is needed
    if (!fallbackService.needsFallback(output, context.expectedFormat)) {
      return {
        output,
        wasRecovered: false
      };
    }

    logger.info('Attempting output recovery', {
      task: context.task,
      source: context.source,
      outputLength: output.length
    });

    // Attempt recovery
    const result = await fallbackService.fallbackToGPT4({
      task: context.task || 'Unknown task',
      malformedOutput: output,
      expectedFormat: context.expectedFormat,
      maxTokens: 2000,
      temperature: 0.3
    });

    if (result.success) {
      logger.info('Output recovery successful', {
        task: context.task,
        source: context.source,
        tokensUsed: result.tokensUsed
      });
      
      return {
        output: result.repairedOutput,
        wasRecovered: true
      };
    } else {
      logger.warning('Output recovery failed, using original', {
        task: context.task,
        source: context.source,
        error: result.error
      });
      
      return {
        output,
        wasRecovered: false,
        error: result.error
      };
    }
  } catch (error: any) {
    logger.error('Output recovery error', {
      task: context.task,
      source: context.source,
      error: error.message
    });
    
    return {
      output,
      wasRecovered: false,
      error: error.message
    };
  }
}

/**
 * Specific utility for game guide recovery
 */
export async function recoverGameGuide(
  task: string,
  malformedGuide: string
): Promise<string> {
  try {
    const fallbackService = getGPT4FallbackService();
    return await fallbackService.recoverMalformedGuide(task, malformedGuide);
  } catch (error: any) {
    logger.error('Game guide recovery failed', { task, error: error.message });
    return malformedGuide; // Return original on failure
  }
}

/**
 * JSON-specific recovery utility
 */
export async function recoverJSON(
  data: string,
  context: { task?: string; source?: string } = {}
): Promise<{
  json: any;
  wasRecovered: boolean;
  error?: string;
}> {
  try {
    // First try to parse as-is
    try {
      const parsed = JSON.parse(data);
      return {
        json: parsed,
        wasRecovered: false
      };
    } catch (parseError) {
      // JSON is malformed, attempt recovery
      const recovered = await recoverOutput(data, {
        task: context.task,
        expectedFormat: 'json',
        source: context.source
      });

      if (recovered.wasRecovered) {
        try {
          const parsed = JSON.parse(recovered.output);
          return {
            json: parsed,
            wasRecovered: true
          };
        } catch (secondParseError) {
          throw new Error('Recovered output is still not valid JSON');
        }
      } else {
        throw parseError;
      }
    }
  } catch (error: any) {
    logger.error('JSON recovery failed', {
      task: context.task,
      source: context.source,
      error: error.message
    });
    
    return {
      json: null,
      wasRecovered: false,
      error: error.message
    };
  }
}

/**
 * Middleware-style wrapper for Express route handlers
 */
export function withOutputRecovery(
  handler: (req: any, res: any) => Promise<any>,
  options: {
    expectedFormat?: 'json' | 'markdown' | 'text';
    source?: string;
  } = {}
) {
  return async (req: any, res: any) => {
    try {
      // Store original res.send and res.json methods
      const originalSend = res.send.bind(res);
      const originalJson = res.json.bind(res);

      // Override res.send to apply recovery
      res.send = function(data: any) {
        if (typeof data === 'string' && data.length > 0) {
          // Apply recovery asynchronously, then send
          recoverOutput(data, {
            task: `${req.method} ${req.path}`,
            expectedFormat: options.expectedFormat,
            source: options.source
          }).then(result => {
            if (result.wasRecovered) {
              res.setHeader('X-Output-Recovered', 'true');
              res.setHeader('X-Recovery-Source', 'gpt4-fallback');
            }
            originalSend(result.output);
          }).catch(() => {
            originalSend(data); // Send original on error
          });
        } else {
          originalSend(data);
        }
      };

      // Override res.json to apply JSON recovery
      res.json = function(data: any) {
        if (typeof data === 'string') {
          // Try to recover JSON from string
          recoverJSON(data, {
            task: `${req.method} ${req.path}`,
            source: options.source
          }).then(result => {
            if (result.wasRecovered) {
              res.setHeader('X-Output-Recovered', 'true');
              res.setHeader('X-Recovery-Source', 'gpt4-fallback');
            }
            originalJson(result.json || data);
          }).catch(() => {
            originalJson(data); // Send original on error
          });
        } else {
          originalJson(data);
        }
      };

      // Execute the original handler
      await handler(req, res);
    } catch (error) {
      // Let the error handler deal with errors
      throw error;
    }
  };
}

/**
 * Check if a string appears to be malformed
 */
export function isMalformed(
  output: string, 
  expectedFormat?: 'json' | 'markdown' | 'text'
): boolean {
  const fallbackService = getGPT4FallbackService();
  return fallbackService.needsFallback(output, expectedFormat);
}

/**
 * Example usage patterns as mentioned in the problem statement
 */
export const ExampleUsage = {
  /**
   * Example: If ARCANOS returns partial guide
   */
  async handlePartialGuide(output: string, res: any) {
    if (output.includes("[") && !output.includes("]")) {
      const repaired = await recoverGameGuide(
        "Fetch Baldur's Gate 3 prologue guide",
        output
      );
      return res.status(200).send(repaired);
    }
    return res.status(200).send(output);
  },

  /**
   * Example: Handle malformed JSON response
   */
  async handleMalformedJSON(jsonString: string, res: any) {
    const recovered = await recoverJSON(jsonString, {
      task: 'API JSON response',
      source: 'api-endpoint'
    });
    
    if (recovered.wasRecovered) {
      res.setHeader('X-Output-Recovered', 'true');
    }
    
    return res.json(recovered.json);
  }
};