import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';

const router = express.Router();

const FORCE_FINE_TUNE = process.env.FORCE_FINE_TUNE === 'true';

function shouldUseFineTune(prompt: string): boolean {
  const hasPrefix = /^ARCANOS:|^query-|^POST |^GET /.test(prompt);
  return FORCE_FINE_TUNE || !hasPrefix;
}

router.post('/query', async (req: Request, res: Response) => {
  const prompt = req.body.prompt;

  if (typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Invalid prompt format' });
  }

  const routeToFineTune = shouldUseFineTune(prompt);

  try {
    const endpoint = routeToFineTune
      ? 'https://arcanos-production-426d.up.railway.app/query-finetune'
      : 'https://arcanos-production-426d.up.railway.app/ask';

    const response = await axios.post(endpoint, { query: prompt });

    res.json(response.data);
  } catch (error: any) {
    console.error('Routing error:', error.message);
    res.status(500).json({ error: 'Routing failed' });
  }
});

export default router;