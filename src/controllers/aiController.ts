/**
 * AI Controller - Business logic for AI endpoints
 * Handles route logic for /write, /guide, /audit, and /sim endpoints
 */

import { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError } from '../utils/requestHandler.js';
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';
import { harvestDatasetsFromAudit } from '../services/datasetHarvester.js';

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
    // Use shared validation logic
    const validation = validateAIRequest(req, res, endpointName);
    if (!validation) return; // Response already sent

    const { client: openai, input, body } = validation;

    try {
      // runThroughBrain enforces GPT-5.2 as the primary reasoning stage
      const output = await runThroughBrain(openai, input, body.sessionId, body.overrideAuditSafe);

      const responsePayload: AIResponse = {
        ...(output as AIResponse),
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

      res.json(responsePayload);
    } catch (err) {
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