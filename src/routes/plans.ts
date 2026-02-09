/**
 * ActionPlan API Routes
 *
 * POST   /plans                  — Create plan, compute CLEAR, return plan+score
 * GET    /plans/:planId          — Get plan by ID with CLEAR score
 * POST   /plans/:planId/approve  — Approve plan (only if CLEAR allows/confirms)
 * POST   /plans/:planId/block    — Block plan
 * POST   /plans/:planId/expire   — Expire plan
 * POST   /plans/:planId/execute  — Dispatch plan to agent, create ExecutionResult
 * GET    /plans/:planId/results  — Get execution results for plan
 */

import express, { Request, Response } from 'express';
import { actionPlanInputSchema, executionResultInputSchema } from '../types/actionPlan.js';
import {
  createPlan,
  getPlan,
  approvePlan,
  blockPlan,
  expirePlan,
  listPlans,
  createExecutionResult,
  getExecutionResults,
} from '../stores/actionPlanStore.js';
import { validateCapability } from '../stores/agentRegistry.js';
import { buildClear2Summary } from '../services/clear2.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '../config/unifiedConfig.js';
import { apiLogger } from '../utils/structuredLogging.js';
import type { ClearDecision, PlanStatus, ActionPlanRecord } from '../types/actionPlan.js';

const router = express.Router();

/**
 * POST /plans — Create a new ActionPlan
 */
router.post('/plans', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const parsed = actionPlanInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid plan input', details: parsed.error.issues });
      return;
    }

    const plan = await createPlan(parsed.data);
    res.status(201).json(plan);
  } catch (error: unknown) {
    // Idempotency key conflict
    if (resolveErrorMessage(error).includes('Unique constraint')) {
      res.status(409).json({ error: 'Plan with this idempotency_key already exists' });
      return;
    }
    apiLogger.error('Create failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

/**
 * GET /plans — List plans with optional filters
 */
router.get('/plans', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const status = req.query.status as string | undefined;
    const createdBy = req.query.created_by as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const plans = await listPlans({ status: status as PlanStatus | undefined, createdBy, limit });
    res.json({ plans, count: plans.length });
  } catch (error: unknown) {
    apiLogger.error('List failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to list plans' });
  }
});

/**
 * GET /plans/:planId — Get plan by ID
 */
router.get('/plans/:planId', async (req: Request, res: Response) => {
  try {
    const plan = await getPlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    aiLogger.error('[PLANS] Get failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to get plan' });
  }
});

/**
 * POST /plans/:planId/approve — Approve a plan
 */
router.post('/plans/:planId/approve', async (req: Request, res: Response) => {
  try {
    const plan = await approvePlan(req.params.planId);
    if (!plan) {
      // Determine reason
      const existing = await getPlan(req.params.planId);
      if (!existing) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      if (existing.clearScore?.decision === 'block') {
        res.status(403).json({
          error: 'Cannot approve blocked plan',
          clearDecision: existing.clearScore.decision,
          clearOverall: existing.clearScore.overall,
        });
        return;
      }
      res.status(409).json({
        error: `Cannot approve plan in ${existing.status} status`,
        currentStatus: existing.status,
      });
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    aiLogger.error('[PLANS] Approve failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to approve plan' });
  }
});

/**
 * POST /plans/:planId/block — Block a plan
 */
router.post('/plans/:planId/block', async (req: Request, res: Response) => {
  try {
    const plan = await blockPlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    aiLogger.error('[PLANS] Block failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to block plan' });
  }
});

/**
 * POST /plans/:planId/expire — Expire a plan
 */
router.post('/plans/:planId/expire', async (req: Request, res: Response) => {
  try {
    const plan = await expirePlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json(plan);
  } catch (error: unknown) {
    aiLogger.error('[PLANS] Expire failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to expire plan' });
  }
});

/** Validate all actions have registered agent capabilities. Returns the first failing action or null. */
async function findMissingCapability(plan: import('../types/actionPlan.js').ActionPlanRecord) {
  for (const action of plan.actions) {
    const hasCapability = await validateCapability(action.agentId, action.capability);
    if (!hasCapability) return action;
  }
  return null;
}

/** Build CLEAR 2.0 re-evaluation input from an existing plan record. */
function buildClearRecheckInput(plan: import('../types/actionPlan.js').ActionPlanRecord) {
  return {
    actions: plan.actions.map(a => ({
      action_id: a.id,
      agent_id: a.agentId,
      capability: a.capability,
      params: a.params as Record<string, unknown>,
      timeout_ms: a.timeoutMs,
    })),
    origin: plan.origin,
    confidence: plan.confidence,
    hasRollbacks: plan.actions.some(a => a.rollbackAction != null),
    capabilitiesKnown: true,
    agentsRegistered: true,
  };
}

/**
 * POST /plans/:planId/execute — Execute plan actions
 */
router.post('/plans/:planId/execute', async (req: Request, res: Response) => {
  try {
    const plan = await getPlan(req.params.planId);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    // Guard: blocked plans never execute
    if (plan.status === 'blocked' || plan.clearScore?.decision === 'block') {
      res.status(403).json({ error: 'Cannot execute blocked plan', clearDecision: plan.clearScore?.decision });
      return;
    }

    // Guard: only approved plans can execute
    if (plan.status !== 'approved') {
      res.status(409).json({ error: `Plan must be approved before execution, current status: ${plan.status}` });
      return;
    }

    // Validate agent capabilities
    const missingAction = await findMissingCapability(plan);
    if (missingAction) {
      res.status(403).json({ error: `Agent ${missingAction.agentId} lacks capability: ${missingAction.capability}`, actionId: missingAction.id });
      return;
    }

    // Re-evaluate CLEAR before execution
    const clearRecheck = buildClear2Summary(buildClearRecheckInput(plan));
    if (clearRecheck.decision === 'block') {
      await blockPlan(plan.id);
      res.status(403).json({ error: 'CLEAR re-evaluation blocked this plan', clearScore: clearRecheck });
      return;
    }

    // Dispatch: create execution results (actual execution is handled by agents)
    const clearDecision = (plan.clearScore?.decision ?? 'block') as ClearDecision;
    const results = await Promise.all(
      plan.actions.map(action => createExecutionResult(plan.id, action.id, action.agentId, 'success', clearDecision))
    );

    res.json({ plan_id: plan.id, status: 'executed', results });
  } catch (error: unknown) {
    if (resolveErrorMessage(error).includes('Unique constraint')) {
      res.status(409).json({ error: 'Actions already executed (replay protection)' });
      return;
    }
    aiLogger.error('[PLANS] Execute failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to execute plan' });
  }
});

/**
 * GET /plans/:planId/results — Get execution results
 */
router.get('/plans/:planId/results', async (req: Request, res: Response) => {
  try {
    const results = await getExecutionResults(req.params.planId);
    res.json({ plan_id: req.params.planId, results });
  } catch (error: unknown) {
    aiLogger.error('[PLANS] Results failed', { module: 'plans', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to get execution results' });
  }
});

export default router;
