import type OpenAI from 'openai';
import type { OpenAIAdapter } from '../../adapters/openai.adapter.js';
import { prepareGPT5Request } from './requestTransforms.js';
import { getDefaultModel, getFallbackModel, getGPT5Model } from './credentialProvider.js';
import { RESILIENCE_CONSTANTS } from './resilience.js';
import { getTokenParameter } from '../../utils/tokenParameterHelper.js';
import { formatErrorMessage } from '../../lib/errors/reusable.js';

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

type ChatCompletionParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model'> & {
  model?: string;
  max_completion_tokens?: number | null;
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

async function attemptModelCall(
  clientOrAdapter: OpenAI | OpenAIAdapter,
  params: ChatCompletionParams,
  model: string,
  logPrefix: string,
): Promise<{ response: ChatCompletionResponse; model: string }> {
  console.log(`${logPrefix} Attempting with model: ${model}`);
  // Support both adapter and legacy client
  const payload = ({ ...(params as any), model, stream: false } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
  const response = 'chat' in clientOrAdapter && typeof clientOrAdapter.chat === 'object'
    ? await clientOrAdapter.chat.completions.create(payload) as ChatCompletionResponse
    : await (clientOrAdapter as OpenAI).chat.completions.create(payload) as ChatCompletionResponse;
  console.log(`✅ ${logPrefix} Success with ${model}`);
  return { response, model };
}

async function attemptGPT5Call(
  clientOrAdapter: OpenAI | OpenAIAdapter,
  params: ChatCompletionParams,
  gpt5Model: string,
): Promise<{ response: ChatCompletionResponse; model: string }> {
  console.log(`🚀 [GPT-5.1 FALLBACK] Attempting with GPT-5.1: ${gpt5Model}`);

  const tokenParams = getTokenParameter(gpt5Model, getTokensFromParams(params));
  const gpt5Payload = prepareGPT5Request({
    ...params,
    model: gpt5Model,
    ...tokenParams,
  });

  // Support both adapter and legacy client
  const payload = ({ ...(gpt5Payload as any), stream: false } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
  const response = 'chat' in clientOrAdapter && typeof clientOrAdapter.chat === 'object'
    ? await clientOrAdapter.chat.completions.create(payload) as ChatCompletionResponse
    : await (clientOrAdapter as OpenAI).chat.completions.create(payload) as ChatCompletionResponse;
  console.log(`✅ [GPT-5.1 FALLBACK] Success with ${gpt5Model}`);
  return { response, model: gpt5Model };
}

const ensureModelMatchesExpectation = (response: ChatCompletionResponse, expectedModel: string): string => {
  const actualModel = typeof response?.model === 'string' ? response.model.trim() : '';

  //audit Assumption: response must include model identifier
  if (!actualModel) {
    throw new Error(`GPT-5.1 reasoning response did not include a model identifier. Expected '${expectedModel}'.`);
  }

  const normalizedActual = normalizeModelId(actualModel);
  const normalizedExpected = normalizeModelId(expectedModel);

  const matchesExpected =
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(`${normalizedExpected}-`) ||
    normalizedActual.startsWith(`${normalizedExpected}.`);

  //audit Assumption: model should match expected prefix
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
      //audit Assumption: failed attempts should continue to next fallback
      lastError = error;
      console.warn(`⚠️ ${label} Failed: ${formatErrorMessage(error)}`);
    }
  }

  console.error(`❌ ${failureContext}`);
  if (lastError instanceof Error) {
    throw new Error(`${failureContext}: ${formatErrorMessage(lastError)}`);
  }
  throw new Error(failureContext);
};

export const createChatCompletionWithFallback = async (
  clientOrAdapter: OpenAI | OpenAIAdapter,
  params: ChatCompletionParams,
): Promise<ChatCompletionWithFallback> => {
  const primaryModel = params.model ?? getDefaultModel();
  const gpt5Model = getGPT5Model();
  const finalFallbackModel = getFallbackModel();

  const attempts = [
    {
      label: '🧠 [PRIMARY]',
      executor: () => attemptModelCall(clientOrAdapter, params, primaryModel, '🧠 [PRIMARY]'),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: false,
      }),
    },
    {
      label: '🔄 [RETRY]',
      executor: () => attemptModelCall(clientOrAdapter, params, primaryModel, '🔄 [RETRY]'),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: false,
        retryUsed: true,
      }),
    },
    {
      label: '🧠 [GPT-5.1 FALLBACK]',
      executor: () => attemptGPT5Call(clientOrAdapter, params, gpt5Model),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: true,
        fallbackReason: `Primary model ${primaryModel} failed twice, used GPT-5.1`,
        gpt5Used: true,
      }),
    },
    {
      label: '🛟 [FINAL FALLBACK]',
      executor: () => attemptModelCall(clientOrAdapter, params, finalFallbackModel, '🛟 [FINAL FALLBACK]'),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: true,
        fallbackReason: `All models failed: ${primaryModel} (primary), ${gpt5Model} (GPT-5.1 fallback), using final fallback`,
      }),
    },
  ];

  const failureContext = `All models failed: Primary (${primaryModel}), GPT-5.1 (${gpt5Model}), Final (${finalFallbackModel})`;

  return executeModelFallbacks(attempts, `${failureContext} [COMPLETE FAILURE]`);
};

export { ensureModelMatchesExpectation };
