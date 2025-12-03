import http from 'http';
import { webFetcher } from '../src/utils/webFetcher.js';

describe('webFetcher', () => {
  let server: http.Server;
  let baseUrl!: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Something went terribly wrong on the server side');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('includes status code and body snippet in error messages', async () => {
    await expect(webFetcher(`${baseUrl}/error`)).rejects.toThrow(
      /Fetch failed for .*: 500 Internal Server Error\. Body: Something went terribly wrong/
    );
  });

  it('still returns parsed JSON for successful responses', async () => {
    const result = await webFetcher<{ ok: boolean }>(`${baseUrl}/success`);
    expect(result.ok).toBe(true);
  });
});
