import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { runARCANOS } from '../logic/arcanos.js';

const router = express.Router();

// Initialize OpenAI with validation
let openai: OpenAI | null = null;

try {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    openai = new OpenAI({ apiKey });
  } else {
    console.warn('⚠️  No OpenAI API key found. ARCANOS endpoints will return errors.');
  }
} catch (error) {
  console.error('❌ Failed to initialize OpenAI client:', error);
}

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

  if (!openai) {
    return res.status(503).json({
      error: 'AI service unavailable',
      details: 'OpenAI client not initialized. Please check API key configuration.'
    });
  }

  try {
    const output = await runARCANOS(openai, userInput);
    return res.json(output);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ ARCANOS processing error:', errorMessage);
    return res.status(500).json({
      error: 'ARCANOS service failure',
      details: errorMessage
    });
  }
});

export default router;