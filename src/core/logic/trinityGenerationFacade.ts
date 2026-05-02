import type OpenAI from 'openai';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { createRuntimeBudget, type RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import {
  classifyWritingPlaneInput,
  type WritingPlaneInputClassification,
} from '@platform/runtime/writingPlaneContract.js';
import { generateRequestId } from '@shared/idGenerator.js';

import { runThroughBrain, type TrinityResult, type TrinityRunOptions } from './trinity.js';
import { readIntentMode, resolveIntentMode } from './trinityHonesty.js';

export type TrinityGenerationMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface TrinityGenerationInput {
  prompt?: string;
  messages?: TrinityGenerationMessage[];
  gptId?: string;
  moduleId?: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  sourceEndpoint: string;
  requestedAction?: string | null;
  body?: unknown;
  tokenLimit?: number;
  outputLimit?: number;
  maxOutputTokens?: number;
  executionMode?: string;
  background?: Record<string, unknown>;
}

export interface TrinityGenerationContext {
  client: OpenAI;
  requestId?: string;
  runtimeBudget?: RuntimeBudget;
  runOptions?: Omit<TrinityRunOptions, 'sourceEndpoint'>;
}

export interface TrinityGenerationFacadeRequest {
  input: TrinityGenerationInput;
  context: TrinityGenerationContext;
}

type TrinityControlLeakClassification = Extract<
  WritingPlaneInputClassification,
  { plane: 'control' }
>;

export class TrinityControlLeakError extends Error {
  code = 'TRINITY_CONTROL_LEAK';
  classification: TrinityControlLeakClassification;
  requestId: string;
  sourceEndpoint: string;

  constructor(params: {
    classification: TrinityControlLeakClassification;
    requestId: string;
    sourceEndpoint: string;
  }) {
    super(params.classification.message);
    this.name = 'TrinityControlLeakError';
    this.classification = params.classification;
    this.requestId = params.requestId;
    this.sourceEndpoint = params.sourceEndpoint;
  }
}

function resolveRequestId(params: TrinityGenerationFacadeRequest): string {
  return (
    params.context.requestId?.trim() ||
    generateRequestId('trinity')
  );
}

function readActionAlias(record: Record<string, unknown>): string | null {
  const directAction = record.action;
  if (typeof directAction === 'string' && directAction.trim().length > 0) {
    return directAction.trim();
  }

  const operation = record.operation;
  return typeof operation === 'string' && operation.trim().length > 0
    ? operation.trim()
    : null;
}

function readRequestedAction(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const bodyRecord = body as Record<string, unknown>;
  const directAction = readActionAlias(bodyRecord);
  if (directAction) {
    return directAction;
  }

  const payload = bodyRecord.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return readActionAlias(payload as Record<string, unknown>);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const truncated = Math.trunc(value);
  return Math.max(1, truncated);
}

function serializeMessageContentPart(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }

  if (!part || typeof part !== 'object') {
    return '';
  }

  const partRecord = part as Record<string, unknown>;
  if (typeof partRecord.text === 'string') {
    return partRecord.text;
  }

  try {
    return JSON.stringify(partRecord);
  } catch {
    return String(part);
  }
}

function serializeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(serializeMessageContentPart)
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export function buildPromptFromTrinityMessages(
  messages: readonly TrinityGenerationMessage[] | undefined
): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  return messages
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'message';
      const name =
        'name' in message && typeof message.name === 'string' && message.name.trim().length > 0
          ? `:${message.name.trim()}`
          : '';
      const content = serializeMessageContent(message.content).trim();
      return content ? `[${role}${name}]\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function resolveTrinityGenerationPrompt(input: TrinityGenerationInput): string {
  const explicitPrompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (explicitPrompt) {
    return explicitPrompt;
  }

  return buildPromptFromTrinityMessages(input.messages);
}

export function classifyTrinityGenerationInput(
  params: TrinityGenerationFacadeRequest
): WritingPlaneInputClassification {
  const prompt = resolveTrinityGenerationPrompt(params.input);

  return classifyWritingPlaneInput({
    body: params.input.body,
    promptText: prompt || null,
    requestedAction: params.input.requestedAction ?? readRequestedAction(params.input.body),
  });
}

export function applyTrinityGenerationInvariant(
  result: TrinityResult,
  params: {
    sourceEndpoint: string;
    gptId?: string;
    moduleId?: string;
    requestedAction?: string | null;
    tokenLimit?: number;
    outputLimit?: number;
    maxOutputTokens?: number;
    executionMode?: string;
    background?: Record<string, unknown>;
  }
): TrinityResult {
  const tokenLimit = normalizePositiveInteger(params.tokenLimit);
  const outputLimit =
    normalizePositiveInteger(params.outputLimit) ??
    normalizePositiveInteger(params.maxOutputTokens);

  return {
    ...result,
    meta: {
      ...result.meta,
      pipeline: 'trinity',
      bypass: false,
      sourceEndpoint: params.sourceEndpoint,
      classification: 'writing',
      ...(params.gptId ? { gptId: params.gptId } : {}),
      ...(params.moduleId ? { moduleId: params.moduleId } : {}),
      ...(params.requestedAction !== undefined ? { requestedAction: params.requestedAction } : {}),
      ...(params.executionMode ? { executionMode: params.executionMode } : {}),
      ...(tokenLimit !== undefined ? { tokenLimit } : {}),
      ...(outputLimit !== undefined ? { outputLimit } : {}),
      ...(params.background ? { background: { ...params.background } } : {}),
    },
  };
}

/**
 * Canonical writing/generation facade for Trinity.
 * Inputs/outputs: normalized generation input plus execution context -> structured TrinityResult.
 * Edge cases: control-plane leakage is rejected inside the Trinity boundary before the low-level engine executes.
 */
export async function runTrinityGenerationFacade(
  params: TrinityGenerationFacadeRequest
): Promise<TrinityResult> {
  const requestId = resolveRequestId(params);
  const sourceEndpoint = params.input.sourceEndpoint.trim();
  const requestedAction = params.input.requestedAction ?? readRequestedAction(params.input.body);
  const classification = classifyTrinityGenerationInput(params);

  if (classification.plane !== 'writing') {
    logger.error('trinity.control_leak_detected', {
      module: 'trinity',
      requestId,
      sourceEndpoint,
      plane: classification.plane,
      classification: classification.kind,
      action: classification.action,
      reason: classification.reason,
      errorCode: classification.errorCode,
      canonical: classification.canonical,
    });
    throw new TrinityControlLeakError({
      classification,
      requestId,
      sourceEndpoint,
    });
  }

  const prompt = resolveTrinityGenerationPrompt(params.input);
  if (!prompt) {
    throw new Error('Trinity generation requires a non-empty prompt or messages array.');
  }

  const runtimeBudget = params.context.runtimeBudget ?? createRuntimeBudget();
  const startedAt = Date.now();
  const intentMode = resolveIntentMode(prompt, params.context.runOptions ?? {});

  logger.info('trinity.entry', {
    module: 'trinity',
    requestId,
    sourceEndpoint,
    action: classification.action ?? 'query',
    intentMode,
    promptLength: prompt.length,
  });

  try {
    const result = await runThroughBrain(
      params.context.client,
      prompt,
      params.input.sessionId,
      params.input.overrideAuditSafe,
      {
        ...(params.context.runOptions ?? {}),
        sourceEndpoint,
      },
      runtimeBudget
    );

    const output = applyTrinityGenerationInvariant(result, {
      sourceEndpoint,
      gptId: params.input.gptId,
      moduleId: params.input.moduleId,
      requestedAction,
      tokenLimit: params.input.tokenLimit,
      outputLimit: params.input.outputLimit,
      maxOutputTokens: params.input.maxOutputTokens,
      executionMode: params.input.executionMode,
      background: params.input.background,
    });

    logger.info('trinity.exit', {
      module: 'trinity',
      requestId,
      sourceEndpoint,
      durationMs: Date.now() - startedAt,
      activeModel: output.activeModel,
      fallbackFlag: output.fallbackFlag,
      intentMode: output.outputControls ? readIntentMode(output.outputControls) : intentMode,
      finishReason: output.meta.provider?.finishReason ?? 'unknown',
      responseStatus: output.meta.provider?.responseStatus ?? 'unknown',
      incompleteReason: output.meta.provider?.incompleteReason ?? 'none',
      truncated: output.meta.provider?.truncated === true,
      lengthTruncated: output.meta.provider?.lengthTruncated === true,
      usagePrompt: output.meta.tokens?.prompt_tokens ?? 0,
      usageCompletion: output.meta.tokens?.completion_tokens ?? 0,
      usageTotal: output.meta.tokens?.total_tokens ?? 0,
    });

    return output;
  } catch (error) {
    logger.error('trinity.error', {
      module: 'trinity',
      requestId,
      sourceEndpoint,
      durationMs: Date.now() - startedAt,
      error: resolveErrorMessage(error),
    });
    throw error;
  }
}
