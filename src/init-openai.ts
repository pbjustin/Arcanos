import OpenAI from 'openai';
import { Express } from 'express';

/**
 * Initializes OpenAI client and attaches it to Express app locals.
 *
 * @param app - Express application instance
 */
export function initOpenAI(app: Express): void {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  app.locals.openai = openai;
}
