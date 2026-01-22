/**
 * Audit Route
 * Retrieve audit logs for a user
 */

import { Router, Request, Response } from 'express';
import { getAuditLogs } from '../database';
import { logger } from '../logger';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId || 'anonymous';
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'limit must be a positive integer'
      });
    }
    const limit = Math.min(parsedLimit, 100);

    // Get audit logs
    const logs = await getAuditLogs(userId, limit);

    logger.info('Audit logs retrieved', { userId, count: logs.length });

    return res.json({
      success: true,
      logs,
      count: logs.length
    });
  } catch (error) {
    logger.error('Failed to retrieve audit logs', { error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve audit logs'
    });
  }
});

export default router;
