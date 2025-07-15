import express from 'express';
import askOpenAI from './core/ai.engine.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const prompt = req.body?.prompt;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  try {
    const answer = await askOpenAI(prompt);
    res.json({ answer });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query OpenAI.' });
  }
});

export default router;