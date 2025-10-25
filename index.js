import express from 'express';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// ✅ OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ✅ Healthcheck for Railway
app.get('/railway/healthcheck', (_req, res) => {
  res.status(200).send('OK');
});

// ✅ Example OpenAI route
app.post('/ask', async (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    const chat = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ response: chat.choices[0]?.message?.content ?? '' });
  } catch (err) {
    console.error('[OpenAI Error]', err);
    res.status(500).send('Failed to query OpenAI');
  }
});

// ✅ Background worker simulation (heartbeat)
setInterval(() => {
  console.log(`[⏱] Heartbeat at ${new Date().toISOString()}`);
  // Optional: add logic here for AI-based background workers
}, 60_000); // every minute

// ✅ Railway-compatible port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[🚂] Server running on port ${PORT}`);
});

export default app;
