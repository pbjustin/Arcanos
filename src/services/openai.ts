import { callOpenAI, createCentralizedCompletion, createGPT5Reasoning, createGPT5ReasoningLayer, call_gpt5_strict } from './openai/chatFlow.js';
import { generateImage } from './openai/imageGeneration.js';
import { getOpenAIServiceHealth, validateAPIKeyAtStartup } from './openai/serviceHealth.js';
import { getOrCreateClient, validateClientHealth } from '@arcanos/openai/unifiedClient';
import {
  getOpenAIKeySource,
  hasValidAPIKey,
  getDefaultModel,
  getFallbackModel,
  getComplexModel,
  getGPT5Model
} from './openai/credentialProvider.js';
import { generateMockResponse } from './openai/mock.js';
import { getCircuitBreakerSnapshot } from './openai/resilience.js';
import { createChatCompletionWithFallback } from './openai/chatFallbacks.js';
import { runStructuredReasoning } from './openai/structuredReasoning.js';

export type {
  CallOpenAIOptions,
  CallOpenAIResult,
  CallOpenAICacheEntry,
  ChatCompletionMessageParam,
  ChatCompletionResponseFormat,
  ImageSize,
  ChatCompletion,
  ChatCompletionCreateParams
} from './openai/types.js';

export {
  callOpenAI,
  createCentralizedCompletion,
  createGPT5Reasoning,
  createGPT5ReasoningLayer,
  call_gpt5_strict,
  generateImage,
  getOpenAIServiceHealth,
  validateAPIKeyAtStartup,
  runStructuredReasoning,
};

export {
  getOrCreateClient as getOpenAIClient,
  getOpenAIKeySource,
  hasValidAPIKey,
  getDefaultModel,
  getFallbackModel,
  getComplexModel,
  getGPT5Model,
  generateMockResponse,
  getCircuitBreakerSnapshot,
  validateClientHealth,
  createChatCompletionWithFallback
};

export default {
  getOpenAIClient: getOrCreateClient,
  getDefaultModel,
  getGPT5Model,
  createGPT5Reasoning,
  createGPT5ReasoningLayer,
  runStructuredReasoning,
  validateAPIKeyAtStartup,
  callOpenAI,
  call_gpt5_strict,
  generateImage,
  getOpenAIServiceHealth,
  createCentralizedCompletion,
  createChatCompletionWithFallback
};
