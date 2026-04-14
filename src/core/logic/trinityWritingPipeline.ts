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

export interface TrinityWritingInput {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  sourceEndpoint: string;
  requestedAction?: string | null;
  body?: unknown;
}

export interface TrinityWritingContext {
  client: OpenAI;
  requestId?: string;
  runtimeBudget?: RuntimeBudget;
  runOptions?: Omit<TrinityRunOptions, 'sourceEndpoint'>;
}

export interface TrinityWritingPipelineRequest {
  input: TrinityWritingInput;
  context: TrinityWritingContext;
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

function resolveRequestId(params: TrinityWritingPipelineRequest): string {
  return (
    params.context.requestId?.trim() ||
    params.input.sessionId?.trim() ||
    generateRequestId('trinity')
  );
}

function readRequestedAction(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const directAction = (body as { action?: unknown }).action;
  if (typeof directAction === 'string' && directAction.trim().length > 0) {
    return directAction.trim();
  }

  const payload = (body as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const payloadAction = (payload as { action?: unknown }).action;
  return typeof payloadAction === 'string' && payloadAction.trim().length > 0
    ? payloadAction.trim()
    : null;
}

function classifyTrinityInput(params: TrinityWritingPipelineRequest): WritingPlaneInputClassification {
  return classifyWritingPlaneInput({
    body: params.input.body,
    promptText: params.input.prompt,
    requestedAction: params.input.requestedAction ?? readRequestedAction(params.input.body),
  });
}

/**
 * Execute the Trinity pipeline from the writing plane only.
 * Inputs/outputs: normalized writing input plus execution context -> structured TrinityResult.
 * Edge cases: control-plane leakage is rejected before the low-level Trinity engine executes.
 */
export async function runTrinityWritingPipeline(
  params: TrinityWritingPipelineRequest
): Promise<TrinityResult> {
  const requestId = resolveRequestId(params);
  const sourceEndpoint = params.input.sourceEndpoint.trim();
  const classification = classifyTrinityInput(params);

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

  const prompt = params.input.prompt.trim();
  const runtimeBudget = params.context.runtimeBudget ?? createRuntimeBudget();
  const startedAt = Date.now();

  logger.info('trinity.entry', {
    module: 'trinity',
    requestId,
    sourceEndpoint,
    action: classification.action ?? 'query',
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

    logger.info('trinity.exit', {
      module: 'trinity',
      requestId,
      sourceEndpoint,
      durationMs: Date.now() - startedAt,
      activeModel: result.activeModel,
      fallbackFlag: result.fallbackFlag,
    });

    return result;
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
