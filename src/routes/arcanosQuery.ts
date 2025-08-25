/**
 * ARCANOS Query Router - demonstrates the two-step process
 * Route: POST /arcanos-query
 */

import express, { Request, Response } from 'express';
import { arcanosQuery } from '../services/arcanosQuery.js';
import { requireField } from '../utils/validation.js';

const router = express.Router();

const arcanosQueryEndpoint = async (req: Request, res: Response): Promise<void> => {
  try {
    // Validate request
    if (!requireField(res, req.body?.prompt, 'prompt')) {
      return;
    }

    const { prompt } = req.body;

    console.log(`[ARCANOS-QUERY] Processing request: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

    // Call the arcanosQuery function
    const result = await arcanosQuery(prompt);

    // Return structured response
    res.json({
      result,
      meta: {
        endpoint: 'arcanos-query',
        timestamp: new Date().toISOString(),
        processSteps: [
          'Fine-tuned ARCANOS model (ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote)',
          'GPT-5 reasoning and refinement'
        ]
      },
      activeModel: 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote',
      module: 'ArcanosQuery'
    });

  } catch (error: any) {
    console.error('[ARCANOS-QUERY] Error:', error);
    res.status(500).json({
      error: 'ARCANOS query processing failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Register the route
router.post('/arcanos-query', arcanosQueryEndpoint);

export default router;