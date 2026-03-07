/**
 * Agent API Routes
 *
 * POST /agents/register           — Register agent with capabilities + public key
 * GET  /agents/:agentId           — Get agent status
 * POST /agents/:agentId/heartbeat — Agent heartbeat
 */

import express from 'express';
import { z } from 'zod';
import { agentRegistrationSchema } from '@shared/types/actionPlan.js';
import {
  registerAgent,
  getAgent,
  updateHeartbeat,
  listAgents,
  grantCapabilities,
} from '../stores/agentRegistry.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import { asyncHandler, validateBody, validateParams, sendNotFoundError, sendInternalError } from '@shared/http/index.js';

const router = express.Router();

const agentIdSchema = z.object({
  agentId: z.string().min(1)
});

/**
 * POST /agents/register — Register a new agent
 */
router.post(
  '/agents/register',
  validateBody(agentRegistrationSchema),
  asyncHandler(async (req, res) => {
    try {
      const config = getConfig();
      if (!config.enableActionPlans) {
        res.status(503).json({ error: 'ActionPlans are not enabled' });
        return;
      }

      const agent = await registerAgent(req.validated!.body as any);
      res.status(201).json(agent);
    } catch (error: unknown) {
      apiLogger.error('Register failed', { module: 'agents', error: resolveErrorMessage(error) });
      sendInternalError(res, 'Failed to register agent');
    }
  })
);

/**
 * GET /agents — List all agents
 */
router.get(
  '/agents',
  asyncHandler(async (_req, res) => {
    try {
      const agents = await listAgents();
      res.json({ agents, count: agents.length });
    } catch (error: unknown) {
      apiLogger.error('List failed', { module: 'agents', error: resolveErrorMessage(error) });
      sendInternalError(res, 'Failed to list agents');
    }
  })
);


/**
 * POST /agents/:agentId/capabilities/grant — Grant capabilities
 *
 * Purpose:
 * - Allow a solo operator deployment to change agent capabilities without separate token management.
 *
 * Inputs/outputs:
 * - Input: agent identifier path param plus a validated capabilities array.
 * - Output: updated agent payload after capability mutation.
 *
 * Edge case behavior:
 * - Returns `404` when the target agent does not exist.
 */
router.post(
  '/agents/:agentId/capabilities/grant',
  validateParams(agentIdSchema),
  validateBody(z.object({ capabilities: z.array(z.string().min(1)).min(1) })),
  asyncHandler(async (req, res) => {
    const agentId = (req.validated!.params as any).agentId as string;
    const caps = (req.validated!.body as any).capabilities as string[];

    //audit Assumption: this backend is operated by one trusted user who prefers no secondary admin token surface; failure risk: any reachable caller can mutate agent capabilities; expected invariant: route is only exposed in the operator's trusted environment; handling strategy: remove header auth and rely on deployment-level access control.
    const updated = await grantCapabilities(agentId, caps);
    if (!updated) {
      sendNotFoundError(res, 'Agent not found');
      return;
    }
    res.json({ agent: updated });
  })
);

/**
 * GET /agents/:agentId — Get agent status
 */
router.get(
  '/agents/:agentId',
  validateParams(agentIdSchema),
  asyncHandler(async (req, res) => {
    try {
      const { agentId } = req.validated!.params as z.infer<typeof agentIdSchema>;
      const agent = await getAgent(agentId);
      if (!agent) {
        sendNotFoundError(res, 'Agent not found');
        return;
      }
      res.json(agent);
    } catch (error: unknown) {
      apiLogger.error('Get agent failed', { module: 'agents', error: resolveErrorMessage(error) });
      sendInternalError(res, 'Failed to get agent');
    }
  })
);

/**
 * POST /agents/:agentId/heartbeat — Agent heartbeat
 */
router.post(
  '/agents/:agentId/heartbeat',
  validateParams(agentIdSchema),
  asyncHandler(async (req, res) => {
    try {
      const { agentId } = req.validated!.params as z.infer<typeof agentIdSchema>;
      const updated = await updateHeartbeat(agentId);
      if (!updated) {
        sendNotFoundError(res, 'Agent not found');
        return;
      }
      res.json(updated);
    } catch (error: unknown) {
      apiLogger.error('Heartbeat failed', { module: 'agents', error: resolveErrorMessage(error) });
      sendInternalError(res, 'Failed to update heartbeat');
    }
  })
);

export default router;
