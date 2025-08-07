import express, { Request, Response } from 'express';
import { getOpenAIClient } from '../services/openai.js';
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
}

interface ErrorResponse {
  error: string;
  details?: string;
}

// Shared handler for both ask and brain endpoints
const handleAIRequest = async (req: Request<{}, AskResponse | ErrorResponse, AskRequest>, res: Response<AskResponse | ErrorResponse>, endpointName: string) => {
  console.log(`📨 /${endpointName} received`);
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt in request body' });
  }

  const openai = getOpenAIClient();
  if (!openai) {
    return res.status(503).json({
      error: 'AI service unavailable',
      details: 'OpenAI client not initialized. Please check API key configuration.'
    });
  }

  try {
    const output = await runThroughBrain(openai, prompt);
    return res.json(output);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ Trinity processing error:', errorMessage);
    return res.status(500).json({
      error: 'AI service failure',
      details: errorMessage
    });
  }
};

// Primary ask endpoint routed through the Trinity brain
router.post('/ask', (req, res) => handleAIRequest(req, res, 'ask'));

// Brain endpoint (alias for ask with same functionality)
router.post('/brain', (req, res) => handleAIRequest(req, res, 'brain'));

export default router;
