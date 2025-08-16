import express, { Request, Response } from 'express';
import { handleArcanosPrompt } from '../services/arcanosPrompt.js';

const router = express.Router();

interface AskBody {
  prompt: string;
}

/**
 * Minimal ARCANOS ask endpoint used by external services.
 * Returns a success flag and the raw result from the core handler.
 * Includes simple ping/pong healthcheck functionality.
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

    // Simple ping/pong healthcheck - bypass AI processing for ping
    if (prompt.toLowerCase().trim() === 'ping') {
      return res.json({ success: true, result: 'pong' });
    }

    const result = await handleArcanosPrompt(prompt);
    return res.json({ success: true, result });
  } catch (err: any) {
    // Enhanced error handling for network reachability and other issues
    const errorMessage = err.message || 'Unknown error occurred';
    
    // Check for common network/API related errors
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
      return res.status(503).json({ 
        success: false, 
        error: 'Network connectivity issue - unable to reach AI services'
      });
    }
    
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return res.status(504).json({ 
        success: false, 
        error: 'Request timeout - AI service did not respond in time'
      });
    }

    if (errorMessage.includes('API key') || errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
      return res.status(503).json({ 
        success: false, 
        error: 'AI service configuration issue - authentication failed'
      });
    }

    // Generic error fallback
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

export default router;

