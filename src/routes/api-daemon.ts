import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { asyncHandler, sendBadRequestPayload, sendNotFoundPayload } from '@shared/http/index.js';
import { DAEMON_STORE_PARTITION } from '@shared/daemon/daemonTransportContract.js';
import { requireDaemonPlaneAuth } from '@transport/http/middleware/daemonPlaneAuth.js';
import {
  getModulesForRegistry,
  initializeModuleRegistry
} from '@services/moduleRegistry.js';
import {
  DAEMON_COMMAND_RETENTION_MS,
  DAEMON_RATE_LIMIT_MAX,
  DAEMON_RATE_LIMIT_WINDOW_MS,
  DAEMON_REGISTRY_RATE_LIMIT_MAX,
  DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS
} from "@platform/runtime/daemonConfig.js";
import {
  DAEMON_REGISTRY_CORE,
  DAEMON_REGISTRY_ENDPOINTS,
  DAEMON_REGISTRY_TOOLS,
  DAEMON_REGISTRY_VERSION
} from "@platform/runtime/daemonRegistry.js";
import { DaemonHeartbeat } from './daemonStore.js';
import { daemonStore } from './api-daemon/context.js';
import { createPendingDaemonActions, consumePendingDaemonActions } from './api-daemon/pending.js';

export { createPendingDaemonActions, consumePendingDaemonActions };

const router = express.Router();

const daemonRateLimit = createRateLimitMiddleware(DAEMON_RATE_LIMIT_MAX, DAEMON_RATE_LIMIT_WINDOW_MS);
router.use('/api/daemon', securityHeaders, daemonRateLimit, requireDaemonPlaneAuth);

const REGISTRY_RATE_LIMIT = createRateLimitMiddleware(
  DAEMON_REGISTRY_RATE_LIMIT_MAX,
  DAEMON_REGISTRY_RATE_LIMIT_WINDOW_MS
);

/**
 * Resolve an instance's compatibility-only store partition. Historical values
 * are deliberately kept route-local because some deployments may have
 * persisted former Bearer credentials before daemon auth became anonymous.
 */
function resolveDaemonStorePartition(instanceId: string): string {
  return daemonStore.getTokenForInstance(instanceId) ?? DAEMON_STORE_PARTITION;
}

/**
 * POST /api/daemon/heartbeat
 * Daemon sends heartbeat with status, stats, and presence info
 */
router.post(
  '/api/daemon/heartbeat',
  asyncHandler(async (req: Request, res: Response) => {
    const { clientId, instanceId, version, uptime, routingMode, stats } = req.body;

    if (!clientId || !instanceId) {
      //audit Assumption: clientId and instanceId required; risk: incomplete heartbeat; invariant: 400 returned; handling: reject.
      return sendBadRequestPayload(res, {
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

    const existingPartition = daemonStore.getTokenForInstance(instanceId);
    const storePartition = existingPartition ?? DAEMON_STORE_PARTITION;

    if (!existingPartition) {
      //audit Assumption: new instance mapping required; risk: missing mapping; invariant: persist only the non-secret canonical partition; handling: save tokens.
      daemonStore.setTokenForInstance(instanceId, storePartition);
      daemonStore.saveTokens();
    }

    // Ownership lookup/registration must complete before any heartbeat mutation.
    daemonStore.recordHeartbeat(storePartition, heartbeat);

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
  asyncHandler(async (req: Request, res: Response) => {
    const instanceId = req.query.instance_id as string | undefined;

    if (!instanceId) {
      //audit Assumption: instance_id required; risk: ambiguous query; invariant: 400 returned; handling: reject.
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'instance_id query parameter is required'
      });
    }

    // Get pending commands for this daemon instance
    const storePartition = resolveDaemonStorePartition(instanceId);
    const pendingCommands = daemonStore.listPendingCommands(storePartition, instanceId);

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
  asyncHandler(async (req: Request, res: Response) => {
    const { commandIds } = req.body;
    const instanceId = req.body.instanceId as string | undefined;

    if (!Array.isArray(commandIds) || commandIds.length === 0) {
      //audit Assumption: commandIds required; risk: no-op request; invariant: 400 returned; handling: reject.
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'commandIds array is required'
      });
    }

    if (!instanceId) {
      //audit Assumption: instanceId required; risk: ambiguous ack; invariant: 400 returned; handling: reject.
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'instanceId is required in request body'
      });
    }

    const storePartition = resolveDaemonStorePartition(instanceId);

    // Mark commands as acknowledged
    const acknowledgedCount = daemonStore.acknowledgeCommands(
      storePartition,
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
 * Purpose: Fetch a daemon command result for an instance.
 * Inputs/Outputs: instanceId, commandId; returns result record or null.
 */
export function getDaemonCommandResultForInstance(
  instanceId: string,
  commandId: string
): Record<string, unknown> | null {
  const storePartition = resolveDaemonStorePartition(instanceId);
  const entry = daemonStore.getCommandResult(storePartition, instanceId, commandId);
  return entry ? entry.result : null;
}


/**
 * POST /api/daemon/commands/result
 * Daemon reports the result/output of a processed command
 */
router.post(
  '/api/daemon/commands/result',
  asyncHandler(async (req: Request, res: Response) => {
    const instanceId = req.body.instanceId as string | undefined;
    const commandId = req.body.commandId as string | undefined;
    const result = req.body.result as unknown;

    if (!instanceId || !commandId) {
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'instanceId and commandId are required'
      });
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'result must be an object'
      });
    }

    const storePartition = resolveDaemonStorePartition(instanceId);
    daemonStore.recordCommandResult(
      storePartition,
      instanceId,
      commandId,
      result as Record<string, unknown>
    );
    res.json({ ok: true });
  })
);

/**
 * POST /api/daemon/confirm-actions
 * Daemon confirms and queues sensitive actions after user approval
 */
router.post(
  '/api/daemon/confirm-actions',
  asyncHandler(async (req: Request, res: Response) => {
    const { confirmation_token: confirmationToken, instanceId } = req.body as {
      confirmation_token?: string;
      instanceId?: string;
    };

    if (!confirmationToken || typeof confirmationToken !== 'string') {
      //audit Assumption: confirmation token required; risk: invalid request; invariant: 400 returned; handling: reject.
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'confirmation_token is required'
      });
    }

    if (!instanceId || typeof instanceId !== 'string') {
      //audit Assumption: instanceId required; risk: invalid request; invariant: 400 returned; handling: reject.
      return sendBadRequestPayload(res, {
        error: 'Bad Request',
        message: 'instanceId is required'
      });
    }

    const storePartition = daemonStore.getTokenForInstance(instanceId);
    if (!storePartition) {
      // A successful heartbeat must establish the instance before confirmation.
      return sendNotFoundPayload(res, {
        error: 'Not Found',
        message: 'Confirmation token invalid or expired'
      });
    }

    const queued = consumePendingDaemonActions(
      confirmationToken,
      instanceId,
      storePartition
    );
    if (queued < 0) {
      //audit Assumption: invalid/expired token should fail; risk: stale confirmation; invariant: 404 returned; handling: reject.
      return sendNotFoundPayload(res, {
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
  REGISTRY_RATE_LIMIT,
  asyncHandler(async (_req: Request, res: Response) => {
    await initializeModuleRegistry();
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

// Authenticated unknown daemon-plane paths must terminate here instead of
// falling through to writing-plane routing or unrelated API handlers.
router.use('/api/daemon', (_req: Request, res: Response) =>
  sendNotFoundPayload(res, {
    error: 'Not Found',
    message: 'Daemon endpoint not found'
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
