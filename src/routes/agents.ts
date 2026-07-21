/**
 * Agent API Routes
 *
 * POST /agents/register           — Register agent with capabilities + public key
 * GET  /agents/:agentId           — Get agent status
 * POST /agents/:agentId/heartbeat — Agent heartbeat
 */

import express, { type Response } from 'express';
import { z } from 'zod';
import { agentRegistrationSchema } from '@shared/types/actionPlan.js';
import {
  registerAgent,
  getAuthoritativeAgent,
  listAuthoritativeAgents,
  grantAuthoritativeCapabilities,
} from '../stores/agentRegistry.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';
import { asyncHandler, validateBody, validateParams, sendNotFoundError } from '@shared/http/index.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  getRequestClientAddress,
} from '@platform/runtime/security.js';
import {
  actionPlanAuthenticationMiddleware,
  requireActionPlanRoles,
} from '@services/actionPlanExecution/auth.js';
import {
  actionPlanRateLimitOperation,
  setActionPlanNoStore,
} from '@services/actionPlanExecution/http.js';

const router = express.Router();
const agentClientRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-agent-http-client',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}`,
});
const agentCredentialRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-agent-http-credential',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `client:${getRequestClientAddress(req)}:${getRequestActorKey(req)}`,
});
const agentPrincipalRateLimit = createRateLimitMiddleware({
  bucketName: 'action-plan-agent-http-principal',
  maxRequests: 120,
  windowMs: 60_000,
  keyGenerator: req => `principal:${req.actionPlanPrincipal!.role}:${req.actionPlanPrincipal!.principalId}:operation:${actionPlanRateLimitOperation(req)}`,
});

router.use('/agents', (_req, res, next) => {
  setActionPlanNoStore(res);
  next();
}, agentClientRateLimit, agentCredentialRateLimit, actionPlanAuthenticationMiddleware, agentPrincipalRateLimit);

const agentIdSchema = z.object({
  agentId: z.string().min(1).max(128)
});
const phase2eAgentRegistrationSchema = agentRegistrationSchema.extend({
  capabilities: z.array(z.string().min(1).max(128)).min(1).max(128),
  public_key: z.string().max(16 * 1024).optional(),
}).strict();

function safeThrownClass(error: unknown): string {
  try {
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof Error) return 'Error';
    return 'ThrownValue';
  } catch {
    return 'ThrownValue';
  }
}

function logAgentFailure(operation: string, error: unknown): void {
  try {
    apiLogger.error('ActionPlan agent operation failed', {
      module: 'agents',
      operation,
      errorCode: 'ACTION_PLAN_AGENT_OPERATION_FAILED',
      errorClass: safeThrownClass(error),
    });
  } catch {
    // Diagnostics must not mask the fixed external response.
  }
}

function sendAgentOperationFailed(res: Response): void {
  res.status(500).json({
    ok: false,
    error: {
      code: 'ACTION_PLAN_AGENT_OPERATION_FAILED',
      message: 'ActionPlan agent operation failed.',
    },
  });
}

/**
 * POST /agents/register — Register a new agent
 */
router.post(
  '/agents/register',
  requireActionPlanRoles('operator'),
  validateBody(phase2eAgentRegistrationSchema),
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
      logAgentFailure('register', error);
      sendAgentOperationFailed(res);
    }
  })
);

/**
 * GET /agents — List all agents
 */
router.get(
  '/agents',
  requireActionPlanRoles('operator'),
  asyncHandler(async (_req, res) => {
    try {
      const agents = await listAuthoritativeAgents();
      res.json({ agents, count: agents.length });
    } catch (error: unknown) {
      logAgentFailure('list', error);
      sendAgentOperationFailed(res);
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
  requireActionPlanRoles('operator'),
  validateParams(agentIdSchema),
  validateBody(z.object({ capabilities: z.array(z.string().min(1).max(128)).min(1).max(128) }).strict()),
  asyncHandler(async (req, res) => {
    try {
      const agentId = (req.validated!.params as z.infer<typeof agentIdSchema>).agentId;
      const caps = (req.validated!.body as { capabilities: string[] }).capabilities;

      const updated = await grantAuthoritativeCapabilities(agentId, caps);
      if (!updated) {
        sendNotFoundError(res, 'Agent not found');
        return;
      }
      res.json({ agent: updated });
    } catch (error: unknown) {
      logAgentFailure('grant-capabilities', error);
      sendAgentOperationFailed(res);
    }
  })
);

/**
 * GET /agents/:agentId — Get agent status
 */
router.get(
  '/agents/:agentId',
  requireActionPlanRoles('operator'),
  validateParams(agentIdSchema),
  asyncHandler(async (req, res) => {
    try {
      const { agentId } = req.validated!.params as z.infer<typeof agentIdSchema>;
      const agent = await getAuthoritativeAgent(agentId);
      if (!agent) {
        sendNotFoundError(res, 'Agent not found');
        return;
      }
      res.json(agent);
    } catch (error: unknown) {
      logAgentFailure('get', error);
      sendAgentOperationFailed(res);
    }
  })
);

/**
 * POST /agents/:agentId/heartbeat — Agent heartbeat
 */
router.post(
  '/agents/:agentId/heartbeat',
  requireActionPlanRoles('operator'),
  validateParams(agentIdSchema),
  asyncHandler(async (_req, res) => {
    res.status(403).json({
      ok: false,
      error: {
        code: 'ACTION_PLAN_LEGACY_AGENT_HEARTBEAT_DISABLED',
        message: 'Legacy ActionPlan agent heartbeat is disabled.',
      },
    });
  })
);

export default router;
