import express from 'express';
import { resolveSession } from '../services/sessionResolver.js';

const router = express.Router();

router.post('/memory/resolve', async (req, res) => {
  try {
    const { query } = req.body as { query: string };
    const result = await resolveSession(query);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve session', details: err });
  }
});

export default router;
