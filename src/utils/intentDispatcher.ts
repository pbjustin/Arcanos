import OpenAI from 'openai';
import { routeByIntent, type IntentMode } from './routeByIntent';

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

  let model = 'gpt-4';
  switch (mode) {
    case 'audit':
      model = 'gpt-3.5-turbo';
      break;
    case 'codegen':
      model = process.env.CODEGEN_MODEL || 'gpt-4';
      break;
    case 'sim':
      model = 'gpt-4';
      break;
    case 'write':
    default:
      model = 'gpt-4';
      break;
  }

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }]
    });

    return { mode, model, response };
  } catch (error) {
    console.error('[intentDispatcher] Error dispatching prompt:', error);
    throw error;
  }
}
