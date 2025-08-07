import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runThroughBrain } from '../logic/trinity.js';

const router = express.Router();

interface AskRequest {
  prompt: string;
}

interface AskResponse {
  result: string;
  module: string;
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
  error?: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
}

// Inject ARCANOS prompt shell before processing
const injectArcanosShell = (userPrompt: string): string => {
  return `[ARCANOS SYSTEM SHELL]
You are ARCANOS, an advanced AI system. Process the following user request with your full capabilities.

[USER REQUEST]
${userPrompt}

[RESPONSE DIRECTIVE]
Provide a comprehensive, accurate, and helpful response that directly addresses the user's needs.`;
};

// Shared handler for both ask and brain endpoints
const handleAIRequest = async (req: Request<{}, AskResponse | ErrorResponse, AskRequest>, res: Response<AskResponse | ErrorResponse>, endpointName: string) => {
  console.log(`📨 /${endpointName} received`);
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt in request body' });
  }

  // Check if we have a valid API key
  if (!hasValidAPIKey()) {
    console.log(`🤖 Returning mock response for /${endpointName} (no API key)`);
    const mockResponse = generateMockResponse(prompt, endpointName);
    return res.json(mockResponse);
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log(`🤖 Returning mock response for /${endpointName} (client init failed)`);
    const mockResponse = generateMockResponse(prompt, endpointName);
    return res.json(mockResponse);
  }

  try {
    // Inject ARCANOS shell before processing
    const wrappedPrompt = injectArcanosShell(prompt);
    const output = await runThroughBrain(openai, wrappedPrompt);
    return res.json(output);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ Trinity processing error:', errorMessage);
    
    // Return mock response as fallback
    console.log(`🤖 Returning mock response for /${endpointName} (processing failed)`);
    const mockResponse = generateMockResponse(prompt, endpointName);
    return res.json({
      ...mockResponse,
      error: `AI service failure: ${errorMessage}`
    });
  }
};

// Primary ask endpoint routed through the Trinity brain
router.post('/ask', (req, res) => handleAIRequest(req, res, 'ask'));

// Brain endpoint (alias for ask with same functionality)
router.post('/brain', (req, res) => handleAIRequest(req, res, 'brain'));

export default router;
