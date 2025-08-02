import OpenAI from 'openai';
import { routeByIntent, type IntentMode } from './routeByIntent';
import { callArcanosModel } from '../config/ai-model';

// Initialize OpenAI client with API key from environment
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface DispatchResult {
  mode: IntentMode;
  model: string;
  response: any;
}

/**
 * Determine mode using `routeByIntent` and dispatch to the appropriate model.
 * Logs the decision path and surfaces any errors.
 */
export async function intentDispatcher(prompt: string): Promise<DispatchResult> {
  const mode = routeByIntent(prompt);
  console.log(`[intentDispatcher] Routing prompt to mode: ${mode}`);

  try {
    const response = await callArcanosModel(openai, {
      messages: [{ role: 'user', content: prompt }]
    });

    return { mode, model: 'arcanos-v2', response };
  } catch (error) {
    console.error('[intentDispatcher] Error dispatching prompt:', error);
    throw error;
  }
}
