import express from 'express';
import { railwayHealthCheck } from '../utils/railwayConnectionSuite.js';

const router = express.Router();

router.get('/railway/health', railwayHealthCheck);

export default router;
