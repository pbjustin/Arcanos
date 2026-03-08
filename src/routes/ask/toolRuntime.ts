import type OpenAI from 'openai';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import { shouldStoreOpenAIResponses } from '@config/openaiStore.js';
import { extractResponseOutputText } from '@arcanos/openai/responseParsing';
import { getDefaultModel } from '@services/openai.js';
import { getTokenParameter } from '@shared/tokenParameterHelper.js';

import {
  buildInitialToolLoopTranscript,
  buildToolLoopContinuationRequest,
  type ToolLoopFunctionCallOutput,
} from './toolLoop.js';
import type { AskResponse } from './types.js';

/**
 * Purpose: represent one executed tool call in a transport-safe format.
 * Inputs/outputs: callers provide a structured output payload and a human summary.
 * Edge case behavior: callers should keep `output` JSON-serializable because it is returned to the model loop.
 */
export interface ToolExecutionResult {
  output: Record<string, unknown>;
  summary: string;
}

/**
 * Purpose: capture one deterministic tool action inferred from prompt pattern matching.
 * Inputs/outputs: stores the tool name, the original match offset, and serialized arguments.
 * Edge case behavior: `rawArgs` should remain valid JSON because downstream execution parses it through the same tool boundary as model calls.
 */
export interface DeterministicToolOperation<TToolName extends string = string> {
  toolName: TToolName;
  matchIndex: number;
  rawArgs: string;
}

interface ChatCompletionToolCall {
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ResponsesFunctionCall {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

interface RunAskToolModeOptions<TToolName extends string = string> {
  client: OpenAI;
  prompt: string;
  instructions: string;
  moduleName: string;
  responseIdPrefix: string;
  chatCompletionTools: unknown[];
  responsesTools: Array<Record<string, unknown>>;
  executeTool: (toolName: TToolName, rawArgs: string) => Promise<ToolExecutionResult>;
  maxOutputTokens?: number;
  maxTurns?: number;
}

type ToolCapableResponsesApi = {
  create: (payload: ResponseCreateParamsNonStreaming) => Promise<unknown>;
};

type ToolCapableChatCompletionsApi = {
  create: (payload: Record<string, unknown>) => Promise<unknown>;
};

function resolveOutputTokenConfig(
  fallbackLimit: number,
): { tokenParams: Record<string, unknown>; maxOutputTokens: number; model: string } {
  const model = getDefaultModel();
  const tokenParams = getTokenParameter(model, fallbackLimit) as Record<string, unknown>;
  const outputTokenFields = tokenParams as {
    max_completion_tokens?: number;
    max_tokens?: number;
  };

  return {
    tokenParams,
    maxOutputTokens:
      outputTokenFields.max_completion_tokens ?? outputTokenFields.max_tokens ?? fallbackLimit,
    model,
  };
}

/**
 * Purpose: normalize tool-dispatch results into the shared `/ask` response envelope.
 * Inputs/outputs: accepts module metadata, raw model response, and the final user-facing text; returns an `AskResponse`.
 * Edge case behavior: missing usage, id, or created timestamps fall back to safe generated values.
 */
export function buildToolAskResponse(
  moduleName: string,
  response: unknown,
  resultText: string,
  responseIdPrefix: string,
): AskResponse {
  const typedResponse = response as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    model?: string;
    id?: string;
    created?: number;
  } | null;
  const usage = typedResponse?.usage;
  const tokens =
    usage &&
    typeof usage.prompt_tokens === 'number' &&
    typeof usage.completion_tokens === 'number' &&
    typeof usage.total_tokens === 'number'
      ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
      : undefined;

  return {
    result: resultText,
    module: moduleName,
    activeModel: typedResponse?.model,
    fallbackFlag: false,
    meta: {
      tokens,
      id: typedResponse?.id || `${responseIdPrefix}-${Date.now()}`,
      created: typeof typedResponse?.created === 'number' ? typedResponse.created : Date.now(),
    },
  };
}

/**
 * Purpose: serialize deterministic tool arguments through the same contract as model-selected tools.
 * Inputs/outputs: accepts an optional argument object and returns a JSON string with undefined values removed.
 * Edge case behavior: empty or all-undefined payloads become `{}` so downstream schema parsers still receive valid JSON.
 */
export function buildDeterministicToolArguments(args: Record<string, unknown> = {}): string {
  const sanitizedEntries = Object.entries(args).filter(([, value]) => value !== undefined);
  return JSON.stringify(Object.fromEntries(sanitizedEntries));
}

/**
 * Purpose: add one deterministic operation while preserving prompt order and idempotency.
 * Inputs/outputs: mutates the provided operation list when a new tool match is valid.
 * Edge case behavior: invalid match indexes and duplicate tool names are ignored.
 */
export function appendUniqueDeterministicOperation<TToolName extends string>(
  operations: DeterministicToolOperation<TToolName>[],
  matchIndex: number | undefined,
  toolName: TToolName,
  args: Record<string, unknown> = {},
): void {
  if (typeof matchIndex !== 'number') {
    return;
  }

  //audit Assumption: one prompt should execute each deterministic tool at most once; failure risk: duplicate mutations or repeated inspection noise; expected invariant: one inferred action per tool name; handling strategy: ignore repeated tool names after the first match.
  if (operations.some(operation => operation.toolName === toolName)) {
    return;
  }

  operations.push({
    toolName,
    matchIndex,
    rawArgs: buildDeterministicToolArguments(args),
  });
}

/**
 * Purpose: execute deterministic operations in prompt order and collapse them into one text summary.
 * Inputs/outputs: accepts inferred operations plus a tool executor and returns the combined summary or `null`.
 * Edge case behavior: empty operation lists return `null` so callers can fall through to model-based tool routing.
 */
export async function executeDeterministicToolOperations<TToolName extends string>(
  operations: DeterministicToolOperation<TToolName>[],
  executeTool: (toolName: TToolName, rawArgs: string) => Promise<ToolExecutionResult>,
): Promise<string | null> {
  if (operations.length === 0) {
    return null;
  }

  const executionSummaries: string[] = [];

  for (const operation of operations) {
    const executed = await executeTool(operation.toolName, operation.rawArgs);
    executionSummaries.push(executed.summary);
  }

  return executionSummaries.length > 0 ? executionSummaries.join(' ') : null;
}

function extractResponsesFunctionCalls(response: unknown): ResponsesFunctionCall[] {
  const typedResponse = response as { output?: unknown } | null;
  if (!Array.isArray(typedResponse?.output)) {
    return [];
  }

  return typedResponse.output.filter(
    (item: unknown): item is ResponsesFunctionCall =>
      Boolean(item) &&
      typeof item === 'object' &&
      (item as { type?: string }).type === 'function_call',
  );
}

function buildSuccessfulToolLoopOutput(executed: ToolExecutionResult): ToolLoopFunctionCallOutput['output'] {
  return JSON.stringify({
    ok: true,
    ...executed.output,
  });
}

function buildFailedToolLoopOutput(error: unknown): ToolLoopFunctionCallOutput['output'] {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Purpose: run the shared OpenAI tool-dispatch loop for `/ask` tool modules.
 * Inputs/outputs: accepts prompt/tool metadata plus an executor and returns an `AskResponse` or `null` when no tool path applies.
 * Edge case behavior: falls back to stateless transcript replay when OpenAI response storage is disabled, and returns `null` on empty final text so the caller can continue normal ask routing.
 */
export async function runAskToolMode<TToolName extends string>({
  client,
  prompt,
  instructions,
  moduleName,
  responseIdPrefix,
  chatCompletionTools,
  responsesTools,
  executeTool,
  maxOutputTokens: fallbackOutputTokens = 512,
  maxTurns = 8,
}: RunAskToolModeOptions<TToolName>): Promise<AskResponse | null> {
  const { model, tokenParams, maxOutputTokens } = resolveOutputTokenConfig(fallbackOutputTokens);
  const responsesApi = (client as unknown as { responses?: Partial<ToolCapableResponsesApi> }).responses;
  const chatCompletionsApi = (client as unknown as {
    chat?: { completions?: Partial<ToolCapableChatCompletionsApi> };
  }).chat?.completions;
  //audit Assumption: OpenAI SDK resource methods depend on their owning resource as `this`; failure risk: extracting `.create` and calling it unbound throws `Cannot read properties of undefined (reading '_client')`; expected invariant: tool-runtime calls preserve SDK method context; handling strategy: bind both create methods to their original resource objects before invocation.
  const responsesCreate =
    typeof responsesApi?.create === 'function' ? responsesApi.create.bind(responsesApi) : null;
  const chatCompletionsCreate =
    typeof chatCompletionsApi?.create === 'function'
      ? chatCompletionsApi.create.bind(chatCompletionsApi)
      : null;

  //audit Assumption: tool dispatch needs at least one OpenAI surface that can select tools; failure risk: prompts silently bypass tool routing; expected invariant: Responses or Chat Completions is available; handling strategy: throw an explicit capability error.
  if (!responsesCreate && !chatCompletionsCreate) {
    throw new Error('OpenAI client does not expose responses.create or chat.completions.create');
  }

  if (!responsesCreate && chatCompletionsCreate) {
    const response = await chatCompletionsCreate({
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: prompt },
      ],
      tools: chatCompletionTools,
      tool_choice: 'auto',
      ...tokenParams,
    });

    const toolCalls: ChatCompletionToolCall[] =
      (response as { choices?: Array<{ message?: { tool_calls?: ChatCompletionToolCall[] } }> }).choices?.[0]?.message
        ?.tool_calls ?? [];
    if (!toolCalls.length) {
      return null;
    }

    const executionSummaries: string[] = [];

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function' || !toolCall.function?.name) {
        continue;
      }

      const executed = await executeTool(
        toolCall.function.name as TToolName,
        toolCall.function.arguments || '{}',
      );
      executionSummaries.push(executed.summary);
    }

    return buildToolAskResponse(
      moduleName,
      response,
      executionSummaries.join(' '),
      responseIdPrefix,
    );
  }

  if (!responsesCreate) {
    throw new Error('OpenAI client does not expose responses.create');
  }

  const storeResponses = shouldStoreOpenAIResponses();
  let toolLoopTranscript: ResponseInputItem[] = buildInitialToolLoopTranscript(prompt);
  let response = await responsesCreate({
    model,
    store: storeResponses,
    instructions,
    input: toolLoopTranscript,
    tools: responsesTools as unknown as ResponseCreateParamsNonStreaming['tools'],
    tool_choice: 'auto',
    max_output_tokens: maxOutputTokens,
  });
  let lastText = extractResponseOutputText(response, '');
  const executionSummaries: string[] = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const toolCalls = extractResponsesFunctionCalls(response);

    if (!toolCalls.length) {
      if (!lastText || lastText.trim().length === 0) {
        const summaryText = executionSummaries.join(' ');
        return summaryText
          ? buildToolAskResponse(moduleName, response, summaryText, responseIdPrefix)
          : null;
      }

      return buildToolAskResponse(moduleName, response, lastText, responseIdPrefix);
    }

    const functionCallOutputs: ToolLoopFunctionCallOutput[] = [];

    for (const toolCall of toolCalls) {
      const toolName = typeof toolCall.name === 'string' ? toolCall.name : '';
      const callId = typeof toolCall.call_id === 'string' ? toolCall.call_id : '';
      if (!toolName || !callId) {
        continue;
      }

      try {
        const executed = await executeTool(toolName as TToolName, toolCall.arguments || '{}');
        executionSummaries.push(executed.summary);
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: buildSuccessfulToolLoopOutput(executed),
        });
      } catch (error: unknown) {
        //audit Assumption: tool execution failures should stay visible to the model loop; failure risk: silent retries or confused final answers; expected invariant: each failed call returns structured error output; handling strategy: serialize the error into the function_call_output payload.
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: buildFailedToolLoopOutput(error),
        });
      }
    }

    const continuationRequest = buildToolLoopContinuationRequest({
      instructions,
      maxOutputTokens,
      model,
      previousResponse: response as { id?: string | null; output?: unknown },
      storeResponses,
      tools: responsesTools,
      transcript: toolLoopTranscript,
      functionCallOutputs,
    });
    toolLoopTranscript = continuationRequest.nextTranscript;
    response = await responsesCreate(continuationRequest.request);
    lastText = extractResponseOutputText(response, lastText);
  }

  return executionSummaries.length > 0
    ? buildToolAskResponse(moduleName, response, executionSummaries.join(' '), responseIdPrefix)
    : null;
}
