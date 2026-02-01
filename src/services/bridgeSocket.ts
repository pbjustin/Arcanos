import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { logger } from '../utils/structuredLogging.js';
import { isBridgeEnabled } from '../utils/bridgeEnv.js';
import { consumeOneTimeToken } from '../lib/tokenStore.js';

const bridgeLogger = logger.child({ module: 'bridge-ipc' });
const bridgeClients = new Set<WebSocket>();

function resolvePath(url?: string): string {
  if (!url) return '/';
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

function isAllowedPath(pathname: string): boolean {
  return (
    pathname.startsWith('/ipc') ||
    pathname.startsWith('/bridge') ||
    pathname.startsWith('/ws')
  );
}

function resolveHeader(req: IncomingMessage, headerName: string): string | undefined {
  const raw = req.headers[headerName];
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

function isAutomationAuthorized(req: IncomingMessage): boolean {
  const secret = (process.env.ARCANOS_AUTOMATION_SECRET || '').trim();
  if (!secret) {
    const token = resolveHeader(req, 'x-arcanos-confirm-token');
    if (!token) {
      return true;
    }
    // //audit Assumption: confirmation token is the capability; risk: replay if not consumed; invariant: consume on success; handling: consume + accept only when valid.
    return consumeOneTimeToken(token).ok;
  }
  const headerName = (process.env.ARCANOS_AUTOMATION_HEADER || 'x-arcanos-automation').toLowerCase();
  const provided = resolveHeader(req, headerName);
  if (provided === secret) {
    return true;
  }
  const token = resolveHeader(req, 'x-arcanos-confirm-token');
  if (!token) {
    return false;
  }
  // //audit Assumption: confirmation token can authorize IPC without automation secret; risk: replay; invariant: token must be consumed; handling: consume + accept when valid.
  return consumeOneTimeToken(token).ok;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
  socket.destroy();
}

export function setupBridgeSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  if (!isBridgeEnabled()) {
    bridgeLogger.info('Bridge IPC disabled (BRIDGE_ENABLED not set to true).');
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = resolvePath(req.url);
    if (!isAllowedPath(pathname)) {
      bridgeLogger.warn('Bridge IPC upgrade rejected (path not allowed).', { path: pathname });
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (!isBridgeEnabled()) {
      bridgeLogger.warn('Bridge IPC upgrade rejected (bridge disabled).', { path: pathname });
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    if (!isAutomationAuthorized(req)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const pathname = resolvePath(req.url);
    bridgeClients.add(ws);
    bridgeLogger.info('Bridge IPC client connected', {
      path: pathname,
      remoteAddress: req.socket.remoteAddress
    });

    ws.send(
      JSON.stringify({
        type: 'bridge_ready',
        status: 'ok',
        timestamp: new Date().toISOString()
      })
    );

    ws.on('message', (data: WebSocket.RawData) => {
      const text = data.toString();
      let parsed: { type?: string } | undefined;
      try {
        parsed = JSON.parse(text) as { type?: string };
      } catch {
        parsed = undefined;
      }

      if (parsed?.type === 'handshake') {
        ws.send(
          JSON.stringify({
            type: 'handshake_ack',
            status: 'ok',
            timestamp: new Date().toISOString()
          })
        );
      }
    });

    ws.on('close', () => {
      bridgeClients.delete(ws);
      bridgeLogger.info('Bridge IPC client disconnected', { path: pathname });
    });

    ws.on('error', (err: Error) => {
      bridgeClients.delete(ws);
      bridgeLogger.warn('Bridge IPC socket error', { path: pathname }, undefined, err as Error);
    });
  });
}

export function broadcastBridgeEvent(payload: unknown): void {
  if (!isBridgeEnabled() || bridgeClients.size === 0) {
    return;
  }

  const message = JSON.stringify({
    type: 'bridge_event',
    payload,
    timestamp: new Date().toISOString()
  });

  for (const client of bridgeClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
