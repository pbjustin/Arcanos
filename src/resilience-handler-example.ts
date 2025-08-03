/**
 * Example implementation of the ClarkeHandler pattern
 * Demonstrates the transformation from old code to patched code
 * as specified in the problem statement.
 */

import './services/clarke-handler'; // Import to ensure ClarkeHandler is attached to OpenAI namespace
import { genericFallback, ClarkeHandler } from './services/clarke-handler';
import OpenAI from 'openai';

/**
 * OLD CODE PATTERN (commented out):
 * 
 * let handler = new OpenAI.ClarkeHandler({ ...process.env });
 * handler.initialzeResilience({ retries: 3 });
 */

/**
 * PATCHED CODE PATTERN:
 * Global initialization check prevents duplicate handler setup
 */
export function initializeResilienceHandler(): ClarkeHandler | null {
  if (!global.resilienceHandlerInitialized) {
    console.log('🔧 Initializing resilience handler...');
    
    let handler = new OpenAI.ClarkeHandler({ ...process.env });
    handler.initialzeResilience({ retries: 3 });
    handler.fallbackTo(genericFallback());
    global.resilienceHandlerInitialized = true;
    
    console.log('✅ Resilience handler initialized successfully');
    return handler;
  } else {
    console.log('ℹ️ Resilience handler already initialized');
    return null;
  }
}

/**
 * Get or create a resilience-enabled OpenAI handler
 */
export function getResilienceHandler(): ClarkeHandler {
  // Initialize if not already done
  const newHandler = initializeResilienceHandler();
  
  if (newHandler) {
    return newHandler;
  }
  
  // If already initialized, create a new instance with same config
  const handler = new OpenAI.ClarkeHandler({ ...process.env });
  handler.initialzeResilience({ retries: 3 });
  handler.fallbackTo(genericFallback());
  
  return handler;
}

/**
 * Example usage function
 */
export async function exampleUsage() {
  console.log('🧪 Example: Using ClarkeHandler with resilience pattern');
  
  // This will follow the patched code pattern
  const handler = getResilienceHandler();
  
  try {
    const result = await handler.chat([
      { role: 'user', content: 'Hello, test the resilience handler!' }
    ]);
    
    console.log('📄 Result:', {
      success: result.success,
      hasContent: !!result.content,
      fallbackUsed: !!result.fallback
    });
    
    return result;
  } catch (error) {
    console.error('❌ Example failed:', error);
    throw error;
  }
}

// Export the pattern for use throughout the application
export { genericFallback };