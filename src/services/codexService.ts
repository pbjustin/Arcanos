/**
 * Simplified Codex Service - Uses unified OpenAI service for consistency
 * Replaces redundant OpenAI client instantiation
 */

import { getUnifiedOpenAI } from './unified-openai';

export async function runCodexPrompt(prompt: string, model = 'gpt-4'): Promise<string> {
  try {
    const unifiedOpenAI = getUnifiedOpenAI();
    const response = await unifiedOpenAI.chat([
      { role: 'user', content: prompt }
    ], {
      model,
      temperature: 0.2,
      maxTokens: 1000
    });

    return response.success ? response.content : '❌ Codex request failed.';
  } catch (err: any) {
    console.error('Codex error:', err.message);
    return '❌ Codex request failed.';
  }
}
