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

interface ArcanosAskRequest {
  prompt: string;
}

interface ArcanosAskEndpointResponse {
  success: boolean;
  result?: ArcanosResponse;
  error?: string;
}

async function handleArcanosPrompt(prompt: string): Promise<ArcanosResponse> {
  if (!hasValidAPIKey()) {
    console.log('🤖 Returning mock response for handleArcanosPrompt (no API key)');
    return generateMockResponse(prompt, 'arcanos') as ArcanosResponse;
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log('🤖 Returning mock response for handleArcanosPrompt (client init failed)');
    return generateMockResponse(prompt, 'arcanos') as ArcanosResponse;
  }

  return await runARCANOS(openai, prompt);
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

// Reset: /ask endpoint with no token or IP checks
router.post('/api/arcanos/ask', async (
  req: Request<{}, ArcanosAskEndpointResponse, ArcanosAskRequest>,
  res: Response<ArcanosAskEndpointResponse>
) => {
  try {
    const { prompt } = req.body;
    const result = await handleArcanosPrompt(prompt);
    res.json({ success: true, result });
  } catch (err) {
    console.error('ARCANOS /ask error:', err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.post('/arcanos/diagnostics', async (req: Request, res: Response) => {
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
