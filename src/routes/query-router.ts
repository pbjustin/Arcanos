import express, { Request, Response } from 'express';
import { askArcanosV1_Safe } from '../services/arcanos-v1-interface';
import { createServiceLogger } from '../utils/logger';

const router = express.Router();
const logger = createServiceLogger('QueryRouter');

router.post('/query', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const prompt = req.body.prompt;

  if (typeof prompt !== 'string') {
    logger.error('Invalid prompt format', { prompt: typeof prompt });
    return res.status(400).json({ error: 'Invalid prompt format' });
  }

  // Log the AI interaction start
  logger.info('AI interaction started', {
    timestamp: new Date().toISOString(),
    taskType: 'query',
    promptLength: prompt.length
  });

  try {
    // Use ARCANOS V1 interface directly instead of HTTP requests
    const result = await askArcanosV1_Safe({
      message: prompt,
      domain: 'query',
      useRAG: true,
      useHRC: true
    });

    const completionTime = Date.now() - startTime;
    
    // Log successful completion
    logger.info('AI interaction completed', {
      timestamp: new Date().toISOString(),
      taskType: 'query',
      completionStatus: 'success',
      responseLength: result.response.length,
      model: result.model,
      completionTimeMs: completionTime
    });

    res.json({
      response: result.response,
      model: result.model,
      completionTime: completionTime
    });
  } catch (error: any) {
    const completionTime = Date.now() - startTime;
    
    // Log failed completion
    logger.error('AI interaction failed', {
      timestamp: new Date().toISOString(),
      taskType: 'query',
      completionStatus: 'error',
      error: error.message,
      completionTimeMs: completionTime
    });

    res.status(500).json({ 
      error: 'Query processing failed',
      message: error.message 
    });
  }
});

export default router;