import express, { Request, Response } from 'express';
import { handleArcanosPrompt } from '../services/arcanosPrompt.js';

const router = express.Router();

interface AskBody {
  prompt: string;
}

/**
 * Minimal ARCANOS ask endpoint used by external services.
 * Returns a success flag and the raw result from the core handler.
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
    const result = await handleArcanosPrompt(prompt);
    return res.json({ success: true, result });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

