import express, { Request, Response } from 'express';
import { executeArcanosPipeline } from '../services/arcanosPipeline.js';
import type { ChatCompletionMessageParam } from '../services/openai/types.js';
import { resolveErrorMessage } from '../lib/errors/index.js';

const router = express.Router();

router.post('/arcanos-pipeline', async (req: Request, res: Response) => {
  const { messages } = req.body as { messages: ChatCompletionMessageParam[] };

  try {
    const pipelineResult = await executeArcanosPipeline(messages);

    if (pipelineResult.fallback) {
      return res.json({ result: pipelineResult.result, fallback: true });
    }

    res.json({ result: pipelineResult.result, stages: pipelineResult.stages });
  } catch (err: unknown) {
    //audit Assumption: pipeline errors should return 500
    console.error('Pipeline error:', resolveErrorMessage(err));
    res.status(500).json({ error: 'Pipeline failed', details: resolveErrorMessage(err) });
  }
});

export default router;
