import express from 'express';
import OpenAI from 'openai';

const router = express.Router();
const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

router.post('/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    if (!openai) {
      return res.status(503).json({ error: 'OpenAI client not configured' });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (error) {
    console.error('[🤖 CHAT] OpenAI error:', error);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

router.get('/chat/status', (req, res) => {
  res.json({
    module: 'chat',
    status: 'active',
    version: '1.0.0',
    endpoints: ['/chat', '/chat/status']
  });
});

export default router;

