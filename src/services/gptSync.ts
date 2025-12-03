/**
 * GPT Backend Sync Integration
 * Provides GPT calls with automatic backend state synchronization
 */

import { getBackendState, SystemState } from './stateManager.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { getOpenAIClient } from './openai.js';

import config from '../config/index.js';
import { GPT_SYNC_CONFIG } from '../config/gptSyncConfig.js';
import { GPT_SYNC_ERRORS, GPT_SYNC_LOG_MESSAGES, GPT_SYNC_STRINGS } from '../config/gptSyncMessages.js';

function getRequiredOpenAIClient() {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error(GPT_SYNC_ERRORS.clientUnavailable);
  }
  return client;
}

function logSyncInfo(message: string, data?: unknown): void {
  const formattedMessage = `${GPT_SYNC_CONFIG.logPrefix} ${message}`;

  if (typeof data !== 'undefined') {
    console.log(formattedMessage, data);
    return;
  }

  console.log(formattedMessage);
}

function logSyncError(message: string, error: unknown): void {
  console.error(`${GPT_SYNC_CONFIG.logPrefix} ${message}`, error);
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
  const tokenParams = getTokenParameter(model, GPT_SYNC_CONFIG.maxCompletionTokens);

  const response = await client.chat.completions.create({
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    ...tokenParams,
    temperature: GPT_SYNC_CONFIG.temperature
  });

  return response.choices[0]?.message?.content || GPT_SYNC_CONFIG.fallbackResponse;
}

/**
 * Ask GPT with backend state synchronization
 */
export async function askGPTWithSync(
  userPrompt: string,
  port: number = config.server.port,
  model: string = GPT_SYNC_CONFIG.defaultModel
): Promise<string> {
  try {
    // Get current backend state
    const backendState = await getBackendState(port);

    // Create system prompt with backend state
    const systemPrompt = buildSystemPrompt(backendState);

    logSyncInfo(GPT_SYNC_LOG_MESSAGES.makingCall);
    logSyncInfo(GPT_SYNC_LOG_MESSAGES.backendState, JSON.stringify(backendState, null, 2));

    // Make the GPT call
    const content = await createSyncedCompletion(systemPrompt, userPrompt, model);
    logSyncInfo(GPT_SYNC_LOG_MESSAGES.response, content);

    return content;
  } catch (error) {
    logSyncError(GPT_SYNC_LOG_MESSAGES.errorSync, error);
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
  model: string = GPT_SYNC_CONFIG.defaultModel
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
    logSyncError(GPT_SYNC_LOG_MESSAGES.errorEnhanced, error);
    throw error;
  }
}