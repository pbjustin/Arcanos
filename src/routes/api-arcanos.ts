import express, { Request, Response } from 'express';
import OpenAI from 'openai';

const router = express.Router();

interface AskBody {
  prompt: string;
}

/**
 * Minimal ARCANOS ask endpoint used by external services.
 * Fully compatible with OpenAI Node.js SDK.
 * Returns a success flag and the raw result from OpenAI API.
 */
router.post('/ask', async (
  req: Request<{}, { success: boolean; result?: any; error?: string }, AskBody>,
  res: Response<{ success: boolean; result?: any; error?: string }>
) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid prompt' });
    }

    // Health check: if prompt is "ping", respond with "pong" without calling OpenAI
    if (prompt === 'ping') {
      return res.json({ success: true, result: 'pong' });
    }

    // Check if OpenAI API key is available
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === '' || apiKey === 'your-openai-api-key-here') {
      // Return a simple mock response when no API key is configured
      return res.json({ 
        success: true, 
        result: `Mock response for: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"` 
      });
    }

    // Initialize OpenAI client
    const client = new OpenAI({ apiKey });
    
    // Call OpenAI API with gpt-4o-mini model
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });

    return res.json({ success: true, result: response });
  } catch (err: any) {
    return res.json({ success: false, error: err.message });
  }
});

export default router;

