import OpenAI from 'openai';
import { prepareGPT5Request } from './requestTransforms.js';
import { getDefaultModel, getFallbackModel, getGPT5Model } from './credentialProvider.js';
import { RESILIENCE_CONSTANTS } from './resilience.js';
import { getTokenParameter } from '../../utils/tokenParameterHelper.js';

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error';

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

const getTokensFromParams = (params: any): number =>
  params.max_tokens || params.max_completion_tokens || RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS;

async function attemptModelCall(
  client: OpenAI,
  params: any,
  model: string,
  logPrefix: string,
): Promise<{ response: any; model: string }> {
  console.log(`${logPrefix} Attempting with model: ${model}`);
  const response = await client.chat.completions.create({
    ...params,
    model,
  });
  console.log(`✅ ${logPrefix} Success with ${model}`);
  return { response, model };
}

async function attemptGPT5Call(
  client: OpenAI,
  params: any,
  gpt5Model: string,
): Promise<{ response: any; model: string }> {
  console.log(`🚀 [GPT-5.1 FALLBACK] Attempting with GPT-5.1: ${gpt5Model}`);

  const tokenParams = getTokenParameter(gpt5Model, getTokensFromParams(params));
  const gpt5Payload = prepareGPT5Request({
    ...params,
    model: gpt5Model,
    ...tokenParams,
  });

  const response = await client.chat.completions.create(gpt5Payload);
  console.log(`✅ [GPT-5.1 FALLBACK] Success with ${gpt5Model}`);
  return { response, model: gpt5Model };
}

const ensureModelMatchesExpectation = (response: any, expectedModel: string): string => {
  const actualModel = typeof response?.model === 'string' ? response.model.trim() : '';

  if (!actualModel) {
    throw new Error(`GPT-5.1 reasoning response did not include a model identifier. Expected '${expectedModel}'.`);
  }

  const normalizedActual = normalizeModelId(actualModel);
  const normalizedExpected = normalizeModelId(expectedModel);

  const matchesExpected =
    normalizedActual === normalizedExpected ||
    normalizedActual.startsWith(`${normalizedExpected}-`) ||
    normalizedActual.startsWith(`${normalizedExpected}.`);

  if (!matchesExpected) {
    throw new Error(
      `GPT-5.1 reasoning response used unexpected model '${actualModel}'. Expected model to start with '${expectedModel}'.`,
    );
  }

  return actualModel;
};

type ModelAttemptResult = { response: any; model: string };
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
    } catch (error) {
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
  client: OpenAI,
  params: any,
): Promise<any> => {
  const primaryModel = getDefaultModel();
  const gpt5Model = getGPT5Model();
  const finalFallbackModel = getFallbackModel();

  const attempts = [
    {
      label: '🧠 [PRIMARY]',
      executor: () => attemptModelCall(client, params, primaryModel, '🧠 [PRIMARY]'),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: false,
      }),
    },
    {
      label: '🔄 [RETRY]',
      executor: () => attemptModelCall(client, params, primaryModel, '🔄 [RETRY]'),
      transform: ({ response, model }: ModelAttemptResult) => ({
        ...response,
        activeModel: model,
        fallbackFlag: false,
        retryUsed: true,
      }),
    },
    {
      label: '🧠 [GPT-5.1 FALLBACK]',
      executor: () => attemptGPT5Call(client, params, gpt5Model),
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
      executor: () => attemptModelCall(client, params, finalFallbackModel, '🛟 [FINAL FALLBACK]'),
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
