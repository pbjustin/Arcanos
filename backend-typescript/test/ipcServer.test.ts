import http from 'http';
import WebSocket from 'ws';
import { createIpcConnectionRegistry } from '../src/ipc/ipcRegistry';
import { createIpcServer } from '../src/ipc/ipcServer';
import { buildCommandMessage } from '../src/ipc/ipcTypes';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

const config = {
  wsPath: '/ws/daemon',
  heartbeatIntervalMs: 1000,
  clientTimeoutMs: 5000,
  maxMessageSizeBytes: 1024 * 1024
};

function waitForMessage(
  ws: WebSocket,
  predicate: (message: any) => boolean,
  timeoutMs: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      reject(new Error('Timed out waiting for message'));
    }, timeoutMs);

    const handler = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(parsed);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.on('message', handler);
  });
}

describe('IPC server', () => {
  jest.setTimeout(10000);

  it('accepts hello and dispatches commands', async () => {
    const httpServer = http.createServer();
    const registry = createIpcConnectionRegistry(logger);
    const ipcServer = createIpcServer({
      httpServer,
      config,
      registry,
      logger,
      verifyToken: (token: string) => {
        if (token !== 'test-token') {
          throw new Error('Invalid token');
        }
        return { userId: 'user-1' };
      }
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve server address');
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/daemon?token=test-token`);
    await waitForMessage(ws, (msg) => msg.type === 'hello_ack', 3000);

    const commandMessage = buildCommandMessage('cmd-1', 'ping', new Date().toISOString(), { ok: true });
    const result = registry.sendCommandToUser('user-1', commandMessage);
    expect(result.ok).toBe(true);

    const receivedCommand = await waitForMessage(ws, (msg) => msg.type === 'command', 3000);
    expect(receivedCommand.commandId).toBe('cmd-1');
    expect(receivedCommand.name).toBe('ping');

    ws.close();
    await ipcServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });
});
