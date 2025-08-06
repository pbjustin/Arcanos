import express from 'express';
import { OpenAI } from 'openai';

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
});

router.post('/ask', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.AI_MODEL || 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
    });

    const result = completion.choices[0]?.message?.content || '';
    const module = process.env.AI_MODEL;
    const meta = {
      timestamp: new Date().toISOString(),
      token_usage: completion.usage,
    };

    return res.json({ result, module, meta });
  } catch (err) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ error: 'AI request failed', details: err });
  }
});

export default router;