import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { createRateLimitMiddleware, securityHeaders } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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

const daemonHeartbeats = new Map<string, DaemonHeartbeat>();
const daemonCommands = new Map<string, DaemonCommand[]>();
const daemonTokensByInstanceId = new Map<string, string>();

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
 * Helper function to queue a command for a daemon instance
 * This can be called by other parts of the backend
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

export function getDaemonTokenForInstance(instanceId: string): string | null {
  const token = daemonTokensByInstanceId.get(instanceId);
  if (!token) {
    //audit Assumption: missing token means daemon not linked; risk: orphan instanceId; invariant: null returned; handling: return null.
    return null;
  }
  return token;
}

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

    // Log the update event
    console.log(`[DAEMON UPDATE] ${instanceId}: ${updateType}`, {
      token: token.substring(0, 8) + '...',
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
 * Helper function to get daemon heartbeat data
 */
export function getDaemonHeartbeat(token: string, instanceId: string): DaemonHeartbeat | undefined {
  const key = `${token}:${instanceId}`;
  return daemonHeartbeats.get(key);
}

export default router;
