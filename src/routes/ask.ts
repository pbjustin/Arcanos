import express from 'express';
import OpenAI from 'openai';

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
});

router.post('/ask', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt in request body' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AI_MODEL || 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });

    const output = response.choices[0].message.content;

    return res.json({
      result: output,
      module: process.env.AI_MODEL,
      meta: {
        tokens: response.usage,
        id: response.id,
        created: response.created,
      },
    });
  } catch (err) {
    console.error('OpenAI Error:', err instanceof Error ? err.message : String(err));
    return res.status(500).json({ 
      error: 'AI failure', 
      details: err instanceof Error ? err.message : String(err) 
    });
  }
});

export default router;