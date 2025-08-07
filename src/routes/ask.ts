import express, { Request, Response } from 'express';
import { getOpenAIClient } from '../services/openai.js';

const router = express.Router();

const arcanosPrompt = (input: string) => `
You are ARCANOS — a modular AI operating core.

[COMMAND]
${input}

[FORMAT]
- ✅ Component Status Table
- 🛠 Suggested Fixes
- 🧠 Core Logic Trace
`;

async function ask(req: Request, res: Response) {
  const userInput: string = req.body.prompt;
  const model = process.env.AI_MODEL || 'gpt-4';
  const client = getOpenAIClient();
  const usingMock = !process.env.API_KEY && !process.env.OPENAI_API_KEY && process.env.USE_MOCK_OPENAI === 'true';
  console.log(`🔍 /ask using model ${model}${usingMock ? ' (mock)' : ''}`);

  if (!client) {
    return res.status(503).json({
      error: 'AI service unavailable',
      details: 'OpenAI client not initialized. Please check API key configuration.',
    });
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content: arcanosPrompt(userInput),
        },
      ],
      temperature: 0.2,
    });

    res.json({ result: response.choices[0].message?.content, module: model });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to call OpenAI',
      details: err.message,
    });
  }
}

router.post('/ask', ask);
router.post('/brain', ask);

export default router;

