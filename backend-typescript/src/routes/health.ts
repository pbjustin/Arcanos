/**
 * Health Route
 * Health check and system status
 */

import { Router, Request, Response } from 'express';
import { pool } from '../database';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    void req;
    // Check database connection
    const dbCheck = await pool.query('SELECT NOW()');
    const dbHealthy = dbCheck.rows.length > 0;

    const health = {
      status: dbHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealthy ? 'connected' : 'disconnected',
      memory: {
        used: process.memoryUsage().heapUsed / 1024 / 1024,
        total: process.memoryUsage().heapTotal / 1024 / 1024,
        unit: 'MB'
      }
    };

    return res.json(health);
  } catch (error) {
    return res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed'
    });
  }
});

export default router;
