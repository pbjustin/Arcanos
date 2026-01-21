/**
 * IPC WebSocket server for daemon connections.
 */

import { randomUUID, timingSafeEqual } from 'crypto';
import { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { IpcServerConfig } from './ipcConfig';
import { IpcConnection, IpcConnectionRegistry, LoggerLike } from './ipcRegistry';
import {
  extractHeaderValue as extractDaemonHeaderValue,
  parseDaemonGptId,
  resolveDaemonGptIdConfig
} from '../daemonGptId';
import {
  buildErrorMessage,
  buildHelloAckMessage,
  IpcCommandResultMessage,
  IpcEventMessage,
  IpcMessage,
  parseIpcMessage
} from './ipcTypes';

export interface IpcEventContext {
  userId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
  sentAt: string;
  source?: string;
  ipAddress?: string;
  userAgent?: string;
  daemonGptId?: string;
}

export interface IpcCommandResultContext {
  userId: string;
  connectionId: string;
  result: IpcCommandResultMessage;
}

type IpcAuthMode = 'jwt' | 'api_key' | 'none';

export interface IpcServerDependencies {
  httpServer: HttpServer;
  config: IpcServerConfig;
  registry: IpcConnectionRegistry;
  logger: LoggerLike;
  verifyToken: (token: string) => { userId: string };
  authMode?: IpcAuthMode;
  apiKey?: string;
  apiKeyHeaderName?: string;
  apiKeyHeaderPrefix?: string | null;
  apiKeyUserId?: string;
  anonymousUserId?: string;
  serverVersion?: string;
  daemonGptHeaderName?: string;
  daemonGptMaxLength?: number;
  onEvent?: (event: IpcEventContext) => Promise<void>;
  onCommandResult?: (result: IpcCommandResultContext) => void;
}

export interface IpcServerHandle {
  wss: WebSocketServer;
  close: () => Promise<void>;
}

function extractHeaderValue(request: IncomingMessage, headerName: string): string | null {
  const headerKey = headerName.toLowerCase();
  const rawValue = request.headers[headerKey];
  if (typeof rawValue === 'string') {
    //audit assumption: header is string; risk: empty value; invariant: return raw; strategy: return string.
    return rawValue;
  }
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    //audit assumption: header array may exist; risk: multiple values; invariant: first value used; strategy: return first.
    return rawValue[0];
  }
  //audit assumption: header missing; risk: unauthorized access; invariant: null returned; strategy: return null.
  return null;
}

function parseCredentialFromHeader(rawHeader: string | null, headerPrefix: string | null): string | null {
  if (!rawHeader) {
    //audit assumption: header required; risk: missing credential; invariant: null returned; strategy: return null.
    return null;
  }
  const trimmedHeader = rawHeader.trim();
  if (!headerPrefix) {
    //audit assumption: prefix disabled; risk: raw token mismatch; invariant: raw header used; strategy: return trimmed header.
    return trimmedHeader;
  }
  const trimmedPrefix = headerPrefix.trim();
  if (!trimmedPrefix) {
    //audit assumption: empty prefix disables prefix check; risk: raw token usage; invariant: raw header used; strategy: return trimmed header.
    return trimmedHeader;
  }
  const expectedPrefix = `${trimmedPrefix} `;
  if (!trimmedHeader.startsWith(expectedPrefix)) {
    //audit assumption: prefix mismatch invalid; risk: invalid auth; invariant: null returned; strategy: return null.
    return null;
  }
  return trimmedHeader.slice(expectedPrefix.length).trim();
}

function extractCredentialFromRequest(
  request: IncomingMessage,
  headerName: string,
  headerPrefix: string | null
): string | null {
  const headerValue = extractHeaderValue(request, headerName);
  const credential = parseCredentialFromHeader(headerValue, headerPrefix);
  if (credential) {
    //audit assumption: header credential preferred; risk: none; invariant: credential returned; strategy: return header credential.
    return credential;
  }

  const rawUrl = request.url || '/';
  const host = request.headers.host || 'localhost';
  try {
    const parsedUrl = new URL(rawUrl, `http://${host}`);
    const token = parsedUrl.searchParams.get('token');
    if (token) {
      //audit assumption: token may be provided via query string; risk: token leakage in logs; invariant: token extracted; strategy: use token.
      return token.trim();
    }
  } catch {
    //audit assumption: URL parsing can fail; risk: token not extracted; invariant: fallback to null; strategy: return null.
    return null;
  }

  return null;
}

function isApiKeyMatch(candidate: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  if (expectedBuffer.length !== candidateBuffer.length) {
    //audit assumption: length mismatch invalid; risk: timing leak; invariant: mismatch returns false; strategy: return false.
    return false;
  }
  //audit assumption: timingSafeEqual reduces timing leaks; risk: side-channel; invariant: compare buffers; strategy: timingSafeEqual.
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

function safeSend(socket: WebSocket, message: IpcMessage, logger: LoggerLike): void {
  if (socket.readyState !== WebSocket.OPEN) {
    //audit assumption: socket must be open; risk: send failure; invariant: skip send; strategy: return.
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    //audit assumption: send can fail; risk: message dropped; invariant: error logged; strategy: log warning.
    logger.warn('IPC send failed', { error });
  }
}

function buildConnection(
  connectionId: string,
  userId: string,
  socket: WebSocket,
  request: IncomingMessage,
  daemonGptId?: string
): IpcConnection {
  const now = Date.now();
  return {
    connectionId,
    userId,
    socket,
    connectedAt: now,
    lastSeenAt: now,
    ipAddress: request.socket.remoteAddress || undefined,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
    daemonGptId
  };
}

/**
 * Create and attach a WebSocket IPC server to an HTTP server.
 * Inputs/Outputs: dependencies with httpServer/config/registry; returns handle with close method.
 * Edge cases: invalid tokens close connections with policy violation.
 */
export function createIpcServer(deps: IpcServerDependencies): IpcServerHandle {
  const {
    httpServer,
    config,
    registry,
    logger,
    verifyToken,
    authMode = 'jwt',
    apiKey,
    apiKeyHeaderName,
    apiKeyHeaderPrefix,
    apiKeyUserId,
    anonymousUserId = 'anonymous',
    serverVersion,
    daemonGptHeaderName,
    daemonGptMaxLength,
    onEvent,
    onCommandResult
  } = deps;

  //audit assumption: API key header name may be empty; risk: missing auth header; invariant: default header name; strategy: trim and default.
  const resolvedApiKeyHeaderName = (apiKeyHeaderName || 'Authorization').trim() || 'Authorization';
  //audit assumption: API key prefix may be unset; risk: wrong prefix; invariant: default prefix when undefined; strategy: conditional default.
  const resolvedApiKeyHeaderPrefix = apiKeyHeaderPrefix === undefined ? 'Bearer' : apiKeyHeaderPrefix;
  //audit assumption: API key user id optional; risk: missing user id; invariant: fallback to anonymous; strategy: trim and default.
  const resolvedApiKeyUserId = (apiKeyUserId || anonymousUserId).trim() || 'anonymous';
  const daemonGptConfig = resolveDaemonGptIdConfig(daemonGptHeaderName, daemonGptMaxLength);

  const wss = new WebSocketServer({
    server: httpServer,
    path: config.wsPath,
    maxPayload: config.maxMessageSizeBytes
  });

  wss.on('connection', (socket, request) => {
    const rawDaemonGptHeader = extractDaemonHeaderValue(request, daemonGptConfig.headerName);
    const daemonGptParse = parseDaemonGptId(rawDaemonGptHeader, daemonGptConfig.maxLength);
    let daemonGptId: string | undefined;
    if (!daemonGptParse.ok) {
      //audit assumption: invalid daemon GPT ID should not block IPC; risk: missing ID; invariant: connection continues; strategy: warn and continue.
      logger.warn('Invalid daemon GPT ID header on IPC connection', {
        headerName: daemonGptConfig.headerName,
        error: daemonGptParse.error
      });
      //audit assumption: invalid parse yields no daemon ID; risk: stale value; invariant: undefined; strategy: clear value.
      daemonGptId = undefined;
    } else {
      //audit assumption: parsed value may be undefined when header missing; risk: no daemon ID; invariant: parsed value propagated; strategy: assign parsed value.
      daemonGptId = daemonGptParse.value;
    }

    const credential = authMode === 'none'
      ? null
      : extractCredentialFromRequest(
        request,
        authMode === 'api_key' ? resolvedApiKeyHeaderName : 'Authorization',
        authMode === 'api_key' ? resolvedApiKeyHeaderPrefix : 'Bearer'
      );
    if (authMode !== 'none' && !credential) {
      //audit assumption: credential required when auth enabled; risk: unauthorized access; invariant: credential present; strategy: close connection.
      socket.close(1008, 'Unauthorized');
      return;
    }

    let userId = anonymousUserId;
    if (authMode === 'jwt' && credential) {
      try {
        const payload = verifyToken(credential);
        userId = payload.userId;
      } catch (error) {
        //audit assumption: token verification can fail; risk: unauthorized access; invariant: valid token; strategy: close connection.
        logger.warn('IPC token verification failed', { error });
        socket.close(1008, 'Unauthorized');
        return;
      }
    } else if (authMode === 'api_key' && credential) {
      if (!apiKey) {
        //audit assumption: API key must be configured; risk: unauthorized access; invariant: key present; strategy: close connection.
        logger.warn('IPC API key missing from server config');
        socket.close(1008, 'Unauthorized');
        return;
      }
      if (!isApiKeyMatch(credential, apiKey)) {
        //audit assumption: API key must match; risk: unauthorized access; invariant: key match; strategy: close connection.
        logger.warn('IPC API key invalid');
        socket.close(1008, 'Unauthorized');
        return;
      }
      userId = resolvedApiKeyUserId;
    } else if (authMode === 'none') {
      //audit assumption: anonymous auth accepted; risk: unauthorized access; invariant: anonymous user; strategy: proceed.
      userId = anonymousUserId;
    }

    const connectionId = randomUUID();
    const connection = buildConnection(connectionId, userId, socket, request, daemonGptId);
    registry.registerConnection(connection);

    safeSend(
      socket,
      buildHelloAckMessage(connectionId, new Date().toISOString(), serverVersion),
      logger
    );

    socket.on('pong', () => {
      //audit assumption: pong indicates liveness; risk: stale connection; invariant: update lastSeen; strategy: touch.
      registry.touchConnection(connectionId, Date.now());
    });

    socket.on('message', (data) => {
      const rawMessage = typeof data === 'string' ? data : data.toString();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawMessage);
      } catch (error) {
        //audit assumption: JSON parse can fail; risk: malformed payload; invariant: error returned; strategy: send error message.
        safeSend(
          socket,
          buildErrorMessage('IPC payload is not valid JSON', new Date().toISOString(), 'invalid_json'),
          logger
        );
        return;
      }

      const parsedMessage = parseIpcMessage(parsedJson);
      if (!parsedMessage.ok || !parsedMessage.value) {
        //audit assumption: IPC message must be valid; risk: protocol mismatch; invariant: error sent; strategy: send error message.
        safeSend(
          socket,
          buildErrorMessage(
            parsedMessage.error || 'IPC payload invalid',
            new Date().toISOString(),
            'invalid_message'
          ),
          logger
        );
        return;
      }

      registry.touchConnection(connectionId, Date.now());

      if (parsedMessage.value.type === 'hello') {
        //audit assumption: hello updates metadata; risk: missing metadata; invariant: metadata updated; strategy: update fields.
        registry.updateMetadata(connectionId, {
          clientId: parsedMessage.value.clientId,
          instanceId: parsedMessage.value.instanceId,
          platform: parsedMessage.value.platform
        });
        return;
      }

      if (parsedMessage.value.type === 'heartbeat') {
        //audit assumption: heartbeat keeps connection alive; risk: missed heartbeat; invariant: touch on heartbeat; strategy: no-op.
        return;
      }

      if (parsedMessage.value.type === 'event' && onEvent) {
        const eventMessage = parsedMessage.value as IpcEventMessage;
        const eventContext: IpcEventContext = {
          userId,
          eventType: eventMessage.eventType,
          eventId: eventMessage.eventId,
          payload: eventMessage.payload,
          sentAt: eventMessage.sentAt,
          source: eventMessage.source,
          ipAddress: connection.ipAddress,
          userAgent: connection.userAgent,
          daemonGptId: connection.daemonGptId
        };

        void onEvent(eventContext).catch((error) => {
          //audit assumption: event handler can fail; risk: dropped audit; invariant: error logged; strategy: log warning.
          logger.warn('IPC event handler failed', { error, eventType: eventMessage.eventType });
        });
        return;
      }

      if (parsedMessage.value.type === 'command_result' && onCommandResult) {
        const resultMessage = parsedMessage.value as IpcCommandResultMessage;
        //audit assumption: command_result expected; risk: missing handler; invariant: handler invoked; strategy: call handler.
        onCommandResult({ userId, connectionId, result: resultMessage });
        return;
      }

      //audit assumption: unsupported message types should be rejected; risk: unhandled messages; invariant: error returned; strategy: send error.
      safeSend(
        socket,
        buildErrorMessage('IPC message type not supported by server', new Date().toISOString(), 'unsupported_type'),
        logger
      );
    });

    socket.on('error', (error) => {
      //audit assumption: socket errors can happen; risk: hidden failures; invariant: error logged; strategy: log warning.
      logger.warn('IPC socket error', { error, connectionId, userId });
    });

    socket.on('close', () => {
      //audit assumption: socket close should cleanup; risk: stale registry entry; invariant: removed; strategy: remove connection.
      registry.removeConnection(connectionId);
    });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const connection of registry.listConnections()) {
      const isStale = now - connection.lastSeenAt > config.clientTimeoutMs;
      if (isStale) {
        //audit assumption: stale connections should close; risk: zombie sockets; invariant: stale sockets closed; strategy: terminate.
        connection.socket.terminate();
        registry.removeConnection(connection.connectionId);
        continue;
      }
      if (connection.socket.readyState === WebSocket.OPEN) {
        //audit assumption: ping keeps connection alive; risk: no pong; invariant: ping sent; strategy: send ping.
        connection.socket.ping();
      }
    }
  }, config.heartbeatIntervalMs);

  const close = async () => {
    clearInterval(heartbeatTimer);
    for (const connection of registry.listConnections()) {
      //audit assumption: closing sockets on shutdown is safe; risk: exceptions; invariant: best-effort close; strategy: try/catch.
      try {
        connection.socket.close(1001, 'Server shutting down');
      } catch (error) {
        logger.warn('IPC socket close failed', { error, connectionId: connection.connectionId });
      }
      registry.removeConnection(connection.connectionId);
    }

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return { wss, close };
}
