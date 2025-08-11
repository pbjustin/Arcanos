/**
 * GPT Backend Sync Integration
 * Provides GPT calls with automatic backend state synchronization
 */

import OpenAI from 'openai';
import { getBackendState, SystemState } from './stateManager.js';

// Initialize OpenAI client only if API key is available
let client: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required for GPT sync functionality');
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

/**
 * Ask GPT with backend state synchronization
 */
export async function askGPTWithSync(
  userPrompt: string, 
  port: number = 3000,
  model: string = 'gpt-4'
): Promise<string> {
  try {
    // Get current backend state
    const backendState = await getBackendState(port);
    
    // Create system prompt with backend state
    const systemPrompt = `
You are Arcanos, a custom GPT assistant.
Always use the following backend state as the source of truth:
${JSON.stringify(backendState, null, 2)}
Do not rely on past memory — only trust this state for system information.
`;

    console.log('[GPT-SYNC] Making GPT call with backend state');
    console.log('[GPT-SYNC] Backend state:', JSON.stringify(backendState, null, 2));
    
    // Make the GPT call
    const response = await getOpenAIClient().chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const content = response.choices[0]?.message?.content || 'No response generated';
    console.log('[GPT-SYNC] GPT Response:', content);
    
    return content;
  } catch (error) {
    console.error('[GPT-SYNC] Error in GPT call with sync:', error);
    throw error;
  }
}

/**
 * Run system diagnostic and report backend state
 */
export async function runSystemDiagnostic(port: number = 3000): Promise<string> {
  const diagnosticPrompt = "Run a system diagnostic and report the current backend state.";
  return await askGPTWithSync(diagnosticPrompt, port);
}

/**
 * Enhanced GPT call with additional context
 */
export async function askGPTWithContext(
  userPrompt: string,
  additionalContext: Record<string, any> = {},
  port: number = 3000,
  model: string = 'gpt-4'
): Promise<{
  response: string;
  backendState: SystemState;
  context: Record<string, any>;
}> {
  try {
    const backendState = await getBackendState(port);
    
    const systemPrompt = `
You are Arcanos, a custom GPT assistant.
Backend State: ${JSON.stringify(backendState, null, 2)}
Additional Context: ${JSON.stringify(additionalContext, null, 2)}
Always use this information as your source of truth.
`;

    const response = await getOpenAIClient().chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const content = response.choices[0]?.message?.content || 'No response generated';
    
    return {
      response: content,
      backendState,
      context: additionalContext
    };
  } catch (error) {
    console.error('[GPT-SYNC] Error in enhanced GPT call:', error);
    throw error;
  }
}