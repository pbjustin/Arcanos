import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';

const bridgeInfo = jest.fn();
const bridgeWarn = jest.fn();

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    child: () => ({
      info: bridgeInfo,
      warn: bridgeWarn,
    }),
  },
}));

const { setupBridgeSocket } = await import('../src/services/bridgeSocket.js');

const originalBridgeEnabled = process.env.BRIDGE_ENABLED;
const originalAutomationSecret = process.env.ARCANOS_AUTOMATION_SECRET;
const originalAutomationHeader = process.env.ARCANOS_AUTOMATION_HEADER;

function restoreEnvironment(): void {
  const values = {
    ARCANOS_AUTOMATION_HEADER: originalAutomationHeader,
    ARCANOS_AUTOMATION_SECRET: originalAutomationSecret,
    BRIDGE_ENABLED: originalBridgeEnabled,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Bridge credential test server did not expose a TCP port.');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function attemptUpgrade(
  port: number,
  headerName: string,
  credential: string | undefined,
): Promise<{ client?: WebSocket; status: number }> {
  return new Promise((resolve, reject) => {
    const headers = credential === undefined ? {} : { [headerName]: credential };
    const client = new WebSocket(`ws://127.0.0.1:${port}/ipc`, { headers });
    let settled = false;
    client.once('open', () => {
      settled = true;
      resolve({ client, status: 101 });
    });
    client.once('unexpected-response', (_request, response) => {
      settled = true;
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    client.once('error', (error) => {
      if (!settled) {
        reject(error);
      }
    });
  });
}

async function closeClient(client: WebSocket | undefined): Promise<void> {
  if (!client || client.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    client.once('close', () => resolve());
    client.close();
  });
}

async function waitForDisconnectLogs(expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = bridgeInfo.mock.calls.filter(
      (call) => call[0] === 'Bridge IPC client disconnected',
    ).length;
    if (count >= expectedCount) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Bridge credential test did not observe deterministic socket cleanup.');
}

describe('bridge socket opaque credential contract', () => {
  afterEach(() => {
    restoreEnvironment();
    jest.clearAllMocks();
  });

  it('executes the production verifier after Node header parsing and closes all handles', async () => {
    const headerName = 'x-phase2a-bridge';
    const credential = ['phase2a', 'bridge', 'sécurité'].join('-');
    const wrongSameLength = `${credential.slice(0, -1)}x`;
    process.env.BRIDGE_ENABLED = 'true';
    process.env.ARCANOS_AUTOMATION_HEADER = headerName;
    process.env.ARCANOS_AUTOMATION_SECRET = `  ${credential}  `;

    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    setupBridgeSocket(server);
    const clients: Array<WebSocket | undefined> = [];

    try {
      const port = await listen(server);
      const missing = await attemptUpgrade(port, headerName, undefined);
      clients.push(missing.client);
      const wrong = await attemptUpgrade(port, headerName, wrongSameLength);
      clients.push(wrong.client);
      const whitespaceChanged = await attemptUpgrade(port, headerName, ` ${credential}`);
      clients.push(whitespaceChanged.client);
      const exact = await attemptUpgrade(port, headerName, credential);
      clients.push(exact.client);

      expect([missing.status, wrong.status, whitespaceChanged.status, exact.status]).toEqual([
        401,
        401,
        101,
        101,
      ]);

      const logOutput = JSON.stringify([bridgeInfo.mock.calls, bridgeWarn.mock.calls]);
      expect(
        [credential, wrongSameLength].some((value) => logOutput.includes(value)),
      ).toBe(false);
    } finally {
      await Promise.all(clients.map((client) => closeClient(client)));
      await closeServer(server);
      await waitForDisconnectLogs(clients.filter(Boolean).length);
    }
  });
});
