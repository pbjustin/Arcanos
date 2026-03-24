/**
 * Core AI Endpoints - Primary Implementation
 * Handles /write, /guide, /audit, and /sim endpoints using OpenAI SDK
 * These are the main endpoints for ARCANOS AI functionality
 */

import express from 'express';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { validateSchema } from "@transport/http/middleware/validation.js";
import AIController from "@transport/http/controllers/aiController.js";

const router = express.Router();
// Core AI endpoints using clean controller pattern with validation

// Write endpoint - Primary content generation endpoint
router.post('/write', validateSchema('aiRequest'), confirmGate, AIController.write);

// Guide endpoint - Primary step-by-step guidance endpoint  
router.post('/guide', validateSchema('aiRequest'), confirmGate, AIController.guide);

// Audit endpoint - Primary analysis and evaluation endpoint
router.post('/audit', validateSchema('aiRequest'), confirmGate, AIController.audit);

// Sim endpoint - Primary simulations and modeling endpoint
router.post('/sim', validateSchema('aiRequest'), confirmGate, AIController.sim);

export default router;