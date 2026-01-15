/**
 * OpenAI Service Log Messages
 * Centralized configuration for OpenAI service logging
 */

export const OPENAI_LOG_MESSAGES = {
  REQUEST: {
    ATTEMPT: (attempt: number, maxRetries: number, model: string) => 
      `🤖 OpenAI request (attempt ${attempt}/${maxRetries}) - Model: ${model}`,
    SUCCESS: '✅ OpenAI request succeeded',
    FAILED_PERMANENT: (attempts: number) => 
      `❌ OpenAI request failed permanently after ${attempts} attempts`,
    RETRY: '🔄 Retrying OpenAI request',
    FAILED_ATTEMPT: (attempt: number, maxRetries: number, errorType: string) => 
      `⚠️ OpenAI request failed (attempt ${attempt}/${maxRetries}, type: ${errorType})`
  },
  CACHE: {
    HIT: '💾 Cache hit for OpenAI request'
  },
  GPT5: {
    REASONING_START: (model: string) => `🚀 [GPT-5.2 REASONING] Using model`,
    REASONING_SUCCESS: '✅ [GPT-5.2 REASONING] Success',
    REASONING_ERROR: '❌ [GPT-5.2 REASONING] Error',
    LAYER_REFINING: '🔄 [GPT-5.2 LAYER] Refining ARCANOS response',
    LAYER_SUCCESS: '✅ [GPT-5.2 LAYER] Successfully refined response',
    LAYER_ERROR: '❌ [GPT-5.2 LAYER] Reasoning layer failed',
    STRICT_CALL: '🎯 [GPT-5.2 STRICT] Making strict call',
    STRICT_SUCCESS: (model: string) => `✅ [GPT-5.2 STRICT] Success with model`
  },
  IMAGE: {
    PROMPT_GENERATION_ERROR: '❌ Failed to generate prompt via fine-tuned model',
    GENERATION_ERROR: '❌ OpenAI image generation failed'
  },
  ARCANOS: {
    ROUTING_PREFIX: '🎯',
    COMPLETION_SUCCESS: '✅ ARCANOS completion successful',
    STREAMING_START: '✅ ARCANOS streaming completion started',
    COMPLETION_ERROR: '❌ ARCANOS completion failed'
  }
} as const;
