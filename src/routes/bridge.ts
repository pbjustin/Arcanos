import express from 'express';
import { createRateLimitMiddleware, securityHeaders } from '../utils/security.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(120, 5 * 60 * 1000));

const BRIDGE_PATHS = [
  '/bridge-status',
  '/bridge',
  '/bridge/handshake',
  '/ipc',
  '/ipc/handshake',
  '/ipc/status'
];

router.all(BRIDGE_PATHS, (_req, res) => {
  const enabled = process.env.BRIDGE_ENABLED === 'true';
  res.json({
    status: enabled ? 'active' : 'disabled',
    bridgeEnabled: enabled,
    timestamp: new Date().toISOString()
  });
});

export default router;
