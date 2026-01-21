import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { executeArcanosPipeline } from '../services/arcanosPipeline.js';

const router = express.Router();

router.post('/arcanos-pipeline', async (req: Request, res: Response) => {
  const { messages } = req.body as { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] };

  try {
    const pipelineResult = await executeArcanosPipeline(messages);

    if (pipelineResult.fallback) {
      return res.json({ result: pipelineResult.result, fallback: true });
    }

    res.json({ result: pipelineResult.result, stages: pipelineResult.stages });
  } catch (err: any) {
    console.error('Pipeline error:', err);
    res.status(500).json({ error: 'Pipeline failed', details: err?.message || 'Unknown error' });
  }
});

export default router;
