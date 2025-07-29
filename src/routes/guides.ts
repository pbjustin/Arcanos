/**
 * Guide Routes - Endpoints for guide management
 */

import { Router } from 'express';
import { fetchGuideHandler } from '../handlers/guide-handler';

const router = Router();

// POST /guides/fetch - Fetch guide content by ID
router.post('/fetch', fetchGuideHandler);

export default router;