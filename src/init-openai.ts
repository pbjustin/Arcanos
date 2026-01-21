import { getOpenAIClient } from './services/openai.js';
import { Express } from 'express';

/**
 * Initializes OpenAI client and attaches it to Express app locals.
 * Uses centralized OpenAI service for consistency.
 *
 * @param app - Express application instance
 */
export function initOpenAI(app: Express): void {
  const openai = getOpenAIClient();
  app.locals.openai = openai;
}
