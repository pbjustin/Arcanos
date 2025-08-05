import { getUnifiedOpenAI } from './unified-openai.js';

export async function handleCodexPrompt(payload: any): Promise<any> {
  const { prompt, model = 'gpt-4' } = payload || {};
  if (!prompt) {
    throw new Error('prompt is required');
  }
  
  const openaiService = getUnifiedOpenAI();
  return await openaiService.runPrompt(prompt, model, 0.2);
}
