import express from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { dispatchLegacyRouteToGpt } from './_core/legacyGptCompat.js';
import {
  adaptLegacyArcanosRouteResult,
  buildLegacyArcanosDispatchBody,
  createLegacyRouteDeprecationMiddleware
} from './_core/legacyRouteAdapters.js';

const router = express.Router();

/**
 * Compatibility shim for the deprecated `/arcanos` endpoint.
 */
router.post(
  '/arcanos',
  createLegacyRouteDeprecationMiddleware('arcanos-core'),
  confirmGate,
  (req, res, next) => dispatchLegacyRouteToGpt(req, res, next, {
    legacyRoute: '/arcanos',
    gptId: 'arcanos-core',
    applyDeprecationHeaders: false,
    bodyTransform: (body) => buildLegacyArcanosDispatchBody(body),
    successBodyTransform: (result, request) => adaptLegacyArcanosRouteResult(request.body, result, request)
  })
);

export default router;
