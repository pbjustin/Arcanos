import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { sanitizeInput } from '../utils/security.js';
import type { CommandExecutionResult, CommandExecutionContext } from './commandCenter.js';

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_SESSION_TTL_MS = 60 * 1000; // 1 minute
const MAX_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

type TunnelEventType = 'ready' | 'ack' | 'result' | 'error' | 'heartbeat' | 'info';

export interface CommandTunnelEvent {
  type: TunnelEventType;
  data: Record<string, unknown>;
}

interface CommandTunnelSession {
  id: string;
  token: string;
  emitter: EventEmitter;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  isStreaming: boolean;
}

export interface TunnelSessionSummary {
  clientId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  streamPath: string;
}

export interface TunnelSessionOptions {
  clientId?: string;
  requestedTtlMs?: number;
}

const sessions = new Map<string, CommandTunnelSession>();

function clampTtl(requestedTtl?: number): number {
  if (!requestedTtl) {
    return DEFAULT_SESSION_TTL_MS;
  }

  return Math.min(Math.max(requestedTtl, MIN_SESSION_TTL_MS), MAX_SESSION_TTL_MS);
}

function createToken(): string {
  return randomUUID().replace(/-/g, '');
}

function now(): number {
  return Date.now();
}

function sanitizeClientId(candidate?: string): string | undefined {
  if (!candidate) return undefined;
  const sanitized = sanitizeInput(candidate);
  return sanitized.length > 0 ? sanitized : undefined;
}

function buildSession(id: string, ttlMs: number): CommandTunnelSession {
  const createdAt = now();
  return {
    id,
    token: createToken(),
    emitter: new EventEmitter(),
    createdAt,
    lastActivity: createdAt,
    expiresAt: createdAt + ttlMs,
    isStreaming: false
  };
}

function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.emitter.removeAllListeners();
  }
  sessions.delete(sessionId);
}

function getSession(sessionId: string): CommandTunnelSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) {
    return undefined;
  }

  if (session.expiresAt <= now()) {
    cleanupSession(sessionId);
    return undefined;
  }

  return session;
}

function verifySession(sessionId: string, token: string | undefined): CommandTunnelSession | undefined {
  if (!token) return undefined;
  const session = getSession(sessionId);
  if (!session) return undefined;
  if (session.token !== token) return undefined;
  return session;
}

function touchSession(session: CommandTunnelSession, extend: boolean = false): void {
  session.lastActivity = now();
  if (extend) {
    const ttl = clampTtl(DEFAULT_SESSION_TTL_MS);
    session.expiresAt = Math.min(session.lastActivity + ttl, session.createdAt + MAX_SESSION_TTL_MS);
  }
}

export function createTunnelSession(options: TunnelSessionOptions = {}): TunnelSessionSummary {
  const sanitizedId = sanitizeClientId(options.clientId);
  const ttlMs = clampTtl(options.requestedTtlMs);
  const clientId = sanitizedId && !sessions.has(sanitizedId) ? sanitizedId : randomUUID();

  const existing = sessions.get(clientId);
  if (existing) {
    existing.token = createToken();
    existing.expiresAt = Math.min(now() + ttlMs, existing.createdAt + MAX_SESSION_TTL_MS);
    touchSession(existing);
    return {
      clientId: existing.id,
      token: existing.token,
      createdAt: new Date(existing.createdAt).toISOString(),
      expiresAt: new Date(existing.expiresAt).toISOString(),
      streamPath: `/api/commands/tunnel/stream/${existing.id}`
    };
  }

  const session = buildSession(clientId, ttlMs);
  sessions.set(clientId, session);

  return {
    clientId: session.id,
    token: session.token,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    streamPath: `/api/commands/tunnel/stream/${session.id}`
  };
}

export function subscribeToSession(
  clientId: string,
  token: string,
  listener: (event: CommandTunnelEvent) => void
): { unsubscribe: () => void } | undefined {
  const session = verifySession(clientId, token);
  if (!session) {
    return undefined;
  }

  session.isStreaming = true;
  const handler = (event: CommandTunnelEvent) => listener(event);
  session.emitter.on('event', handler);
  touchSession(session);

  return {
    unsubscribe: () => {
      const current = sessions.get(clientId);
      if (!current) return;
      current.emitter.off('event', handler);
      current.isStreaming = false;
      touchSession(current);
    }
  };
}

export function publishToSession(
  clientId: string,
  token: string,
  event: CommandTunnelEvent
): boolean {
  const session = verifySession(clientId, token);
  if (!session) {
    return false;
  }

  session.emitter.emit('event', event);
  touchSession(session);
  return true;
}

export function heartbeatSession(clientId: string, token: string): TunnelSessionSummary | undefined {
  const session = verifySession(clientId, token);
  if (!session) {
    return undefined;
  }

  touchSession(session, true);

  return {
    clientId: session.id,
    token: session.token,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    streamPath: `/api/commands/tunnel/stream/${session.id}`
  };
}

export function closeSession(clientId: string, token: string): boolean {
  const session = verifySession(clientId, token);
  if (!session) {
    return false;
  }

  cleanupSession(clientId);
  return true;
}

export function buildTunnelContext(clientId: string, token: string): CommandExecutionContext | undefined {
  const session = verifySession(clientId, token);
  if (!session) {
    return undefined;
  }

  touchSession(session);
  return {
    clientId
  };
}

export function publishResult(
  clientId: string,
  token: string,
  result: CommandExecutionResult
): boolean {
  return publishToSession(clientId, token, {
    type: 'result',
    data: result as unknown as Record<string, unknown>
  });
}

export function publishAck(
  clientId: string,
  token: string,
  data: Record<string, unknown>
): boolean {
  return publishToSession(clientId, token, {
    type: 'ack',
    data
  });
}

export function publishError(
  clientId: string,
  token: string,
  error: string,
  context: Record<string, unknown> = {}
): boolean {
  return publishToSession(clientId, token, {
    type: 'error',
    data: {
      error,
      ...context
    }
  });
}

setInterval(() => {
  const expirationCutoff = now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= expirationCutoff) {
      cleanupSession(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function getActiveSessionCount(): number {
  return sessions.size;
}

export function getSessionSnapshot(clientId: string, token: string): TunnelSessionSummary | undefined {
  const session = verifySession(clientId, token);
  if (!session) {
    return undefined;
  }

  return {
    clientId: session.id,
    token: session.token,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    streamPath: `/api/commands/tunnel/stream/${session.id}`
  };
}
