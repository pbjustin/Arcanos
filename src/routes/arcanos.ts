import express from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { dispatchLegacyRouteToGpt } from './_core/legacyGptCompat.js';

const router = express.Router();

/**
 * Compatibility shim for the deprecated `/arcanos` endpoint.
 */
router.post('/arcanos', confirmGate, (req, res, next) =>
  dispatchLegacyRouteToGpt(req, res, next, {
    legacyRoute: '/arcanos',
    gptId: 'arcanos-core'
  })
);

export default router;
