import { Router } from 'express';
import { decide } from '../afol/engine.js';
import { getStatus } from '../afol/health.js';
import { getRecent, logError } from '../afol/logger.js';

const router = Router();

router.post('/decide', async (req, res) => {
  try {
    const result = await decide(req.body ?? {});
    res.json(result);
  } catch (error) {
    logError('decide', error);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.get('/health', (_req, res) => {
  res.json(getStatus());
});

router.get('/logs', (_req, res) => {
  res.json(getRecent());
});

export default router;
