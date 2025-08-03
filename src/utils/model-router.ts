import { aiConfig } from '../config/index.js';
import { routeByIntent } from './routeByIntent.js';

/**
 * Determine which OpenAI model should handle a prompt.
 * Defaults to the fine-tuned model but upgrades to GPT-4 for
 * simulation, audit or code generation intents.
 */
export function selectModel(prompt: string): string {
  const intent = routeByIntent(prompt);
  if (intent === 'audit' || intent === 'codegen' || intent === 'sim') {
    return 'gpt-4-turbo';
  }
  return aiConfig.fineTunedModel || 'ft:gpt-3.5-turbo';
}
