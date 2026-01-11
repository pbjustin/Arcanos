/**
 * Workers OpenAI Client
 * Uses shared client factory from main application
 * 
 * Note: This creates a symlink-like pattern where workers use the same
 * OpenAI client factory as the main application for consistency
 */

import { createLazyOpenAIClient } from '../../../../src/lib/openai-client.js';

export default createLazyOpenAIClient();
