/**
 * OpenAI Controller
 * 
 * Provides HTTP endpoints for direct OpenAI API interactions including
 * prompt execution and service health status reporting.
 * 
 * @module openaiController
 */

import { Request, Response } from 'express';
import {
  callOpenAI,
  getDefaultModel,
  getFallbackModel,
  getGPT5Model,
  getOpenAIServiceHealth,
  getOpenAIKeySource
} from "@services/openai.js";
import { recordTraceEvent } from '@platform/logging/telemetry.js';
import {
  getPromptRouteExecutionPolicy,
  getPromptRouteMitigationState
} from '@services/openai/promptRouteMitigation.js';
import { generateDegradedResponse } from '@transport/http/middleware/fallbackHandler.js';
import {
  classifyBudgetAbortKind,
  handleAIError,
  validateAIRequest
} from "@transport/http/requestHandler.js";
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from "@shared/types/dto.js";
import { getConfirmGateConfiguration } from "@transport/http/middleware/confirmGate.js";
import { config } from "@platform/runtime/config.js";
import { getEnv } from "@platform/runtime/env.js";
import { runWithRequestAbortTimeout, getRequestAbortSignal } from '@arcanos/runtime';

/**
 * Request type for prompt execution with optional model override.
 */
type PromptRequest = AIRequestDTO & {
  prompt: string;
  model?: string;
};

/**
 * Response type for prompt execution including model information.
 */
type PromptResponse = AIResponseDTO & {
  model?: string;
};

const PROMPT_MAX_TOKENS = config.ai.defaultMaxTokens;
const PROMPT_ROUTE_PATH = '/api/openai/prompt';
const PROMPT_ROUTE_ABORT_PROPAGATION_COVERAGE = [
  'request_abort_context',
  'prompt_route_call_openai_signal',
  'request_abort_timeout_on_abort_hook'
] as const;

function resolveAbortReasonMessage(reason: unknown): string {
  if (reason instanceof Error && typeof reason.message === 'string' && reason.message.length > 0) {
    return reason.message;
  }

  if (typeof reason === 'string' && reason.length > 0) {
    return reason;
  }

  return 'request_aborted';
}

/**
 * Handles direct OpenAI prompt execution requests.
 * Accepts a prompt string and optional model override. Validates input,
 * executes the completion, and returns the AI-generated response.
 * 
 * @param req - Express request with prompt and optional model
 * @param res - Express response for completion result
 */
export async function handlePrompt(
  req: Request<{}, PromptResponse | ErrorResponseDTO, PromptRequest>,
  res: Response<PromptResponse | ErrorResponseDTO>
): Promise<void> {
  const validation = validateAIRequest(req, res, 'prompt');
  if (!validation) return; // Response already handled (mock or error)

  const { input: prompt } = validation;
  const modelOverride = typeof req.body.model === 'string' ? req.body.model.trim() : undefined;
  const model = modelOverride && modelOverride.length > 0 ? modelOverride : getDefaultModel();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const promptRoutePolicy = getPromptRouteExecutionPolicy(PROMPT_MAX_TOKENS);

  if (promptRouteMitigation.active && promptRouteMitigation.mode === 'degraded_response') {
    const degradedResponse = generateDegradedResponse(prompt, 'prompt');
    const timestamp = Math.floor(Date.now() / 1000);
    const degradedResult =
      typeof degradedResponse.data === 'string'
        ? degradedResponse.data
        : JSON.stringify(degradedResponse.data);

    req.logger?.warn?.('prompt.route.mitigated', {
      mitigationMode: promptRouteMitigation.mode,
      mitigationReason: promptRouteMitigation.reason
    });
    recordTraceEvent('prompt_route.degraded', {
      mitigationMode: promptRouteMitigation.mode,
      mitigationReason: promptRouteMitigation.reason,
      fallbackMode: degradedResponse.fallbackMode
    });

    res.json({
      result: degradedResult,
      model: getFallbackModel(),
      meta: {
        id: `prompt_degraded_${timestamp}`,
        created: timestamp,
        tokens: undefined
      },
      activeModel: `prompt-route:${promptRouteMitigation.mode}`,
      fallbackFlag: true,
      error: 'PROMPT_ROUTE_DEGRADED_MODE',
      degradedResponse: {
        status: degradedResponse.status,
        message: degradedResponse.message,
        fallbackMode: degradedResponse.fallbackMode,
        timestamp: degradedResponse.timestamp
      }
    } as PromptResponse);
    return;
  }

  try {
    const effectiveModel = promptRoutePolicy.useFallbackModel ? getFallbackModel() : model;
    const effectiveTokenLimit = promptRoutePolicy.maxTokens ?? PROMPT_MAX_TOKENS;
    const requestAbortSignal = getRequestAbortSignal();
    const mitigationMetadata = {
      route: PROMPT_ROUTE_PATH,
      requestId: (req as Request & { requestId?: string }).requestId ?? null,
      mitigationMode: promptRoutePolicy.mode,
      bypassedSubsystems: promptRoutePolicy.bypassedSubsystems,
      abortPropagationCoverage: [...PROMPT_ROUTE_ABORT_PROPAGATION_COVERAGE]
    };

    if (promptRoutePolicy.mode === 'normal' || promptRoutePolicy.mode === 'reduced_latency') {
      req.logger?.info?.('prompt.route.policy', {
        ...mitigationMetadata,
        providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
        pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs,
        maxRetries: promptRoutePolicy.maxRetries,
        maxTokens: effectiveTokenLimit,
        targetModel: effectiveModel
      });
      recordTraceEvent('prompt_route.policy', {
        ...mitigationMetadata,
        providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
        pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs,
        maxRetries: promptRoutePolicy.maxRetries,
        maxTokens: effectiveTokenLimit,
        targetModel: effectiveModel
      });
    }

    if (promptRoutePolicy.mode === 'reduced_latency') {
      req.logger?.warn?.('prompt.route.reduced_latency', {
        ...mitigationMetadata,
        providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
        pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs,
        maxRetries: promptRoutePolicy.maxRetries,
        maxTokens: effectiveTokenLimit,
        targetModel: effectiveModel
      });
      recordTraceEvent('prompt_route.reduced_latency', {
        ...mitigationMetadata,
        providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
        pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs,
        maxRetries: promptRoutePolicy.maxRetries,
        maxTokens: effectiveTokenLimit,
        targetModel: effectiveModel
      });
    }

    const { output, model: activeModel } = await runWithRequestAbortTimeout(
      {
        timeoutMs: promptRoutePolicy.pipelineTimeoutMs,
        requestId: (req as Request & { requestId?: string }).requestId,
        parentSignal: requestAbortSignal,
        abortMessage: `prompt_route_pipeline_timeout_after_${promptRoutePolicy.pipelineTimeoutMs}ms`,
        onAbort: (reason) => {
          const abortReason = resolveAbortReasonMessage(reason);
          req.logger?.warn?.('prompt.route.abort_propagation', {
            ...mitigationMetadata,
            abortReason,
            providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
            pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs
          });
          recordTraceEvent('prompt_route.abort_propagation', {
            ...mitigationMetadata,
            abortReason,
            providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
            pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs
          });
        }
      },
      async () =>
        callOpenAI(effectiveModel, prompt, effectiveTokenLimit, true, {
          signal: getRequestAbortSignal(),
          timeoutMs: promptRoutePolicy.providerTimeoutMs ?? undefined,
          maxRetries: promptRoutePolicy.maxRetries,
          metadata: {
            ...mitigationMetadata,
            providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
            pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs
          }
        })
    );
    const timestamp = Math.floor(Date.now() / 1000);
    res.json({
      result: output,
      model: activeModel,
      meta: {
        id: `prompt_${timestamp}`,
        created: timestamp,
        tokens: undefined
      },
      activeModel,
      fallbackFlag: promptRoutePolicy.useFallbackModel
    });
  } catch (err) {
    const timeoutKind = classifyBudgetAbortKind(err);
    if (timeoutKind) {
      req.logger?.warn?.('prompt.route.timeout', {
        route: PROMPT_ROUTE_PATH,
        timeoutKind,
        mitigationMode: promptRoutePolicy.mode,
        providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
        pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs
      });
      recordTraceEvent('prompt_route.timeout', {
        route: PROMPT_ROUTE_PATH,
        timeoutKind,
        mitigationMode: promptRoutePolicy.mode,
        providerTimeoutMs: promptRoutePolicy.providerTimeoutMs,
        pipelineTimeoutMs: promptRoutePolicy.pipelineTimeoutMs
      });
    }
    handleAIError(err, prompt, 'prompt', res);
  }
}

/**
 * Returns comprehensive OpenAI service status and configuration.
 * Includes API key status, model configuration, circuit breaker state,
 * cache status, and environment details. Useful for diagnostics and monitoring.
 * 
 * @param _ - Express request (unused)
 * @param res - Express response with service status
 */
export function getOpenAIStatus(_: Request, res: Response): void {
  const health = getOpenAIServiceHealth();
  const confirmation = getConfirmGateConfiguration();
  const keySource = getOpenAIKeySource();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    openai: {
      configured: health.apiKey.configured,
      keyStatus: health.apiKey.status,
      keySource,
      defaultModel: getDefaultModel(),
      fallbackModel: getFallbackModel(),
      gpt5Model: getGPT5Model(),
      clientInitialized: health.client.initialized,
      timeout: health.client.timeout,
      baseURL: health.client.baseURL || null,
      circuitBreaker: health.circuitBreaker,
      cache: health.cache,
      lastHealthCheck: health.lastHealthCheck
    },
    confirmation,
    environment: {
      // Use config layer for env access (adapter boundary pattern)
      railwayEnvironment: getEnv('RAILWAY_ENVIRONMENT') || null,
      nodeEnv: getEnv('NODE_ENV') || 'development'
    }
  });
}
