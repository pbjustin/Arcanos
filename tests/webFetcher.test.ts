import http from 'http';
import { fetchAndClean } from '../src/services/webFetcher.js';

describe('fetchAndClean', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
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
});
