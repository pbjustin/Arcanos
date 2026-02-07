import type OpenAI from 'openai';
import type { OpenAIAdapter } from '../../adapters/openai.adapter.js';
import { prepareGPT5Request } from './requestTransforms.js';
import { getDefaultModel, getFallbackModel, getGPT5Model } from './credentialProvider.js';
import { RESILIENCE_CONSTANTS } from './resilience.js';
import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { formatErrorMessage } from '../../lib/errors/reusable.js';
import {
  buildFailureContext,
  buildFinalFallbackReason,
  buildGpt5AttemptLog,
  buildGpt5FallbackReason,
  buildGpt5SuccessLog,
  CHAT_FALLBACK_LOG_PREFIXES,
} from '../../config/chatFallbackMessages.js';

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

type ChatCompletionParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model'> & {
  model?: string;
  max_completion_tokens?: number;
};

type ChatCompletionResponse = OpenAI.Chat.Completions.ChatCompletion;

interface ChatCompletionWithFallback extends ChatCompletionResponse {
  activeModel: string;
  fallbackFlag: boolean;
  retryUsed?: boolean;
  fallbackReason?: string;
  gpt5Used?: boolean;
}

const getTokensFromParams = (params: ChatCompletionParams): number =>
  params.max_tokens || params.max_completion_tokens || RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS;

const executeChatCompletionRequest = async (
  clientOrAdapter: OpenAI | OpenAIAdapter,
  payload: ChatCompletionParams,
): Promise<ChatCompletionResponse> => {
  const usesAdapter = 'chat' in clientOrAdapter && typeof clientOrAdapter.chat === 'object';
  //audit Assumption: adapter shape is detectable via chat property; risk: mis-detection calls wrong client; invariant: completion request must be sent once; handling: branch on adapter presence.
  if (usesAdapter) {
    return await clientOrAdapter.chat.completions.create({
      ...payload,
      stream: false,
    }) as ChatCompletionResponse;
  }

  return await (clientOrAdapter as OpenAI).chat.completions.create({
    ...payload,
    stream: false,
  }) as ChatCompletionResponse;
};

async function attemptModelCall(
  clientOrAdapter: OpenAI | OpenAIAdapter,
  params: ChatCompletionParams,
  model: string,
  logPrefix: string,
): Promise<{ response: ChatCompletionResponse; model: string }> {
  console.log(`${logPrefix} Attempting with model: ${model}`);
  const response = await executeChatCompletionRequest(clientOrAdapter, {
    ...params,
    model,
  });
  console.log(`✅ ${logPrefix} Success with ${model}`);
  return { response, model };
}

async function attemptGPT5Call(
  clientOrAdapter: OpenAI | OpenAIAdapter,
  params: ChatCompletionParams,
  gpt5Model: string,
): Promise<{ response: ChatCompletionResponse; model: string }> {
  console.log(buildGpt5AttemptLog(gpt5Model));

  const tokenParams = getTokenParameter(gpt5Model, getTokensFromParams(params));
  const gpt5Payload = prepareGPT5Request({
    ...params,
    model: gpt5Model,
    ...tokenParams,
  });

  const response = await executeChatCompletionRequest(clientOrAdapter, gpt5Payload);
  console.log(buildGpt5SuccessLog(gpt5Model));
  return { response, model: gpt5Model };
}

/**
 * Ensure response model matches the expected model family.
 * Inputs: response (OpenAI response), expectedModel (string).
 * Outputs: actual model identifier string.
 * Edge cases: throws when response model is missing or mismatched.
 */
const ensureModelMatchesExpectation = (response: ChatCompletionResponse, expectedModel: string): string => {
  const actualModel = typeof response?.model === 'string' ? response.model.trim() : '';

  //audit Assumption: response must include model identifier; risk: downstream mismatches; invariant: non-empty model id; handling: throw explicit error.
  if (!actualModel) {
    throw new Error(`GPT-5.1 reasoning response did not include a model identifier. Expected '${expectedModel}'.`);
  }

  const normalizedActual = normalizeModelId(actualModel);
  const normalizedExpected = normalizeModelId(expectedModel);

  const matchesExpected =
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(`${normalizedExpected}-`) ||
    normalizedActual.startsWith(`${normalizedExpected}.`);

  //audit Assumption: model should match expected prefix; risk: unexpected model usage; invariant: prefix match or exact match; handling: throw explicit error.
  if (!matchesExpected) {
    throw new Error(
      `GPT-5.1 reasoning response used unexpected model '${actualModel}'. Expected model to start with '${expectedModel}'.`,
    );
  }

  return actualModel;
};

type ModelAttemptResult = { response: ChatCompletionResponse; model: string };
type ModelAttemptTransformer<T> = (result: ModelAttemptResult) => T;

const executeModelFallbacks = async <T>(
  attempts: Array<{
    label: string;
    executor: () => Promise<ModelAttemptResult>;
    transform: ModelAttemptTransformer<T>;
  }>,
  failureContext: string,
): Promise<T> => {
  let lastError: unknown;

  for (const { label, executor, transform } of attempts) {
    try {
      const result = await executor();
      return transform(result);
    } catch (error: unknown) {
      //audit Assumption: failed attempts should continue to next fallback; risk: error masking; invariant: only one attempt succeeds; handling: capture error and proceed.
      lastError = error;
      console.warn(`⚠️ ${label} Failed: ${formatErrorMessage(error)}`);
    }
  }

  console.error(`❌ ${failureContext}`);
  //audit Assumption: lastError may hold context; risk: losing root cause; invariant: thrown error includes context; handling: wrap and rethrow if possible.
  if (lastError instanceof Error) {
    throw new Error(`${failureContext}: ${formatErrorMessage(lastError)}`);
  }
  throw new Error(failureContext);
};

/**
 * Create a chat completion with multi-stage model fallbacks.
 * Inputs: clientOrAdapter (OpenAI client or adapter), params (chat completion params).
 * Outputs: completion response augmented with fallback metadata.
 * Edge cases: throws when all fallback attempts fail.
 */
export const createChatCompletionWithFallback = async (
  clientOrAdapter: OpenAI | OpenAIAdapter,
  params: ChatCompletionParams,
): Promise<ChatCompletionWithFallback> => {
  const primaryModel = params.model ?? getDefaultModel();
  const gpt5Model = getGPT5Model();
  const finalFallbackModel = getFallbackModel();

  const attempts = [
    {
      label: CHAT_FALLBACK_LOG_PREFIXES.primary,
      executor: () =>
        attemptModelCall(clientOrAdapter, params, primaryModel, CHAT_FALLBACK_LOG_PREFIXES.primary),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: false,
      }),
    },
    {
      label: CHAT_FALLBACK_LOG_PREFIXES.retry,
      executor: () =>
        attemptModelCall(clientOrAdapter, params, primaryModel, CHAT_FALLBACK_LOG_PREFIXES.retry),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: false,
        retryUsed: true,
      }),
    },
    {
      label: CHAT_FALLBACK_LOG_PREFIXES.gpt5,
      executor: () => attemptGPT5Call(clientOrAdapter, params, gpt5Model),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: true,
        fallbackReason: buildGpt5FallbackReason(primaryModel),
        gpt5Used: true,
      }),
    },
    {
      label: CHAT_FALLBACK_LOG_PREFIXES.final,
      executor: () =>
        attemptModelCall(clientOrAdapter, params, finalFallbackModel, CHAT_FALLBACK_LOG_PREFIXES.final),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: true,
        fallbackReason: buildFinalFallbackReason(primaryModel, gpt5Model),
      }),
    },
  ];

  const failureContext = buildFailureContext(primaryModel, gpt5Model, finalFallbackModel);

  return executeModelFallbacks(attempts, `${failureContext} [COMPLETE FAILURE]`);
};

export { ensureModelMatchesExpectation };
