import express from 'express';
import { processPrompt } from '../services/exampleService';

// Simple in-memory concurrency limiter
const CONCURRENCY_LIMIT = Number(process.env.ASK_CONCURRENCY_LIMIT) || 3;
let activeJobs = 0;

const router = express.Router();

router.post('/ask', async (req, res) => {
  const { query, options } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  if (activeJobs >= CONCURRENCY_LIMIT) {
    return res.status(429).json({ error: 'Too many requests in progress' });
  }

  activeJobs++;
  // Optional delay for testing concurrency logic
  const delayMs = Number(req.query.delay || 0);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
  } finally {
    activeJobs--;
  }
});

export default router;