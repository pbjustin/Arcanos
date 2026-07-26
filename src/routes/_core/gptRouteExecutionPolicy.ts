import { GPT_QUERY_ACTION } from '@shared/gpt/gptJobResult.js';

export type GptExecutionMode = 'sync' | 'async';

export interface GptExecutionPlan {
  mode: GptExecutionMode;
  reason: string;
  promptLength: number;
  messageCount: number;
  answerMode: string | null;
  maxWords: number | null;
  heavyPrompt: boolean;
}

export interface GptRouteExecutionPolicyInput {
  explicitExecutionMode: GptExecutionMode | null;
  requestedAction: string | null;
  promptPresent: boolean;
  promptLength: number;
  messageCount: number;
  answerMode: string | null;
  maxWords: number | null;
  heavyPrompt: boolean;
  directModuleQuery: boolean;
  coreGpt: boolean;
  coreQueryAsyncDefault: boolean;
}

/**
 * Classify the route execution mode from already-derived request facts.
 *
 * Request parsing, environment reads, and all execution side effects remain in
 * the HTTP router. Branch order here is part of the public routing contract.
 */
export function classifyGptRouteExecution(
  input: GptRouteExecutionPolicyInput
): GptExecutionPlan {
  if (input.explicitExecutionMode) {
    return {
      mode: input.explicitExecutionMode,
      reason: `explicit_${input.explicitExecutionMode}_request`,
      promptLength: input.promptLength,
      messageCount: input.messageCount,
      answerMode: input.answerMode,
      maxWords: input.maxWords,
      heavyPrompt: input.heavyPrompt,
    };
  }

  if (input.requestedAction === 'diagnostics') {
    return {
      mode: 'sync',
      reason: 'diagnostics_request',
      promptLength: input.promptLength,
      messageCount: input.messageCount,
      answerMode: input.answerMode,
      maxWords: input.maxWords,
      heavyPrompt: false,
    };
  }

  if (
    !input.promptPresent
    && (!input.requestedAction || input.requestedAction === GPT_QUERY_ACTION)
  ) {
    return {
      mode: 'sync',
      reason: 'missing_prompt_validation',
      promptLength: input.promptLength,
      messageCount: input.messageCount,
      answerMode: input.answerMode,
      maxWords: input.maxWords,
      heavyPrompt: false,
    };
  }

  if (input.requestedAction === GPT_QUERY_ACTION) {
    if (input.directModuleQuery) {
      return {
        mode: 'sync',
        reason: 'explicit_module_query_action',
        promptLength: input.promptLength,
        messageCount: input.messageCount,
        answerMode: input.answerMode,
        maxWords: input.maxWords,
        heavyPrompt: false,
      };
    }

    if (input.coreGpt) {
      if (input.coreQueryAsyncDefault) {
        return {
          mode: 'async',
          reason: 'explicit_query_action',
          promptLength: input.promptLength,
          messageCount: input.messageCount,
          answerMode: input.answerMode,
          maxWords: input.maxWords,
          heavyPrompt: input.heavyPrompt,
        };
      }

      return {
        mode: 'sync',
        reason: 'explicit_core_query_action',
        promptLength: input.promptLength,
        messageCount: input.messageCount,
        answerMode: input.answerMode,
        maxWords: input.maxWords,
        heavyPrompt: false,
      };
    }

    return {
      mode: 'async',
      reason: 'explicit_query_action',
      promptLength: input.promptLength,
      messageCount: input.messageCount,
      answerMode: input.answerMode,
      maxWords: input.maxWords,
      heavyPrompt: input.heavyPrompt,
    };
  }

  if (input.coreQueryAsyncDefault) {
    return {
      mode: 'async',
      reason: 'core_query_async_default',
      promptLength: input.promptLength,
      messageCount: input.messageCount,
      answerMode: input.answerMode,
      maxWords: input.maxWords,
      heavyPrompt: true,
    };
  }

  if (input.heavyPrompt) {
    return {
      mode: 'async',
      reason: 'heavy_prompt_auto_async',
      promptLength: input.promptLength,
      messageCount: input.messageCount,
      answerMode: input.answerMode,
      maxWords: input.maxWords,
      heavyPrompt: input.heavyPrompt,
    };
  }

  return {
    mode: 'sync',
    reason: 'default_sync_path',
    promptLength: input.promptLength,
    messageCount: input.messageCount,
    answerMode: input.answerMode,
    maxWords: input.maxWords,
    heavyPrompt: false,
  };
}
