import { Router } from 'express';
import healthRouter from './health.js';
import heartbeatRouter from './heartbeat.js';
import statusRouter from './status.js';

const router = Router();

router.use('/', healthRouter);
router.use('/', heartbeatRouter);
router.use('/', statusRouter);

export default router;
