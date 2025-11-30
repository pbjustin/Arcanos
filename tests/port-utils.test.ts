import { createServer, Server } from 'http';
import { getAvailablePort, isPortAvailable } from '../src/utils/portUtils.js';

async function startServer(host = '127.0.0.1'): Promise<{ server: Server; port: number }> {
  const server = createServer((_, res) => res.end('ok'));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (typeof address !== 'object' || !address?.port) {
    server.close();
    throw new Error('Failed to determine server port');
  }

  return { server, port: address.port };
}

describe('portUtils', () => {
  let activeServers: Server[];

  beforeEach(() => {
    activeServers = [];
  });

  afterEach(async () => {
    await Promise.all(
      activeServers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
  });

  test('detects when a port is unavailable', async () => {
    const { server, port } = await startServer();
    activeServers.push(server);

    const available = await isPortAvailable(port, '127.0.0.1');

    expect(available).toBe(false);
  });

  test('throws when auto-select is disabled and port is in use', async () => {
    const { server, port } = await startServer();
    activeServers.push(server);

    await expect(getAvailablePort(port, '127.0.0.1', false)).rejects.toThrow(
      `Port ${port} is already in use.`
    );
  });

  test('finds a fallback port when the preferred port is busy', async () => {
    const { server, port } = await startServer();
    activeServers.push(server);

    const result = await getAvailablePort(port, '127.0.0.1');

    expect(result.isPreferred).toBe(false);
    expect(result.port).not.toBe(port);
    await expect(isPortAvailable(result.port, '127.0.0.1')).resolves.toBe(true);
  });
});
