import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runARCANOS } from '../logic/arcanos.js';

const router = express.Router();

interface ArcanosRequest {
  userInput: string;
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
  error?: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
}

// ARCANOS system diagnosis endpoint
router.post('/arcanos', async (req: Request<{}, ArcanosResponse | ErrorResponse, ArcanosRequest>, res: Response<ArcanosResponse | ErrorResponse>) => {
  console.log('🔬 /arcanos received');
  const { userInput } = req.body;

  if (!userInput || typeof userInput !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid userInput in request body' });
  }

  // Check if we have a valid API key
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
    const output = await runARCANOS(openai, userInput);
    return res.json(output);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ ARCANOS processing error:', errorMessage);
    
    // Return mock response as fallback
    console.log('🤖 Returning mock response for /arcanos (processing failed)');
    const mockResponse = generateMockResponse(userInput, 'arcanos');
    return res.json({
      ...mockResponse,
      error: `ARCANOS service failure: ${errorMessage}`
    });
  }
});

export default router;