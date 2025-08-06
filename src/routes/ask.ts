import express, { Request, Response } from 'express';
import OpenAI from 'openai';

const router = express.Router();

// Initialize OpenAI with validation
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

interface AskRequest {
  prompt: string;
}

interface AskResponse {
  result: string;
  module?: string;
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

router.post('/ask', async (req: Request<{}, AskResponse | ErrorResponse, AskRequest>, res: Response<AskResponse | ErrorResponse>) => {
  console.log("🛰 /ask received → Dispatching to model...");
  const start = Date.now();
  
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt in request body' });
  }

  // Check if OpenAI client is available
  if (!openai) {
    return res.status(503).json({ 
      error: 'AI service unavailable', 
      details: 'OpenAI client not initialized. Please check API key configuration.' 
    });
  }

  try {
    const modelId = process.env.AI_MODEL || 'gpt-3.5-turbo';
    console.log(`[🤖 DISPATCH] Sending prompt to ${modelId}`);
    
    const response = await openai.chat.completions.create({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const output = response.choices[0]?.message?.content;

    if (!output) {
      return res.status(500).json({ 
        error: 'No response from AI model',
        details: 'Empty response received from OpenAI'
      });
    }

    const duration = Date.now() - start;
    const totalTokens = response.usage?.total_tokens || 0;
    
    console.log(`✅ Model responded [${modelId}] | Tokens: ${totalTokens} | Time: ${duration}ms`);

    return res.json({
      result: output,
      module: modelId,
      meta: {
        tokens: response.usage || undefined,
        id: response.id,
        created: response.created,
      },
    });
  } catch (err) {
    const duration = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`❌ OpenAI Error after ${duration}ms:`, errorMessage);
    
    // Handle specific OpenAI errors
    if (err instanceof OpenAI.APIError) {
      return res.status(err.status || 500).json({ 
        error: 'OpenAI API error', 
        details: err.message 
      });
    }
    
    return res.status(500).json({ 
      error: 'AI service failure', 
      details: errorMessage
    });
  }
});

export default router;