import { runCodexPrompt } from './ai-service-consolidated';

export async function handleCodexPrompt(payload: any): Promise<any> {
  const { prompt, model = 'gpt-4' } = payload || {};
  if (!prompt) {
    throw new Error('prompt is required');
  }
  return await runCodexPrompt(prompt, model);
}
