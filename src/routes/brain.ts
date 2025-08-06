import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { runThroughBrain } from '../logic/trinity.js';

const router = express.Router();

let openai: OpenAI | null = null;

try {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    openai = new OpenAI({ apiKey });
  } else {
    console.warn('⚠️  No OpenAI API key found. AI endpoints will return errors.');
  }
} catch (error) {
  console.error('❌ Failed to initialize OpenAI client:', error);
}

interface BrainRequest {
  prompt: string;
}

interface BrainResponse {
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

router.post('/brain', async (req: Request<{}, BrainResponse | ErrorResponse, BrainRequest>, res: Response<BrainResponse | ErrorResponse>) => {
  console.log('📨 /brain received');
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt in request body' });
  }

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
});

export default router;
