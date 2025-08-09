import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runThroughBrain } from '../logic/trinity.js';
import fs from 'fs';

const router = express.Router();

interface AskRequest {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
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
  routingStages?: string[];
  gpt5Used?: boolean;
  auditSafe?: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext?: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage?: {
    requestId: string;
    logged: boolean;
  };
  error?: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
}

// Shared handler for both ask and brain endpoints
const handleAIRequest = async (
  req: Request<{}, AskResponse | ErrorResponse, AskRequest>,
  res: Response<AskResponse | ErrorResponse>,
  endpointName: string
) => {
  console.log(`📨 /${endpointName} received`);
  const { prompt, sessionId, overrideAuditSafe } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt in request body' });
  }

  console.log(`[📨 ${endpointName.toUpperCase()}] Processing with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}`);

  // Log request for feedback loop
  try {
    const feedbackData = {
      timestamp: new Date().toISOString(),
      endpoint: endpointName,
      prompt: prompt.substring(0, 500) // Limit length for privacy
    };
    fs.writeFileSync('/tmp/last-gpt-request', JSON.stringify(feedbackData));
  } catch (error) {
    // Silently fail - feedback logging is not critical
    console.log('Could not write feedback file:', error instanceof Error ? error.message : 'Unknown error');
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
    // runThroughBrain now unconditionally routes through GPT-5 before final ARCANOS processing
    const output = await runThroughBrain(openai, prompt, sessionId, overrideAuditSafe);
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
