/**
 * Health Route
 * Health check and system status
 */

import { Router, Request, Response } from 'express';
import { getDatabaseStatus, query } from '../database';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    void req;
    const databaseStatus = getDatabaseStatus();
    let dbHealthy = false;
    let dbReason: string | undefined;

    if (databaseStatus.ready) {
      //audit assumption: database ready implies we can probe; risk: probe failure; invariant: health check continues; strategy: try query.
      try {
        // Check database connection
        const dbCheck = await query('SELECT NOW()');
        dbHealthy = dbCheck.rows.length > 0;
        if (!dbHealthy) {
          //audit assumption: empty result indicates failure; risk: false negative; invariant: mark degraded; strategy: set reason.
          dbReason = 'Database returned no rows';
        }
      } catch (error) {
        //audit assumption: query can fail; risk: connection issue; invariant: degraded status; strategy: capture reason.
        dbReason = error instanceof Error ? error.message : 'Database query failed';
      }
    } else {
      //audit assumption: database not ready; risk: missing persistence; invariant: degraded status; strategy: use status reason.
      dbReason = databaseStatus.reason;
    }

    const health = {
      status: dbHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealthy ? 'connected' : 'disconnected',
      databaseReason: dbReason,
      memory: {
        used: process.memoryUsage().heapUsed / 1024 / 1024,
        total: process.memoryUsage().heapTotal / 1024 / 1024,
        unit: 'MB'
      }
    };

    return res.json(health);
  } catch (error) {
    //audit assumption: health check can fail; risk: health endpoint unavailable; invariant: 503 returned; strategy: surface error.
    return res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Health check failed'
    });
  }
});

export default router;
