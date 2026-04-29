/**
 * GPT Backend Sync Integration
 * Provides GPT calls with automatic backend state synchronization
 */

import { getBackendState, SystemState } from './stateManager.js';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { config } from "@platform/runtime/config.js";
import { GPT_SYNC_CONFIG } from "@platform/runtime/gptSyncConfig.js";
import { GPT_SYNC_ERRORS, GPT_SYNC_LOG_MESSAGES, GPT_SYNC_STRINGS } from "@platform/runtime/gptSyncMessages.js";
import { requireOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';

function getRequiredClient() {
  return requireOpenAIClientOrAdapter(GPT_SYNC_ERRORS.clientUnavailable).client;
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
  const client = getRequiredClient();

  const response = await runTrinityWritingPipeline({
    input: {
      prompt: [systemPrompt, userPrompt].join('\n\n'),
      moduleId: 'GPT:SYNC',
      sourceEndpoint: 'gpt-sync',
      requestedAction: 'query',
      body: {
        model,
        maxCompletionTokens: GPT_SYNC_CONFIG.maxCompletionTokens,
        temperature: GPT_SYNC_CONFIG.temperature
      },
      tokenLimit: GPT_SYNC_CONFIG.maxCompletionTokens,
      executionMode: 'request'
    },
    context: {
      client,
      runtimeBudget: createRuntimeBudget(),
      runOptions: {
        answerMode: 'direct',
        strictUserVisibleOutput: true
      }
    }
  });

  return response.result || GPT_SYNC_CONFIG.fallbackResponse;
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
