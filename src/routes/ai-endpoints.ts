/**
 * Core AI Endpoints - Primary Implementation
 * Handles /write, /guide, /audit, and /sim endpoints using OpenAI SDK
 * These are the main endpoints for ARCANOS AI functionality
 */

import express, { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { 
  validateAIRequest, 
  handleAIError,
  StandardAIRequest,
  StandardAIResponse,
  ErrorResponse
} from '../utils/requestHandler.js';

const router = express.Router();

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
 * Primary handler for core AI endpoints - routes through ARCANOS brain architecture
 * Uses shared validation and error handling utilities
 */
const handleAIEndpoint = async (
  req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
  res: Response<AIResponse | ErrorResponse>, 
  endpointName: string
) => {
  // Use shared validation logic
  const validation = validateAIRequest(req, res, endpointName);
  if (!validation) return; // Response already sent

  const { client: openai, input } = validation;

  try {
    // runThroughBrain enforces GPT-5 as the primary reasoning stage
    const output = await runThroughBrain(openai, input);

    return res.json({
      ...output,
      endpoint: endpointName
    });
  } catch (err) {
    handleAIError(err, input, endpointName, res);
  }
};

// Write endpoint - Primary content generation endpoint
router.post('/write', (req, res) => handleAIEndpoint(req, res, 'write'));

// Guide endpoint - Primary step-by-step guidance endpoint  
router.post('/guide', (req, res) => handleAIEndpoint(req, res, 'guide'));

// Audit endpoint - Primary analysis and evaluation endpoint
router.post('/audit', (req, res) => handleAIEndpoint(req, res, 'audit'));

// Sim endpoint - Primary simulations and modeling endpoint
router.post('/sim', (req, res) => handleAIEndpoint(req, res, 'sim'));

export default router;