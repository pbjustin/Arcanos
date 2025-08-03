import { Router } from 'express';
import { getRecentLogs } from '../services/log-relay.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ logs: getRecentLogs() });
});

export default router;
