import express from 'express';
import { processPrompt } from '../services/exampleService';

const router = express.Router();

router.post('/ask', async (req, res) => {
  const { query, options } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const response = await processPrompt(query, options);
    res.json({
      success: true,
      response,
      metadata: {}
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Failed to process query',
      details: err
    });
  }
});

export default router;