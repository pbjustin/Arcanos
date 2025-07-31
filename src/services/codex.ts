import { getUnifiedOpenAI } from './unified-openai';

export async function handleCodexPrompt(payload: any): Promise<any> {
  const { prompt, model = 'gpt-4' } = payload || {};
  if (!prompt) {
    throw new Error('prompt is required');
  }
  const unifiedOpenAI = getUnifiedOpenAI();
  return await unifiedOpenAI.runSimplePrompt(prompt, model);
}
