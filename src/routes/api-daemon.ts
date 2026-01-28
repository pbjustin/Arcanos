import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { createRateLimitMiddleware, securityHeaders } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getModulesForRegistry } from './modules.js';
import { recordTraceEvent } from '../utils/telemetry.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(120, 10 * 60 * 1000)); // 120 requests per 10 minutes

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  return parts[1] || null;
}

/**
 * Middleware to verify daemon Bearer token
 */
function requireDaemonAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    //audit Assumption: missing token is unauthorized; risk: unauthorized access; invariant: 401 returned; handling: reject.
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token required in Authorization header'
    });
    return;
  }

  // Store token in request for later use
  req.daemonToken = token;
  next();
}

// In-memory storage for daemon heartbeat data and commands
// TODO: Replace in-memory storage with a persistent solution (e.g., Redis or a database) for production.
// In production, this should be stored in a database or Redis
interface DaemonHeartbeat {
  instanceId: string;
  clientId: string;
  version?: string;
  uptime?: number;
  routingMode?: string;
  stats?: Record<string, unknown>;
  lastSeen: Date;
}

interface DaemonCommand {
  id: string;
  instanceId: string;
  name: string;
  payload: Record<string, unknown>;
  issuedAt: Date;
  acknowledged: boolean;
}

interface PendingDaemonAction {
  daemon: string;
  payload: Record<string, unknown>;
  summary: string;
}

interface PendingDaemonActions {
  id: string;
  instanceId: string;
  actions: PendingDaemonAction[];
  expiresAt: Date;
}

const daemonHeartbeats = new Map<string, DaemonHeartbeat>();
const daemonCommands = new Map<string, DaemonCommand[]>();
const daemonTokensByInstanceId = new Map<string, string>();
const pendingDaemonActions = new Map<string, PendingDaemonActions>();

const PENDING_DAEMON_ACTION_TTL_MS = 5 * 60 * 1000;
const REGISTRY_RATE_LIMIT = createRateLimitMiddleware(30, 10 * 60 * 1000);
const DAEMON_REGISTRY_VERSION = 1;
const DAEMON_REGISTRY_ENDPOINTS = [
  {
    path: '/api/ask',
    method: 'POST',
    description: 'Core logic, module routing, daemon tools'
  },
  {
    path: '/api/vision',
    method: 'POST',
    description: 'Image analysis'
  },
  {
    path: '/api/transcribe',
    method: 'POST',
    description: 'Audio transcription'
  },
  {
    path: '/api/daemon/commands',
    method: 'GET',
    description: 'Daemon poll for commands'
  },
  {
    path: '/api/daemon/confirm-actions',
    method: 'POST',
    description: 'Confirm and queue sensitive daemon actions'
  }
];
const DAEMON_REGISTRY_TOOLS = [
  {
    name: 'run_command',
    description: 'Run a command on the user machine',
    sensitive: true
  },
  {
    name: 'capture_screen',
    description: 'Capture screen or camera',
    sensitive: false
  }
];
const DAEMON_REGISTRY_CORE = [
  {
    id: 'CLEAR 2.0',
    description: 'Audit engine'
  },
  {
    id: 'HRC',
    description: 'Hallucination-Resistant Core',
    modes: ['HRC:STRICT', 'HRC:LENIENT', 'HRC:SILENTFAIL', 'HRC->CLEAR']
  }
];

/**
 * Purpose: Create a pending confirmation bundle for sensitive daemon actions.
 * Inputs/Outputs: instanceId and action list; returns confirmation token ID.
 * Edge cases: Empty action list still creates a token; callers should gate on length.
 */
export function createPendingDaemonActions(instanceId: string, actions: PendingDaemonAction[]): string {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + PENDING_DAEMON_ACTION_TTL_MS);
  pendingDaemonActions.set(id, {
    id,
    instanceId,
    actions,
    expiresAt
  });
  return id;
}

/**
 * Purpose: Consume a pending confirmation token and queue its daemon actions.
 * Inputs/Outputs: confirmation token, instanceId, daemon token; returns queued count or -1 on invalid.
 * Edge cases: Returns -1 for missing/expired tokens or mismatched instance/token.
 */
export function consumePendingDaemonActions(
  confirmationToken: string,
  instanceId: string,
  daemonToken: string
): number {
  const pending = pendingDaemonActions.get(confirmationToken);
  if (!pending) {
    //audit Assumption: missing pending token means invalid; risk: stale confirmation; invariant: reject; handling: return -1.
    return -1;
  }

  if (pending.expiresAt.getTime() <= Date.now()) {
    //audit Assumption: expired tokens must be rejected; risk: late execution; invariant: reject; handling: delete and return -1.
    pendingDaemonActions.delete(confirmationToken);
    return -1;
  }

  if (pending.instanceId !== instanceId) {
    //audit Assumption: instanceId must match; risk: cross-instance execution; invariant: reject; handling: return -1.
    return -1;
  }

  const expectedToken = getDaemonTokenForInstance(instanceId);
  if (!expectedToken || expectedToken !== daemonToken) {
    //audit Assumption: daemon token must match; risk: unauthorized execution; invariant: reject; handling: return -1.
    return -1;
  }

  let queuedCount = 0;
  for (const action of pending.actions) {
    const commandId = queueDaemonCommandForInstance(instanceId, action.daemon, action.payload);
    if (commandId) {
      //audit Assumption: queue returns ID on success; risk: command not queued; invariant: count successes; handling: increment.
      queuedCount += 1;
    } else {
      //audit Assumption: queue failures are possible; risk: missing action; invariant: skip failed; handling: continue.
    }
  }

  pendingDaemonActions.delete(confirmationToken);
  return queuedCount;
}

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
    const key = `${token}:${instanceId}`;
    daemonHeartbeats.set(key, heartbeat);
    //audit Assumption: instanceId uniquely identifies daemon; risk: stale token mapping; invariant: latest token wins; handling: overwrite mapping.
    daemonTokensByInstanceId.set(instanceId, token);

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
      return res.status(400).json({
        error: 'Bad Request',
        message: 'instance_id query parameter is required'
      });
    }

    // Get pending commands for this daemon instance
    const key = `${token}:${instanceId}`;
    const commands = daemonCommands.get(key) || [];
    const pendingCommands = commands.filter(cmd => !cmd.acknowledged);

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
      return res.status(400).json({
        error: 'Bad Request',
        message: 'commandIds array is required'
      });
    }

    if (!instanceId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'instanceId is required in request body'
      });
    }

    // Mark commands as acknowledged
    const key = `${token}:${instanceId}`;
    const commands = daemonCommands.get(key) || [];
    let acknowledgedCount = 0;

    // Use Map for O(1) lookups instead of O(N*M) with find()
    const commandMap = new Map(commands.map(c => [c.id, c]));
    for (const cmdId of commandIds) {
      const cmd = commandMap.get(cmdId);
      if (cmd && !cmd.acknowledged) {
        cmd.acknowledged = true;
        acknowledgedCount++;
      }
    }

    // Clean up old acknowledged commands (older than 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const activeCommands = commands.filter(
      cmd => !cmd.acknowledged || cmd.issuedAt > oneHourAgo
    );
    daemonCommands.set(key, activeCommands);

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
  const key = `${token}:${instanceId}`;
  const commands = daemonCommands.get(key) || [];
  const commandId = randomUUID();
  
  const command: DaemonCommand = {
    id: commandId,
    instanceId,
    name,
    payload,
    issuedAt: new Date(),
    acknowledged: false
  };

  commands.push(command);
  daemonCommands.set(key, commands);

  return commandId;
}

/**
 * Purpose: Resolve the daemon token associated with an instance ID.
 * Inputs/Outputs: instanceId; returns token or null if missing.
 * Edge cases: Returns null when instance has no recorded token.
 */
export function getDaemonTokenForInstance(instanceId: string): string | null {
  const token = daemonTokensByInstanceId.get(instanceId);
  if (!token) {
    //audit Assumption: missing token means daemon not linked; risk: orphan instanceId; invariant: null returned; handling: return null.
    return null;
  }
  return token;
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
  const token = getDaemonTokenForInstance(instanceId);
  if (!token) {
    //audit Assumption: daemon token required for queueing; risk: orphan instanceId; invariant: null returned; handling: return null.
    return null;
  }
  return queueDaemonCommand(token, instanceId, name, payload);
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
      return res.status(400).json({
        error: 'Bad Request',
        message: 'updateType is required and must be a string'
      });
    }

    if (!data || typeof data !== 'object') {
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
  const key = `${token}:${instanceId}`;
  return daemonHeartbeats.get(key);
}

export default router;
