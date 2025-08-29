/**
 * AI Controller - Business logic for AI endpoints
 * Handles route logic for /write, /guide, /audit, and /sim endpoints
 */

import { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { 
  validateAIRequest, 
  handleAIError,
  StandardAIRequest,
  StandardAIResponse,
  ErrorResponse
} from '../utils/requestHandler.js';

interface AIRequest extends StandardAIRequest {
  prompt?: string;
  userInput?: string;
  content?: string;
  text?: string;
}

interface AIResponse extends StandardAIResponse {
  endpoint: string;
  module: string;
  routingStages?: string[];
  gpt5Used?: boolean;
}

/**
 * Base AI endpoint controller
 */
export class AIController {
  /**
   * Handle AI processing requests for core endpoints
   */
  static async processAIRequest(
    req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
    res: Response<AIResponse | ErrorResponse>, 
    endpointName: string
  ): Promise<void> {
    // Use shared validation logic
    const validation = validateAIRequest(req, res, endpointName);
    if (!validation) return; // Response already sent

    const { client: openai, input } = validation;

    try {
      // runThroughBrain enforces GPT-5 as the primary reasoning stage
      const output = await runThroughBrain(openai, input);

      res.json({
        ...output,
        endpoint: endpointName
      });
    } catch (err) {
      handleAIError(err, input, endpointName, res);
    }
  }

  /**
   * Write endpoint controller - Content generation
   */
  static async write(
    req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
    res: Response<AIResponse | ErrorResponse>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'write');
  }

  /**
   * Guide endpoint controller - Step-by-step guidance
   */
  static async guide(
    req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
    res: Response<AIResponse | ErrorResponse>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'guide');
  }

  /**
   * Audit endpoint controller - Analysis and evaluation
   */
  static async audit(
    req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
    res: Response<AIResponse | ErrorResponse>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'audit');
  }

  /**
   * Sim endpoint controller - Simulations and modeling
   */
  static async sim(
    req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
    res: Response<AIResponse | ErrorResponse>
  ): Promise<void> {
    await AIController.processAIRequest(req, res, 'sim');
  }
}

export default AIController;