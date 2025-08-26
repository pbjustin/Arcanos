/**
 * Modular OpenAI Client for ARCANOS Router
 * Provides a clean interface for OpenAI operations used by the routing system
 */

import { getOpenAIClient } from '../services/openai.js';

/**
 * Re-export the OpenAI client instance for use by router
 * This maintains the existing initialization and configuration logic
 */
export const openai = getOpenAIClient();

/**
 * Export default for convenience
 */
export default openai;