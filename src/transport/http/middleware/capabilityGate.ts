/**
 * Capability Gate Middleware
 *
 * Zero-trust validation: ensures the requesting agent has the declared
 * capability required by the action being executed.
 */

import type { Request, Response, NextFunction } from 'express';
import { validateCapability } from '../../../stores/agentRegistry.js';
import { aiLogger } from '../../../platform/logging/structuredLogging.js';

/**
 * Middleware factory that validates agent capabilities for plan execution.
 * Checks the agent_id in the request body against registered capabilities.
 */
export function capabilityGate(requiredCapability?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const agentId = req.body?.agent_id || req.headers['x-agent-id'];
    const capability = requiredCapability || req.body?.capability;

    if (!agentId) {
      res.status(401).json({ error: 'Missing agent identity (agent_id or x-agent-id header)' });
      return;
    }

    if (!capability) {
      // No capability requirement, pass through
      next();
      return;
    }

    const hasCapability = await validateCapability(agentId as string, capability);

    if (!hasCapability) {
      aiLogger.warn('Capability gate rejected request', {
        module: 'capabilityGate',
        agentId,
        capability,
      });
      res.status(403).json({
        error: 'Agent lacks required capability',
        agent_id: agentId,
        required_capability: capability,
      });
      return;
    }

    next();
  };
}

/**
 * Validate execution signatures (HMAC-SHA256).
 * Placeholder: validates that a signature field exists when required.
 */
export function signatureGate(req: Request, res: Response, next: NextFunction): void {
  const signature = req.body?.signature;
  const agentId = req.body?.agent_id || req.headers['x-agent-id'];

  // For now, signature validation is advisory — log but don't block
  if (!signature && agentId) {
    aiLogger.info('Execution result submitted without signature', {
      module: 'signatureGate',
      agentId,
    });
  }

  next();
}
