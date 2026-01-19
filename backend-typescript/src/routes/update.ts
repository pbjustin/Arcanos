/**
 * Update Route
 * Handle user data updates (preferences, settings, etc.)
 */

import { Router, Request, Response } from 'express';
import { logAuditEvent } from '../database';
import { logger } from '../logger';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { updateType, data } = req.body || {};
    const userId = req.user?.userId || 'anonymous';

    // Validation
    if (typeof updateType !== 'string' || updateType.trim().length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'updateType is required'
      });
    }
    if (data === undefined || data === null) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'data is required'
      });
    }
    let dataSize = 0;
    try {
      dataSize = JSON.stringify(data).length;
    } catch (error) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'data must be JSON-serializable'
      });
    }
    if (dataSize > 10000) {
      return res.status(413).json({
        error: 'Payload Too Large',
        message: 'data exceeds maximum size'
      });
    }

    // Log audit event
    await logAuditEvent(
      userId,
      `update_${updateType}`,
      data,
      req.ip,
      req.get('user-agent')
    );

    logger.info('User data updated', { userId, updateType });

    return res.json({
      success: true,
      message: 'Update recorded'
    });
  } catch (error) {
    logger.error('Failed to update user data', { error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update'
    });
  }
});

export default router;
