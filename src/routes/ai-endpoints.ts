/**
 * Core AI Endpoints - Primary Implementation
 * Handles /write, /guide, /audit, and /sim endpoints using OpenAI SDK
 * These are the main endpoints for ARCANOS AI functionality
 */

import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runThroughBrain } from '../logic/trinity.js';

const router = express.Router();

interface AIRequest {
  prompt?: string;
  userInput?: string;
  content?: string;
  text?: string;
}

interface AIResponse {
  result: string;
  module: string;
  endpoint: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
  activeModel?: string;
  fallbackFlag?: boolean;
  routingStages?: string[];
  gpt5Used?: boolean;
  error?: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
}

// Primary handler for core AI endpoints - routes through ARCANOS brain architecture
const handleAIEndpoint = async (
  req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
  res: Response<AIResponse | ErrorResponse>, 
  endpointName: string
) => {
  console.log(`📨 /${endpointName} received`);
  
  // Extract input from various possible field names
  const input = req.body.prompt || req.body.userInput || req.body.content || req.body.text;

  if (!input || typeof input !== 'string') {
    return res.status(400).json({ 
      error: `Missing or invalid input in request body. Use 'prompt', 'userInput', 'content', or 'text' field.` 
    });
  }

  // Check if we have a valid API key
  if (!hasValidAPIKey()) {
    console.log(`🤖 Returning mock response for /${endpointName} (no API key)`);
    const mockResponse = generateMockResponse(input, endpointName);
    return res.json(mockResponse);
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log(`🤖 Returning mock response for /${endpointName} (client init failed)`);
    const mockResponse = generateMockResponse(input, endpointName);
    return res.json(mockResponse);
  }

  try {
    // runThroughBrain enforces GPT-5 as the primary reasoning stage
    const output = await runThroughBrain(openai, input);

    return res.json({
      ...output,
      endpoint: endpointName
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${endpointName} processing error:`, errorMessage);
    
    // Return mock response as fallback
    console.log(`🤖 Returning mock response for /${endpointName} (processing failed)`);
    const mockResponse = generateMockResponse(input, endpointName);
    return res.json({
      ...mockResponse,
      error: `AI service failure: ${errorMessage}`
    });
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