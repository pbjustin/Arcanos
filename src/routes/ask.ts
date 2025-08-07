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

// Inject ARCANOS prompt shell before processing - ensures all requests go through ARCANOS first
const injectArcanosShell = (userPrompt: string): string => {
  return `[ARCANOS SYSTEM SHELL]
You are ARCANOS, the primary fine-tuned AI routing shell. ALL requests must be processed through you first.

For simple requests, respond directly with your comprehensive capabilities.

For complex requests requiring advanced reasoning, specialized knowledge, or sophisticated analysis, you may invoke GPT-5 by responding with:
{"next_model": "gpt-5", "purpose": "Brief explanation of why GPT-5 is needed", "input": "The specific input to send to GPT-5"}

Remember: If you invoke GPT-5, its response will be filtered back through you for final processing. Users always receive responses from ARCANOS, never directly from GPT-5.

[USER REQUEST]
${userPrompt}

[RESPONSE DIRECTIVE]
Provide a comprehensive, accurate, and helpful response that directly addresses the user's needs.`;
};

// Shared handler for both ask and brain endpoints
const handleAIRequest = async (req: Request<{}, AskResponse | ErrorResponse, AskRequest>, res: Response<AskResponse | ErrorResponse>, endpointName: string) => {
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
    // Inject ARCANOS shell before processing
    const wrappedPrompt = injectArcanosShell(prompt);
    const output = await runThroughBrain(openai, wrappedPrompt, sessionId, overrideAuditSafe);
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
