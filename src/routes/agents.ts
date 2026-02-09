/**
 * Agent API Routes
 *
 * POST /agents/register         — Register agent with capabilities + public key
 * GET  /agents/:agentId         — Get agent status
 * POST /agents/:agentId/heartbeat — Agent heartbeat
 */

import express, { Request, Response } from 'express';
import { agentRegistrationSchema } from '../types/actionPlan.js';
import {
  registerAgent,
  getAgent,
  updateHeartbeat,
  listAgents,
} from '../stores/agentRegistry.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getConfig } from '../config/unifiedConfig.js';
import { apiLogger } from '../utils/structuredLogging.js';

const router = express.Router();

/**
 * POST /agents/register — Register a new agent
 */
router.post('/agents/register', async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    if (!config.enableActionPlans) {
      res.status(503).json({ error: 'ActionPlans are not enabled' });
      return;
    }

    const parsed = agentRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid agent registration', details: parsed.error.issues });
      return;
    }

    const agent = await registerAgent(parsed.data);
    res.status(201).json(agent);
  } catch (error: unknown) {
    apiLogger.error('Register failed', { module: 'agents', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

/**
 * GET /agents — List all agents
 */
router.get('/agents', async (_: Request, res: Response) => {
  try {
    const agents = await listAgents();
    res.json({ agents, count: agents.length });
  } catch (error: unknown) {
    apiLogger.error('List failed', { module: 'agents', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

/**
 * GET /agents/:agentId — Get agent by ID
 */
router.get('/agents/:agentId', async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(agent);
  } catch (error: unknown) {
    apiLogger.error('Get failed', { module: 'agents', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

/**
 * POST /agents/:agentId/heartbeat — Agent heartbeat
 */
router.post('/agents/:agentId/heartbeat', async (req: Request, res: Response) => {
  try {
    const agent = await updateHeartbeat(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ status: 'ok', agent });
  } catch (error: unknown) {
    aiLogger.error('[AGENTS] Heartbeat failed', { module: 'agents', error: resolveErrorMessage(error) });
    res.status(500).json({ error: 'Failed to update heartbeat' });
  }
});

export default router;
