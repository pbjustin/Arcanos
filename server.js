import express from 'express';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 🔐 OpenAI Client (v4+ SDK)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());

// ✅ Railway Healthcheck Endpoint
app.get('/railway/healthcheck', (req, res) => {
  res.status(200).send('OK');
});

// 🔮 AI Endpoint: POST /ask
app.post('/ask', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing or invalid "messages" array' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
    });

    const reply = response.choices?.[0]?.message?.content;
    res.json({ reply });
  } catch (error) {
    console.error('[OpenAI ERROR]', error);
    res.status(500).json({ error: 'OpenAI API call failed' });
  }
});

// 🚀 Start server (Railway-compatible port)
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
