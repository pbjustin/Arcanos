import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runARCANOS } from '../logic/arcanos.js';
import { handleAIError } from '../utils/requestHandler.js';
import { runSystemDiagnostics } from '../utils/systemDiagnostics.js';

const router = express.Router();

interface ArcanosRequest {
  userInput: string;
  sessionId?: string;
  overrideAuditSafe?: string;
}

interface ArcanosResponse {
  result: string;
  componentStatus: string;
  suggestedFixes: string;
  coreLogicTrace: string;
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

interface ErrorResponse {
  error: string;
  details?: string;
}

async function runCommand(_command: string, _params: any) {
  return await runSystemDiagnostics();
}

/**
 * ARCANOS system diagnosis endpoint with standardized request handling
 */
router.post('/arcanos', async (req: Request<{}, ArcanosResponse | ErrorResponse, ArcanosRequest>, res: Response<ArcanosResponse | ErrorResponse>) => {
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
    return res.json(mockResponse);
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log('🤖 Returning mock response for /arcanos (client init failed)');
    const mockResponse = generateMockResponse(userInput, 'arcanos');
    return res.json(mockResponse);
  }

  try {
    const output = await runARCANOS(openai, userInput, sessionId, overrideAuditSafe);
    return res.json(output);
  } catch (err) {
    handleAIError(err, userInput, 'arcanos', res);
  }
});

router.post('/arcanos/diagnostics', async (req: Request, res: Response) => {
  const authToken = req.headers['x-arcanos-token'] as string | undefined;
  if (!authToken || authToken !== process.env.ARCANOS_AUTH_TOKEN) {
    return res.status(403).json({
      error: 'Unauthorized: Missing or invalid ARCANOS_AUTH_TOKEN'
    });
  }

  try {
    const { command, params } = req.body;
    const result = await runCommand(command, params);
    res.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
