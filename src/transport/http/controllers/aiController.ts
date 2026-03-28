/**
 * AI Controller - Business logic for AI endpoints
 * Handles route logic for /write, /guide, /audit, and /sim endpoints
 */

import { Request, Response } from 'express';
import { runThroughBrain } from "@core/logic/trinity.js";
import { validateAIRequest, handleAIError } from "@transport/http/requestHandler.js";
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from "@shared/types/dto.js";
import { harvestDatasetsFromAudit } from "@services/datasetHarvester.js";
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import { buildTrinityUserVisibleResponse } from '@shared/ask/trinityResponseSerializer.js';
import {
  extractPromptText,
  recordPromptDebugTrace,
} from '@services/promptDebugTraceService.js';

type AIRequest = AIRequestDTO & {
  prompt?: string;
  userInput?: string;
  content?: string;
  text?: string;
};

interface AIResponse extends AIResponseDTO {
  endpoint?: string;
  module?: string;
  routingStages?: string[];
  gpt5Used?: boolean;
  datasetHarvest?: ReturnType<typeof harvestDatasetsFromAudit>;
}

/**
 * Base AI endpoint controller
 */
export class AIController {
  /**
   * Handle AI processing requests for core endpoints
   */
  static async processAIRequest(
    req: Request<{}, AIResponse | ErrorResponseDTO, AIRequest>,
    res: Response<AIResponse | ErrorResponseDTO>,
    endpointName: string
  ): Promise<void> {
    const requestId = req.requestId ?? endpointName;
    const rawPrompt = extractPromptText(req.body, false) ?? '';
    recordPromptDebugTrace(requestId, 'ingress', {
      traceId: req.traceId ?? null,
      endpoint: endpointName,
      method: req.method,
      rawPrompt,
    });
    // Use shared validation logic
    const validation = validateAIRequest(req, res, endpointName);
    if (!validation) return; // Response already sent

    const { client: openai, input, body } = validation;

    try {
      // runThroughBrain enforces GPT-5.1 as the primary reasoning stage
      const runtimeBudget = createRuntimeBudget();
      const outputControlOptions = buildTrinityOutputControlOptions(body);
      recordPromptDebugTrace(requestId, 'routing', {
        traceId: req.traceId ?? null,
        endpoint: endpointName,
        method: req.method,
        rawPrompt,
        normalizedPrompt: input,
        selectedRoute: endpointName,
        selectedModule: 'trinity',
        selectedTools: [],
      });
      recordPromptDebugTrace(requestId, 'executor', {
        traceId: req.traceId ?? null,
        endpoint: endpointName,
        method: req.method,
        rawPrompt,
        normalizedPrompt: input,
        selectedRoute: endpointName,
        selectedModule: 'trinity',
        finalExecutorPayload: {
          executor: 'runThroughBrain',
          prompt: input,
          sessionId: body.sessionId ?? null,
          overrideAuditSafe: body.overrideAuditSafe ?? null,
          options: {
            sourceEndpoint: endpointName,
            ...outputControlOptions,
          },
        },
      });
      const output = await runThroughBrain(
        openai,
        input,
        body.sessionId,
        body.overrideAuditSafe,
        {
          sourceEndpoint: endpointName,
          ...outputControlOptions
        },
        runtimeBudget
      );

      const responsePayload: AIResponse = {
        ...buildTrinityUserVisibleResponse({
          trinityResult: output,
          endpoint: endpointName,
          clientContext: body.clientContext
        }),
        endpoint: endpointName
      };

      if (endpointName === 'audit' && output?.result) {
        const datasetHarvest = harvestDatasetsFromAudit(output.result, {
          sourcePrompt: input,
          sessionId: body.sessionId,
          requestId: output.taskLineage?.requestId
        });

        if (datasetHarvest.length) {
          responsePayload.datasetHarvest = datasetHarvest;
        }
      }

      recordPromptDebugTrace(requestId, 'response', {
        traceId: req.traceId ?? null,
        endpoint: endpointName,
        method: req.method,
        rawPrompt,
        normalizedPrompt: input,
        selectedRoute: endpointName,
        selectedModule: 'trinity',
        responseReturned: responsePayload,
        fallbackPathUsed: output.fallbackFlag ? 'trinity-fallback' : null,
        fallbackReason: output.fallbackSummary?.fallbackReasons?.join('; ') ?? null,
      });
      res.json(responsePayload);
    } catch (err) {
      recordPromptDebugTrace(requestId, 'fallback', {
        traceId: req.traceId ?? null,
        endpoint: endpointName,
        method: req.method,
        rawPrompt,
        fallbackPathUsed: 'error-handler',
        fallbackReason: err instanceof Error ? err.message : String(err),
      });
      handleAIError(err, input, endpointName, res);
    }
  }

  /**
   * Write endpoint controller - Content generation
   */
  static async write(
    req: Request<{}, AIResponse | ErrorResponseDTO, AIRequest>,
    res: Response<AIResponse | ErrorResponseDTO>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'write');
  }

  /**
   * Guide endpoint controller - Step-by-step guidance
   */
  static async guide(
    req: Request<{}, AIResponse | ErrorResponseDTO, AIRequest>,
    res: Response<AIResponse | ErrorResponseDTO>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'guide');
  }

  /**
   * Audit endpoint controller - Analysis and evaluation
   */
  static async audit(
    req: Request<{}, AIResponse | ErrorResponseDTO, AIRequest>,
    res: Response<AIResponse | ErrorResponseDTO>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'audit');
  }

  /**
   * Sim endpoint controller - Simulations and modeling
   */
  static async sim(
    req: Request<{}, AIResponse | ErrorResponseDTO, AIRequest>,
    res: Response<AIResponse | ErrorResponseDTO>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'sim');
  }
}

export default AIController;
