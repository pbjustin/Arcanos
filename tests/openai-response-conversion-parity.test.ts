import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';

import {
  OPENAI_CONVERSION_FROZEN_NOW_MS,
  OPENAI_CONVERSION_REQUESTED_MODEL,
  invalidOpenAIResponseRoots,
  openAIResponseConversionFixtures,
  type OpenAIResponseConversionFixture
} from './fixtures/openai-response-conversion.js';

const coreResponsesCreateMock = jest.fn();
const coreChatCreateMock = jest.fn();
const coreResponsesParseMock = jest.fn();
const coreEmbeddingsCreateMock = jest.fn();
const coreImagesGenerateMock = jest.fn();
const coreTranscriptionsCreateMock = jest.fn();
const openAIConstructorMock = jest.fn();

const workerResponsesCreateMock = jest.fn();
const workerEmbeddingsCreateMock = jest.fn();
const createOpenAIClientMock = jest.fn();
const retryWithBackoffMock = jest.fn();

const recordDependencyCallMock = jest.fn();
const assertAiBudgetAllowsCallMock = jest.fn();
const getAiExecutionContextMock = jest.fn();
const recordAiOperationResultMock = jest.fn();
const recordJobEventMock = jest.fn();

let createOpenAIAdapter:
  typeof import('../src/core/adapters/openai.adapter.js').createOpenAIAdapter;
let resetOpenAIAdapter:
  typeof import('../src/core/adapters/openai.adapter.js').resetOpenAIAdapter;
let convertServiceResponse:
  typeof import('../src/services/openai/requestBuilders/convert.js').convertResponseToLegacyChatCompletion;
let createWorkerOpenAIAdapter:
  typeof import('../workers/src/infrastructure/sdk/openai.js').createWorkerOpenAIAdapter;
let resetWorkerOpenAIAdapter:
  typeof import('../workers/src/infrastructure/sdk/openai.js').resetWorkerOpenAIAdapter;

const originalEnvironment = { ...process.env };

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnvironment);
}

function configureMockImplementations(): void {
  openAIConstructorMock.mockImplementation(() => ({
    chat: { completions: { create: coreChatCreateMock } },
    responses: {
      create: coreResponsesCreateMock,
      parse: coreResponsesParseMock
    },
    embeddings: { create: coreEmbeddingsCreateMock },
    images: { generate: coreImagesGenerateMock },
    audio: { transcriptions: { create: coreTranscriptionsCreateMock } },
    models: { retrieve: jest.fn() },
    beta: {
      assistants: { list: jest.fn() },
      threads: {
        create: jest.fn(),
        runs: { create: jest.fn() }
      }
    }
  }));

  createOpenAIClientMock.mockImplementation(() => ({
    responses: { create: workerResponsesCreateMock },
    embeddings: { create: workerEmbeddingsCreateMock }
  }));

  retryWithBackoffMock.mockImplementation(
    async (callback: (attempt: number) => Promise<unknown>) => callback(1)
  );
  getAiExecutionContextMock.mockReturnValue(null);
}

function buildCompletionExpectation(
  fixture: OpenAIResponseConversionFixture,
  id: string
): Record<string, unknown> {
  const expected = fixture.expected;
  const message = {
    role: 'assistant',
    content: expected.content,
    refusal: expected.refusal,
    ...(expected.toolCalls.length > 0
      ? { tool_calls: [...expected.toolCalls] }
      : {})
  };

  return {
    id,
    object: 'chat.completion',
    created: expected.created,
    model: expected.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: expected.finishReason,
        logprobs: null
      }
    ],
    usage: expected.usage,
    provider_metadata: {
      provider: 'openai',
      api: 'responses',
      status: expected.status,
      incomplete_details: expected.incompleteDetails,
      usage: expected.providerUsage,
      finish_reason: expected.finishReason,
      incomplete: expected.incomplete,
      truncated: expected.truncated,
      length_truncated: expected.truncated,
      content_filtered: expected.contentFiltered
    },
    response_status: expected.status,
    incomplete_details: expected.incompleteDetails,
    incomplete: expected.incomplete,
    truncated: expected.truncated,
    length_truncated: expected.truncated,
    content_filtered: expected.contentFiltered
  };
}

function buildCoreServiceExpectation(fixture: OpenAIResponseConversionFixture): Record<string, unknown> {
  return buildCompletionExpectation(fixture, fixture.expected.id);
}

function buildWorkerExpectation(fixture: OpenAIResponseConversionFixture): Record<string, unknown> {
  return buildCompletionExpectation(fixture, fixture.expected.workerId);
}

async function convertThroughCore(response: unknown): Promise<unknown> {
  coreResponsesCreateMock.mockResolvedValueOnce(response);
  const adapter = createOpenAIAdapter({ apiKey: 'core-parity-test-key' });

  return adapter.chat.completions.create({
    model: OPENAI_CONVERSION_REQUESTED_MODEL,
    messages: [{ role: 'user', content: 'characterize response conversion' }]
  } as never);
}

async function convertThroughWorker(response: unknown): Promise<unknown> {
  workerResponsesCreateMock.mockResolvedValueOnce(response);
  const adapter = createWorkerOpenAIAdapter();

  return adapter.chat.completions.create({
    model: OPENAI_CONVERSION_REQUESTED_MODEL,
    messages: [{ role: 'user', content: 'characterize response conversion' }]
  } as never);
}

beforeAll(async () => {
  jest.resetModules();

  jest.unstable_mockModule('openai', () => ({
    default: openAIConstructorMock
  }));
  jest.unstable_mockModule('@arcanos/openai/client', () => ({
    createOpenAIClient: createOpenAIClientMock
  }));
  jest.unstable_mockModule('@arcanos/openai/retry', () => ({
    retryWithBackoff: retryWithBackoffMock
  }));
  jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
    recordDependencyCall: recordDependencyCallMock
  }));
  jest.unstable_mockModule('@services/openai/aiExecutionContext.js', () => ({
    assertAiBudgetAllowsCall: assertAiBudgetAllowsCallMock,
    getAiExecutionContext: getAiExecutionContextMock,
    recordAiOperationResult: recordAiOperationResultMock
  }));
  jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({
    recordJobEvent: recordJobEventMock
  }));

  ({
    createOpenAIAdapter,
    resetOpenAIAdapter
  } = await import('../src/core/adapters/openai.adapter.js'));
  ({
    convertResponseToLegacyChatCompletion: convertServiceResponse
  } = await import('../src/services/openai/requestBuilders/convert.js'));
  ({
    createWorkerOpenAIAdapter,
    resetWorkerOpenAIAdapter
  } = await import('../workers/src/infrastructure/sdk/openai.js'));
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(OPENAI_CONVERSION_FROZEN_NOW_MS);
  process.env.OPENAI_API_KEY = 'worker-parity-test-key';

  jest.clearAllMocks();
  configureMockImplementations();
  resetOpenAIAdapter();
  resetWorkerOpenAIAdapter();
});

afterEach(() => {
  resetOpenAIAdapter();
  resetWorkerOpenAIAdapter();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  restoreEnvironment();
});

afterAll(() => {
  restoreEnvironment();
  jest.resetModules();
});

describe('OpenAI Responses to ChatCompletion conversion parity', () => {
  const completionFixtures = openAIResponseConversionFixtures.filter(
    (fixture) => fixture.expected.conversionError === undefined
  );
  const conversionErrorFixtures = openAIResponseConversionFixtures.filter(
    (fixture) => fixture.expected.conversionError !== undefined
  );

  it.each(completionFixtures)(
    '$name preserves the shared provider contract',
    async (fixture) => {
      const serviceResult = convertServiceResponse(
        fixture.response as never,
        OPENAI_CONVERSION_REQUESTED_MODEL
      );
      const coreResult = await convertThroughCore(fixture.response);
      const workerResult = await convertThroughWorker(fixture.response);

      expect(serviceResult).toEqual(buildCoreServiceExpectation(fixture));
      expect(coreResult).toEqual(buildCoreServiceExpectation(fixture));
      expect(coreResult).toEqual(serviceResult);
      expect(workerResult).toEqual(buildWorkerExpectation(fixture));

      expect(Object.hasOwn(serviceResult, 'provider_metadata')).toBe(true);
      expect(Object.hasOwn(workerResult as object, 'provider_metadata')).toBe(true);
      expect(Object.hasOwn(serviceResult.choices[0]?.message ?? {}, 'refusal')).toBe(true);
      expect(
        Object.hasOwn(
          (workerResult as { choices: Array<{ message: object }> }).choices[0]?.message ?? {},
          'refusal'
        )
      ).toBe(true);

      for (const result of [serviceResult, coreResult, workerResult] as Array<{
        choices: Array<{
          finish_reason: string;
          message: {
            tool_calls?: unknown[];
          };
        }>;
      }>) {
        const choice = result.choices[0];
        const hasToolCalls = Array.isArray(choice?.message.tool_calls)
          && choice.message.tool_calls.length > 0;
        expect(choice?.finish_reason === 'tool_calls').toBe(hasToolCalls);
      }

      expect(coreResponsesCreateMock).toHaveBeenCalledTimes(1);
      expect(workerResponsesCreateMock).toHaveBeenCalledTimes(1);
      expect(retryWithBackoffMock).toHaveBeenCalledTimes(1);
      expect(coreChatCreateMock).not.toHaveBeenCalled();
    }
  );

  it.each(conversionErrorFixtures)(
    '$name rejects a non-convertible provider outcome through all three seams',
    async (fixture) => {
      const expectedError = fixture.expected.conversionError;
      if (!expectedError) {
        throw new Error(`Missing conversion error expectation for ${fixture.name}`);
      }

      let serviceError: unknown;
      try {
        convertServiceResponse(
          fixture.response as never,
          OPENAI_CONVERSION_REQUESTED_MODEL
        );
      } catch (error) {
        serviceError = error;
      }

      expect(serviceError).toMatchObject(expectedError);
      await expect(convertThroughCore(fixture.response)).rejects.toMatchObject(expectedError);
      await expect(convertThroughWorker(fixture.response)).rejects.toMatchObject(expectedError);

      expect(coreResponsesCreateMock).toHaveBeenCalledTimes(1);
      expect(workerResponsesCreateMock).toHaveBeenCalledTimes(1);
      expect(retryWithBackoffMock).toHaveBeenCalledTimes(1);
      expect(coreChatCreateMock).not.toHaveBeenCalled();
    }
  );

  it.each(invalidOpenAIResponseRoots)(
    '$name throws through all three existing public seams',
    async ({ response }) => {
      expect(() =>
        convertServiceResponse(response as never, OPENAI_CONVERSION_REQUESTED_MODEL)
      ).toThrow(TypeError);
      await expect(convertThroughCore(response)).rejects.toBeInstanceOf(TypeError);
      await expect(convertThroughWorker(response)).rejects.toBeInstanceOf(TypeError);
    }
  );
});
