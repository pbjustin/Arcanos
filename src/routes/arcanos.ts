import express, { Request, Response } from 'express';
import { hasValidAPIKey } from "@services/openai.js";
import { runARCANOS } from "@core/logic/arcanos.js";
import { handleAIError, sendMockAIResponse } from "@transport/http/requestHandler.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import type { AIResponseDTO, ErrorResponseDTO } from "@shared/types/dto.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";

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
    return sendMockAIResponse(res, userInput, 'arcanos', 'no API key');
  }

  const { adapter, client: openai } = getOpenAIClientOrAdapter();
  if (!adapter) {
    return sendMockAIResponse(res, userInput, 'arcanos', 'adapter init failed');
  }

  if (!openai) {
    return sendMockAIResponse(res, userInput, 'arcanos', 'client init failed');
  }

  try {
    const output = await runARCANOS(openai, userInput, sessionId, overrideAuditSafe);
    return res.json(output as ArcanosResponse);
  } catch (err) {
    handleAIError(err, userInput, 'arcanos', res);
  }
});

export default router;
