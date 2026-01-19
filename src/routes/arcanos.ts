import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runARCANOS } from '../logic/arcanos.js';
import { handleAIError } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import type { AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';

const router = express.Router();

interface ArcanosRequest {
  userInput: string;
  sessionId?: string;
  overrideAuditSafe?: string;
}

interface ArcanosResponse extends AIResponseDTO {
  result: string;
  componentStatus?: string;
  suggestedFixes?: string;
  coreLogicTrace?: string;
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
  gpt5Delegation?: {
    used: boolean;
    reason?: string;
    delegatedQuery?: string;
  };
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

/**
 * ARCANOS system diagnosis endpoint with standardized request handling
 */
router.post('/arcanos', confirmGate, async (
  req: Request<{}, ArcanosResponse | ErrorResponseDTO, ArcanosRequest>,
  res: Response<ArcanosResponse | ErrorResponseDTO>
) => {
  console.log('🔬 /arcanos received');
  const { userInput, sessionId, overrideAuditSafe } = req.body;

  if (!userInput || typeof userInput !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid userInput in request body' });
  }

  console.log(`[🔬 ARCANOS] Processing request with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}`);

  // Use shared validation logic for OpenAI client
  if (!hasValidAPIKey()) {
    console.log('🤖 Returning mock response for /arcanos (no API key)');
    const mockResponse = generateMockResponse(userInput, 'arcanos');
    return res.json(mockResponse as ArcanosResponse);
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log('🤖 Returning mock response for /arcanos (client init failed)');
    const mockResponse = generateMockResponse(userInput, 'arcanos');
    return res.json(mockResponse as ArcanosResponse);
  }

  try {
    const output = await runARCANOS(openai, userInput, sessionId, overrideAuditSafe);
    return res.json(output as ArcanosResponse);
  } catch (err) {
    handleAIError(err, userInput, 'arcanos', res);
  }
});

export default router;