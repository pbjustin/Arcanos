import http from 'http';
import { fetchAndClean } from '../src/shared/webFetcher.js';

describe('fetchAndClean', () => {
  let server: http.Server;
  let baseUrl: string;
  let previousLocalhostFetchFlag: string | undefined;

  beforeAll(async () => {
    previousLocalhostFetchFlag = process.env.ARCANOS_ALLOW_LOCALHOST_FETCH;
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'true';

    server = http.createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head>
            <style>body { color: red; }</style>
            <script>console.log('ignore me')</script>
          </head>
          <body>
            Hello <strong>World</strong>!
            <noscript>fallback</noscript>
            <a href="/guide">Guide Index</a>
            <a href="https://example.com/faq">FAQ</a>
          </body>
        </html>
      `);
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
    if (typeof previousLocalhostFetchFlag === 'string') {
      process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = previousLocalhostFetchFlag;
    } else {
      delete process.env.ARCANOS_ALLOW_LOCALHOST_FETCH;
    }
  });

  it('strips non-text elements and condenses whitespace', async () => {
    const cleaned = await fetchAndClean(baseUrl);
    expect(cleaned).toContain('Hello World!');
  });

  it('enforces http/https schemes', async () => {
    await expect(fetchAndClean('ftp://example.com/resource')).rejects.toThrow('http/https');
  });

  it('truncates content when maxChars is provided', async () => {
    const cleaned = await fetchAndClean(baseUrl, 5);
    expect(cleaned).toBe('Hello');
  });

  it('appends a compact link directory', async () => {
    const cleaned = await fetchAndClean(baseUrl);
    expect(cleaned).toContain('[LINKS]');
    expect(cleaned).toContain('Guide Index ->');
    expect(cleaned).toContain('FAQ ->');
  });

  it('blocks localhost fetches when local-development bypass is not explicitly enabled', async () => {
    delete process.env.ARCANOS_ALLOW_LOCALHOST_FETCH;
    await expect(fetchAndClean(baseUrl)).rejects.toThrow('Private/internal IP addresses are not allowed');
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'true';
  });
});
