import type OpenAI from 'openai';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { createCentralizedCompletion } from "@services/openai.js";
import { generateRequestId } from "@shared/idGenerator.js";
import type { ModuleDef } from './moduleLoader.js';
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";

export interface SimulationRequestParameters {
  temperature?: number;
  maxTokens?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface SimulationRequestPayload {
  scenario?: string;
  context?: string;
  prompt?: string;
  message?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
  parameters?: SimulationRequestParameters;
}

export interface SimulationResultMetadata {
  model?: string;
  tokensUsed?: number;
  timestamp: string;
  simulationId: string;
}

export interface CompletedSimulationResult {
  mode: 'complete';
  scenario: string;
  result: string;
  metadata: SimulationResultMetadata;
}

export interface StreamingSimulationResult {
  mode: 'stream';
  scenario: string;
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
  metadata: SimulationResultMetadata;
}

export type SimulationExecutionResult =
  | CompletedSimulationResult
  | StreamingSimulationResult;

type CentralizedCompletionResult = Awaited<ReturnType<typeof createCentralizedCompletion>>;

function normalizeSimulationPayload(payload: unknown): SimulationRequestPayload {
  //audit Assumption: dispatcher/module callers should provide structured objects for simulation requests; failure risk: scalar payloads bypass validation and break downstream field extraction; expected invariant: simulation executor receives an object payload; handling strategy: reject non-object inputs with a structured error.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Simulation payload must be an object.');
  }

  return payload as SimulationRequestPayload;
}

function readOptionalString(
  payload: SimulationRequestPayload,
  key: keyof SimulationRequestPayload
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveScenarioText(payload: SimulationRequestPayload): string {
  for (const candidate of [
    readOptionalString(payload, 'scenario'),
    readOptionalString(payload, 'prompt'),
    readOptionalString(payload, 'message'),
    readOptionalString(payload, 'userInput'),
    readOptionalString(payload, 'content'),
    readOptionalString(payload, 'text'),
    readOptionalString(payload, 'query')
  ]) {
    if (candidate) {
      return candidate;
    }
  }

  throw new Error('Simulation request requires scenario or prompt text.');
}

function normalizeSimulationParameters(
  rawParameters: SimulationRequestPayload['parameters']
): Required<Pick<SimulationRequestParameters, 'temperature' | 'maxTokens' | 'stream'>> {
  const maxTokenCandidate =
    typeof rawParameters?.maxTokens === 'number'
      ? rawParameters.maxTokens
      : typeof rawParameters?.max_tokens === 'number'
        ? rawParameters.max_tokens
        : undefined;

  return {
    temperature:
      typeof rawParameters?.temperature === 'number' ? rawParameters.temperature : 0.8,
    maxTokens: typeof maxTokenCandidate === 'number' ? maxTokenCandidate : 2048,
    stream: rawParameters?.stream === true
  };
}

function buildSimulationPrompt(scenario: string, context?: string): string {
  return `Simulate the following scenario: ${scenario}${context ? `\n\nContext: ${context}` : ''}`;
}

function isStreamingCompletionResult(
  response: CentralizedCompletionResult
): response is AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  return !!response && typeof response === 'object' && Symbol.asyncIterator in response;
}

/**
 * Execute one simulation request using the Trinity generation facade.
 * Inputs/Outputs: simulation payload -> completed result payload or streaming result descriptor.
 * Edge cases: accepts prompt-style aliases when `scenario` is absent and throws explicit validation errors for malformed payloads.
 */
export async function executeSimulationRequest(
  payload: unknown
): Promise<SimulationExecutionResult> {
  const normalizedPayload = normalizeSimulationPayload(payload);
  const scenario = resolveScenarioText(normalizedPayload);
  const context = readOptionalString(normalizedPayload, 'context');
  const parameters = normalizeSimulationParameters(normalizedPayload.parameters);
  const metadata: SimulationResultMetadata = {
    timestamp: new Date().toISOString(),
    simulationId: generateRequestId('sim')
  };
  const exactLiteralShortcut = tryExtractExactLiteralPromptShortcut(scenario);

  //audit Assumption: explicit literal-only simulation prompts should bypass generative modeling even on the simulation endpoint; failure risk: the route prepends "Simulate..." and the model returns narrative scaffolding instead of the requested literal; expected invariant: recognized exact-literal prompts return the literal verbatim with zero token usage; handling strategy: short-circuit before provider invocation.
  if (exactLiteralShortcut) {
    return {
      mode: 'complete',
      scenario,
      result: exactLiteralShortcut.literal,
      metadata: {
        ...metadata,
        model: 'exact-literal-shortcut',
        tokensUsed: 0
      }
    };
  }

  const prompt = buildSimulationPrompt(scenario, context);

  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    throw new Error('OpenAI client unavailable for Trinity simulation.');
  }

  if (parameters.stream) {
    const response = await createCentralizedCompletion(
      [
        {
          role: 'user',
          content: prompt
        }
      ],
      {
        temperature: parameters.temperature,
        max_tokens: parameters.maxTokens,
        stream: true
      }
    );

    if (!isStreamingCompletionResult(response)) {
      throw new Error('Simulation stream requested but provider returned a non-stream response.');
    }

    return {
      mode: 'stream',
      scenario,
      stream: response,
      metadata
    };
  }

  const response = await runTrinityWritingPipeline({
    input: {
      prompt,
      moduleId: 'ARCANOS:SIM',
      sourceEndpoint: 'arcanos-sim',
      requestedAction: 'run',
      body: normalizedPayload,
      tokenLimit: parameters.maxTokens,
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

  return {
    mode: 'complete',
    scenario,
    result: response.result,
    metadata: {
      ...metadata,
      model: response.activeModel,
      tokensUsed: response.meta.tokens?.total_tokens || 0
    }
  };
}

const ArcanosSimModule: ModuleDef = {
  name: 'ARCANOS:SIM',
  description: 'Scenario modeling and simulation dispatch module backed by centralized ARCANOS routing.',
  gptIds: ['arcanos-sim', 'sim'],
  defaultTimeoutMs: 60000,
  actions: {
    async run(payload: unknown) {
      return executeSimulationRequest(payload);
    }
  }
};

export default ArcanosSimModule;
