/**
 * Legacy root-route compatibility shims plus the canonical /audit handler.
 * Deprecated /write, /guide, and /sim requests are adapted onto /gpt/:gptId.
 */

import express from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { validateSchema } from "@transport/http/middleware/validation.js";
import AIController from "@transport/http/controllers/aiController.js";
import { dispatchLegacyRouteToGpt } from './_core/legacyGptCompat.js';
import {
  adaptLegacyAiRouteResult,
  buildLegacyDispatchBody,
  createLegacyRouteDeprecationMiddleware
} from './_core/legacyRouteAdapters.js';

const router = express.Router();
// Write endpoint compatibility shim
router.post(
  '/write',
  createLegacyRouteDeprecationMiddleware('write'),
  validateSchema('aiRequest'),
  confirmGate,
  (req, res, next) => dispatchLegacyRouteToGpt(req, res, next, {
    legacyRoute: '/write',
    gptId: 'write',
    applyDeprecationHeaders: false,
    bodyTransform: (body) => buildLegacyDispatchBody(body, 'query'),
    successBodyTransform: (result, request) => adaptLegacyAiRouteResult('write', request.body, result)
  })
);

// Guide endpoint compatibility shim
router.post(
  '/guide',
  createLegacyRouteDeprecationMiddleware('guide'),
  validateSchema('aiRequest'),
  confirmGate,
  (req, res, next) => dispatchLegacyRouteToGpt(req, res, next, {
    legacyRoute: '/guide',
    gptId: 'guide',
    applyDeprecationHeaders: false,
    bodyTransform: (body) => buildLegacyDispatchBody(body, 'query'),
    successBodyTransform: (result, request) => adaptLegacyAiRouteResult('guide', request.body, result)
  })
);

// Audit endpoint remains on the direct controller path
router.post('/audit', validateSchema('aiRequest'), confirmGate, AIController.audit);

// Sim endpoint compatibility shim
router.post(
  '/sim',
  createLegacyRouteDeprecationMiddleware('sim'),
  validateSchema('aiRequest'),
  confirmGate,
  (req, res, next) => dispatchLegacyRouteToGpt(req, res, next, {
    legacyRoute: '/sim',
    gptId: 'sim',
    applyDeprecationHeaders: false,
    bodyTransform: (body) => buildLegacyDispatchBody(body, 'run'),
    successBodyTransform: (result, request) => adaptLegacyAiRouteResult('sim', request.body, result)
  })
);

export default router;
