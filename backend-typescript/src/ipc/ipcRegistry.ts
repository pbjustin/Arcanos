/**
 * In-memory registry for active IPC connections.
 */

import { WebSocket } from 'ws';
import { IpcCommandMessage, IpcMessage } from './ipcTypes';

export interface IpcConnection {
  connectionId: string;
  userId: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  clientId?: string;
  instanceId?: string;
  platform?: string;
  ipAddress?: string;
  userAgent?: string;
  daemonGptId?: string;
}

export interface IpcCommandDispatchResult {
  ok: boolean;
  sentCount: number;
  connectionIds: string[];
  error?: string;
}

export interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface IpcConnectionRegistry {
  registerConnection: (connection: IpcConnection) => void;
  removeConnection: (connectionId: string) => void;
  touchConnection: (connectionId: string, timestampMs: number) => void;
  updateMetadata: (connectionId: string, metadata: Partial<IpcConnection>) => void;
  listConnections: (userId?: string) => IpcConnection[];
  sendMessageToConnection: (connectionId: string, message: IpcMessage) => boolean;
  sendCommandToUser: (userId: string, message: IpcCommandMessage) => IpcCommandDispatchResult;
}

function safeSerialize(message: IpcMessage): string | null {
  try {
    return JSON.stringify(message);
  } catch {
    //audit assumption: serialization can fail; risk: drop message; invariant: message not sent; strategy: return null.
    return null;
  }
}

/**
 * Create a connection registry for IPC sockets.
 * Inputs/Outputs: logger dependency; returns registry instance.
 * Edge cases: send failures return false without throwing.
 */
export function createIpcConnectionRegistry(logger: LoggerLike): IpcConnectionRegistry {
  const connections = new Map<string, IpcConnection>();

  const registerConnection = (connection: IpcConnection) => {
    //audit assumption: connectionId unique; risk: overwrite existing; invariant: new connection stored; strategy: set in map.
    connections.set(connection.connectionId, connection);
  };

  const removeConnection = (connectionId: string) => {
    //audit assumption: connection may exist; risk: stale entry; invariant: entry removed; strategy: delete from map.
    connections.delete(connectionId);
  };

  const touchConnection = (connectionId: string, timestampMs: number) => {
    const connection = connections.get(connectionId);
    if (!connection) {
      //audit assumption: connection may be missing; risk: stale touch; invariant: ignore; strategy: return.
      return;
    }
    connection.lastSeenAt = timestampMs;
  };

  const updateMetadata = (connectionId: string, metadata: Partial<IpcConnection>) => {
    const connection = connections.get(connectionId);
    if (!connection) {
      //audit assumption: connection may be missing; risk: stale update; invariant: ignore; strategy: return.
      return;
    }
    Object.assign(connection, metadata);
  };

  const listConnections = (userId?: string) => {
    if (!userId) {
      //audit assumption: no user filter lists all; risk: larger payload; invariant: return all; strategy: array copy.
      return Array.from(connections.values());
    }
    return Array.from(connections.values()).filter((conn) => conn.userId === userId);
  };

  const sendMessageToConnection = (connectionId: string, message: IpcMessage): boolean => {
    const connection = connections.get(connectionId);
    if (!connection) {
      //audit assumption: connection must exist; risk: message dropped; invariant: false returned; strategy: return false.
      return false;
    }
    if (connection.socket.readyState !== WebSocket.OPEN) {
      //audit assumption: socket must be open; risk: send failure; invariant: false returned; strategy: return false.
      return false;
    }
    const payload = safeSerialize(message);
    if (!payload) {
      //audit assumption: serialization must succeed; risk: message dropped; invariant: false returned; strategy: return false.
      return false;
    }

    try {
      connection.socket.send(payload);
      return true;
    } catch (error) {
      //audit assumption: send can fail; risk: message dropped; invariant: error logged; strategy: return false.
      logger.warn('IPC send failed', { error, connectionId });
      return false;
    }
  };

  const sendCommandToUser = (userId: string, message: IpcCommandMessage): IpcCommandDispatchResult => {
    const targetConnections = listConnections(userId);
    if (!targetConnections.length) {
      //audit assumption: no connections for user; risk: command lost; invariant: return error; strategy: return ok=false.
      return { ok: false, sentCount: 0, connectionIds: [], error: 'No active IPC connections for user' };
    }

    const payload = safeSerialize(message);
    if (!payload) {
      //audit assumption: serialization must succeed; risk: command dropped; invariant: return error; strategy: ok=false.
      return { ok: false, sentCount: 0, connectionIds: [], error: 'Failed to serialize IPC command' };
    }

    const sentConnections: string[] = [];
    for (const connection of targetConnections) {
      if (connection.socket.readyState !== WebSocket.OPEN) {
        //audit assumption: only open sockets send; risk: skipped connections; invariant: skip; strategy: continue.
        continue;
      }
      try {
        connection.socket.send(payload);
        sentConnections.push(connection.connectionId);
      } catch (error) {
        //audit assumption: send can fail; risk: partial delivery; invariant: error logged; strategy: continue.
        logger.warn('IPC command send failed', { error, connectionId: connection.connectionId });
      }
    }

    if (!sentConnections.length) {
      //audit assumption: sends may fail; risk: no delivery; invariant: return error; strategy: ok=false.
      return { ok: false, sentCount: 0, connectionIds: [], error: 'No IPC connections accepted the command' };
    }

    return {
      ok: true,
      sentCount: sentConnections.length,
      connectionIds: sentConnections
    };
  };

  return {
    registerConnection,
    removeConnection,
    touchConnection,
    updateMetadata,
    listConnections,
    sendMessageToConnection,
    sendCommandToUser
  };
}
