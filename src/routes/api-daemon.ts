import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, securityHeaders } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getModulesForRegistry } from './modules.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import {
  DAEMON_COMMAND_RETENTION_MS,
  DAEMON_RATE_LIMIT_MAX,
  DAEMON_RATE_LIMIT_WINDOW_MS,
  DAEMON_REGISTRY_RATE_LIMIT_MAX,
  DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS
} from '../config/daemonConfig.js';
import {
  DAEMON_REGISTRY_CORE,
  DAEMON_REGISTRY_ENDPOINTS,
  DAEMON_REGISTRY_TOOLS,
  DAEMON_REGISTRY_VERSION
} from '../config/daemonRegistry.js';
import { DaemonHeartbeat } from './daemonStore.js';
import { daemonLogger, daemonStore } from './api-daemon/context.js';
import { requireDaemonAuth } from './api-daemon/auth.js';
import { createPendingDaemonActions, consumePendingDaemonActions } from './api-daemon/pending.js';

export { createPendingDaemonActions, consumePendingDaemonActions };

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(DAEMON_RATE_LIMIT_MAX, DAEMON_RATE_LIMIT_WINDOW_MS));


const REGISTRY_RATE_LIMIT = createRateLimitMiddleware(
  DAEMON_REGISTRY_RATE_LIMIT_MAX,
  DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS
);


/**
 * POST /api/daemon/heartbeat
 * Daemon sends heartbeat with status, stats, and presence info
 */
router.post(
  '/api/daemon/heartbeat',
  requireDaemonAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { clientId, instanceId, version, uptime, routingMode, stats } = req.body;

    if (!clientId || !instanceId) {
      //audit Assumption: clientId and instanceId required; risk: incomplete heartbeat; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'clientId and instanceId are required'
      });
    }

    // Store heartbeat data
    const heartbeat: DaemonHeartbeat = {
      instanceId,
      clientId,
      version,
      uptime,
      routingMode,
      stats,
      lastSeen: new Date()
    };

    // Use token + instanceId as key to support multiple daemons with same token
    const token = req.daemonToken!;
    daemonStore.recordHeartbeat(token, heartbeat);
    
    // Security: Prevent instanceId hijacking by validating token ownership
    // Only allow setting/updating token mapping if:
    // 1. InstanceId has no existing token (first registration), OR
    // 2. The existing token matches the current token (legitimate update)
    const existingToken = daemonStore.getTokenForInstance(instanceId);
    if (existingToken && existingToken !== token) {
      //audit Assumption: instanceId hijacking attempt detected; risk: unauthorized access; invariant: reject; handling: return 403.
      return res.status(403).json({
        error: 'Forbidden',
        message: 'InstanceId is already registered with a different token'
      });
    }
    
    // Safe to set/update the token mapping
    if (!existingToken) {
      //audit Assumption: new instance mapping required; risk: missing mapping; invariant: persist mapping; handling: save tokens.
      daemonStore.setTokenForInstance(instanceId, token);
      daemonStore.saveTokens();
    }

    res.json({
      pong: true,
      timestamp: new Date().toISOString()
    });
  })
);

/**
 * GET /api/daemon/commands
 * Daemon polls for pending commands
 */
router.get(
  '/api/daemon/commands',
  requireDaemonAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.daemonToken!;
    const instanceId = req.query.instance_id as string | undefined;

    if (!instanceId) {
      //audit Assumption: instance_id required; risk: ambiguous query; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'instance_id query parameter is required'
      });
    }

    // Get pending commands for this daemon instance
    const pendingCommands = daemonStore.listPendingCommands(token, instanceId);

    //audit Assumption: command payloads are safe to expose; risk: leaking sensitive data; invariant: map only required fields; handling: transform.
    res.json({
      commands: pendingCommands.map(cmd => ({
        id: cmd.id,
        name: cmd.name,
        payload: cmd.payload,
        issuedAt: cmd.issuedAt.toISOString()
      }))
    });
  })
);

/**
 * POST /api/daemon/commands/ack
 * Daemon acknowledges processed commands
 */
router.post(
  '/api/daemon/commands/ack',
  requireDaemonAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { commandIds } = req.body;
    const token = req.daemonToken!;
    const instanceId = req.body.instanceId as string | undefined;

    if (!Array.isArray(commandIds) || commandIds.length === 0) {
      //audit Assumption: commandIds required; risk: no-op request; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'commandIds array is required'
      });
    }

    if (!instanceId) {
      //audit Assumption: instanceId required; risk: ambiguous ack; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'instanceId is required in request body'
      });
    }

    // Mark commands as acknowledged
    const acknowledgedCount = daemonStore.acknowledgeCommands(
      token,
      instanceId,
      commandIds,
      DAEMON_COMMAND_RETENTION_MS
    );

    res.json({
      success: true,
      acknowledged: acknowledgedCount
    });
  })
);

/**
 * Purpose: Queue a command for a daemon instance.
 * Inputs/Outputs: token, instanceId, name, payload; returns command ID.
 * Edge cases: Assumes token is valid; stores command in memory.
 */
export function queueDaemonCommand(
  token: string,
  instanceId: string,
  name: string,
  payload: Record<string, unknown>
): string {
  return daemonStore.queueCommand(token, instanceId, name, payload);
}

/**
 * Purpose: Resolve the daemon token associated with an instance ID.
 * Inputs/Outputs: instanceId; returns token or null if missing.
 * Edge cases: Returns null when instance has no recorded token.
 */
export function getDaemonTokenForInstance(instanceId: string): string | null {
  return daemonStore.getTokenForInstance(instanceId);
}

/**
 * Purpose: Queue a command for a daemon instance using its stored token.
 * Inputs/Outputs: instanceId, command name, payload; returns command ID or null.
 * Edge cases: Returns null when instance token is missing.
 */
export function queueDaemonCommandForInstance(
  instanceId: string,
  name: string,
  payload: Record<string, unknown>
): string | null {
  return daemonStore.queueCommandForInstance(instanceId, name, payload);
}

/**
 * POST /api/daemon/confirm-actions
 * Daemon confirms and queues sensitive actions after user approval
 */
router.post(
  '/api/daemon/confirm-actions',
  requireDaemonAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { confirmation_token: confirmationToken, instanceId } = req.body as {
      confirmation_token?: string;
      instanceId?: string;
    };

    if (!confirmationToken || typeof confirmationToken !== 'string') {
      //audit Assumption: confirmation token required; risk: invalid request; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'confirmation_token is required'
      });
    }

    if (!instanceId || typeof instanceId !== 'string') {
      //audit Assumption: instanceId required; risk: invalid request; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'instanceId is required'
      });
    }

    const queued = consumePendingDaemonActions(confirmationToken, instanceId, req.daemonToken!);
    if (queued < 0) {
      //audit Assumption: invalid/expired token should fail; risk: stale confirmation; invariant: 404 returned; handling: reject.
      return res.status(404).json({
        error: 'Not Found',
        message: 'Confirmation token invalid or expired'
      });
    }

    return res.json({
      status: 'executed',
      queued
    });
  })
);

/**
 * GET /api/daemon/registry
 * Daemon reads curated backend registry for prompt construction
 */
router.get(
  '/api/daemon/registry',
  requireDaemonAuth,
  REGISTRY_RATE_LIMIT,
  asyncHandler(async (_req: Request, res: Response) => {
    //audit Assumption: registry is safe to expose; risk: leaking internal metadata; invariant: curated registry only; handling: return static config.
    const registry = {
      version: DAEMON_REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      endpoints: DAEMON_REGISTRY_ENDPOINTS,
      modules: getModulesForRegistry(),
      daemonTools: DAEMON_REGISTRY_TOOLS,
      core: DAEMON_REGISTRY_CORE
    };

    res.json(registry);
  })
);

/**
 * POST /api/update
 * Daemon sends update events (same as existing daemon update functionality)
 */
router.post(
  '/api/update',
  requireDaemonAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { updateType, data } = req.body;

    if (!updateType || typeof updateType !== 'string') {
      //audit Assumption: updateType required; risk: invalid update; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'updateType is required and must be a string'
      });
    }

    if (!data || typeof data !== 'object') {
      //audit Assumption: data payload required; risk: invalid update; invariant: 400 returned; handling: reject.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'data is required and must be an object'
      });
    }

    // Store update event (in production, this should be persisted to database)
    // For now, we just acknowledge receipt
    const token = req.daemonToken!;
    const instanceId = (req.body.metadata?.instanceId as string) || 'unknown';

    // Log the update event (using trace event for daemon updates)
    //audit Assumption: data keys are safe for telemetry; risk: sensitive keys; invariant: log only keys; handling: Object.keys.
    recordTraceEvent('daemon.update', {
      instanceId,
      updateType,
      dataKeys: Object.keys(data)
    });

    res.json({
      success: true,
      timestamp: new Date().toISOString()
    });
  })
);

/**
 * Purpose: Get daemon heartbeat data for a token and instance.
 * Inputs/Outputs: token, instanceId; returns DaemonHeartbeat or undefined.
 * Edge cases: Returns undefined when no heartbeat is recorded.
 */
export function getDaemonHeartbeat(token: string, instanceId: string): DaemonHeartbeat | undefined {
  return daemonStore.getHeartbeat(token, instanceId);
}

export default router;
