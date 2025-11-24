/**
 * GPT Backend Sync Integration
 * Provides GPT calls with automatic backend state synchronization
 */

import { getBackendState, SystemState } from './stateManager.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { getOpenAIClient } from './openai.js';

import config from '../config/index.js';

const GPT_SYNC_STRINGS = {
  baseInstruction: 'You are Arcanos, a custom GPT assistant.',
  backendStateLabel: 'Always use the following backend state as the source of truth:',
  additionalContextLabel: 'Additional Context:',
  defaultTrustMessage: 'Do not rely on past memory — only trust this state for system information.',
  contextTrustMessage: 'Always use this information as your source of truth.',
  diagnosticPrompt: 'Run a system diagnostic and report the current backend state.'
} as const;

function getRequiredOpenAIClient() {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not available - API key required for GPT sync functionality');
  }
  return client;
}

function buildSystemPrompt(
  backendState: SystemState,
  options: { additionalContext?: Record<string, any>; trustMessage?: string } = {}
): string {
  const sections = [
    GPT_SYNC_STRINGS.baseInstruction,
    `${GPT_SYNC_STRINGS.backendStateLabel}\n${JSON.stringify(backendState, null, 2)}`
  ];

  if (options.additionalContext && Object.keys(options.additionalContext).length) {
    sections.push(`${GPT_SYNC_STRINGS.additionalContextLabel}\n${JSON.stringify(options.additionalContext, null, 2)}`);
  }

  sections.push(options.trustMessage ?? GPT_SYNC_STRINGS.defaultTrustMessage);

  return sections.join('\n');
}

async function createSyncedCompletion(systemPrompt: string, userPrompt: string, model: string) {
  const client = getRequiredOpenAIClient();
  const tokenParams = getTokenParameter(model, 1000);

  const response = await client.chat.completions.create({
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    ...tokenParams,
    temperature: 0.7
  });

  return response.choices[0]?.message?.content || 'No response generated';
}

/**
 * Ask GPT with backend state synchronization
 */
export async function askGPTWithSync(
  userPrompt: string,
  port: number = config.server.port,
  model: string = 'gpt-4'
): Promise<string> {
  try {
    // Get current backend state
    const backendState = await getBackendState(port);

    // Create system prompt with backend state
    const systemPrompt = buildSystemPrompt(backendState);

    console.log('[GPT-SYNC] Making GPT call with backend state');
    console.log('[GPT-SYNC] Backend state:', JSON.stringify(backendState, null, 2));

    // Make the GPT call
    const content = await createSyncedCompletion(systemPrompt, userPrompt, model);
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
export async function runSystemDiagnostic(port: number = config.server.port): Promise<string> {
  return await askGPTWithSync(GPT_SYNC_STRINGS.diagnosticPrompt, port);
}

/**
 * Enhanced GPT call with additional context
 */
export async function askGPTWithContext(
  userPrompt: string,
  additionalContext: Record<string, any> = {},
  port: number = config.server.port,
  model: string = 'gpt-4'
): Promise<{
  response: string;
  backendState: SystemState;
  context: Record<string, any>;
}> {
  try {
    const backendState = await getBackendState(port);
    const systemPrompt = buildSystemPrompt(backendState, {
      additionalContext,
      trustMessage: GPT_SYNC_STRINGS.contextTrustMessage
    });

    const content = await createSyncedCompletion(systemPrompt, userPrompt, model);

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