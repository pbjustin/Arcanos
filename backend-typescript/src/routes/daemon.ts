/**
 * Daemon IPC route
 * Sends commands to connected daemon clients via WebSocket bridge.
 */

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { IpcConnectionRegistry, LoggerLike } from '../ipc/ipcRegistry';
import { buildCommandMessage } from '../ipc/ipcTypes';

interface CommandRequest {
  command: string;
  payload?: Record<string, unknown>;
  targetUserId?: string;
}

interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const MAX_COMMAND_LENGTH = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  //audit assumption: payload must be object; risk: invalid schema; invariant: plain object; strategy: type guard.
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseCommandRequest(body: unknown): ParseResult<CommandRequest> {
  if (!isPlainObject(body)) {
    //audit assumption: body should be object; risk: invalid payload; invariant: object; strategy: error.
    return { ok: false, error: 'request body must be an object' };
  }

  const command = body.command;
  if (typeof command !== 'string' || !command.trim()) {
    //audit assumption: command required; risk: missing command; invariant: command string; strategy: error.
    return { ok: false, error: 'command is required' };
  }
  if (command.trim().length > MAX_COMMAND_LENGTH) {
    //audit assumption: command length bounded; risk: oversized payload; invariant: max length; strategy: error.
    return { ok: false, error: `command exceeds ${MAX_COMMAND_LENGTH} characters` };
  }

  const payload = body.payload;
  if (payload !== undefined && !isPlainObject(payload)) {
    //audit assumption: payload must be object when provided; risk: invalid payload; invariant: object; strategy: error.
    return { ok: false, error: 'payload must be an object' };
  }

  const targetUserId = typeof body.targetUserId === 'string' && body.targetUserId.trim()
    ? body.targetUserId.trim()
    : undefined;

  return {
    ok: true,
    value: {
      command: command.trim(),
      payload: payload ? payload as Record<string, unknown> : undefined,
      targetUserId
    }
  };
}

/**
 * Create a router for IPC daemon commands.
 * Inputs/Outputs: registry and logger dependencies; returns configured router.
 * Edge cases: returns 503 when no daemon connection is available.
 */
export function createDaemonRouter(
  registry: IpcConnectionRegistry,
  logger: LoggerLike
): Router {
  const router = Router();

  router.post('/command', (req: Request, res: Response) => {
    const parsed = parseCommandRequest(req.body);
    if (!parsed.ok || !parsed.value) {
      //audit assumption: payload must be valid; risk: bad request; invariant: parsed ok; strategy: return 400.
      return res.status(400).json({
        error: 'Bad Request',
        message: parsed.error || 'Invalid request body'
      });
    }

    const requesterId = req.user?.userId;
    const targetUserId = parsed.value.targetUserId || requesterId;
    if (!targetUserId || !requesterId) {
      //audit assumption: auth required; risk: unauthorized command; invariant: userId present; strategy: return 401.
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User identity is required'
      });
    }

    if (parsed.value.targetUserId && parsed.value.targetUserId !== requesterId) {
      //audit assumption: users can only target themselves; risk: cross-user control; invariant: match userId; strategy: return 403.
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Cannot send commands to other users'
      });
    }

    const commandId = randomUUID();
    const issuedAt = new Date().toISOString();
    const commandMessage = buildCommandMessage(
      commandId,
      parsed.value.command,
      issuedAt,
      parsed.value.payload
    );

    const sendResult = registry.sendCommandToUser(targetUserId, commandMessage);
    if (!sendResult.ok) {
      //audit assumption: daemon must be connected; risk: command lost; invariant: active connection; strategy: return 503.
      logger.warn('IPC command dispatch failed', { error: sendResult.error, targetUserId, commandId });
      return res.status(503).json({
        error: 'Service Unavailable',
        message: sendResult.error || 'No active daemon connections'
      });
    }

    logger.info('IPC command dispatched', {
      commandId,
      targetUserId,
      connections: sendResult.connectionIds.length
    });

    return res.status(202).json({
      success: true,
      commandId,
      deliveredConnections: sendResult.connectionIds
    });
  });

  return router;
}
