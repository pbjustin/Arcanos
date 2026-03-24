import { Router } from 'express';
import { decide } from "@core/afol/engine.js";
import { getStatus } from "@core/afol/health.js";
import { getRecent, logError } from "@core/afol/logger.js";
import { getAnalyticsSnapshot } from "@core/afol/analytics.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

const router = Router();

router.post('/decide', async (req, res) => {
  try {
    const result = await decide(req.body ?? {});
    res.json(result);
  } catch (error) {
    logError('decide', error);
    res.status(500).json({ ok: false, error: resolveErrorMessage(error) });
  }
});

router.get('/health', (_req, res) => {
  res.json(getStatus());
});

router.get('/logs', (_req, res) => {
  res.json(getRecent());
});

router.get('/analytics', (_req, res) => {
  res.json(getAnalyticsSnapshot());
});

export default router;
