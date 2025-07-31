import { runCodexPrompt } from './codexService';

export async function handleCodexPrompt(payload: any): Promise<any> {
  const { prompt, model = 'gpt-4' } = payload || {};
  if (!prompt) {
    throw new Error('prompt is required');
  }
  return await runCodexPrompt(prompt, model);
}
