import http from 'http';
import { fetchAndClean, fetchAndCleanDocument } from '../src/shared/webFetcher.js';

function restoreEnvValue(key: string, previousValue: string | undefined): void {
  if (typeof previousValue === 'string') {
    process.env[key] = previousValue;
  } else {
    delete process.env[key];
  }
}

describe('fetchAndClean', () => {
  let server: http.Server;
  let baseUrl: string;
  let redirectUrl: string;
  let previousLocalhostFetchFlag: string | undefined;

  beforeAll(async () => {
    previousLocalhostFetchFlag = process.env.ARCANOS_ALLOW_LOCALHOST_FETCH;
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'true';

    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

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
          redirectUrl = `${baseUrl}/redirect`;
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

  it('rejects credential-bearing URLs before fetching', async () => {
    await expect(fetchAndClean('https://user:pass@example.com/resource')).rejects.toThrow('credentials');
  });

  it.each([
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/',
    'http://172.16.0.1/',
    'http://192.0.2.1/',
    'http://198.18.0.1/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://[2001:db8::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:7f00:1]/'
  ])('blocks non-global fetch target %s', async (blockedUrl) => {
    await expect(fetchAndClean(blockedUrl)).rejects.toThrow('Private/internal IP addresses are not allowed');
  });

  it('truncates content when maxChars is provided', async () => {
    const cleaned = await fetchAndClean(baseUrl, 5);
    expect(cleaned).toBe('Hello');
  });

  it('uses WEB_FETCH_MAX_CHARS when no explicit maxChars value is provided', async () => {
    const previousMaxChars = process.env.WEB_FETCH_MAX_CHARS;
    process.env.WEB_FETCH_MAX_CHARS = '5';

    try {
      const cleaned = await fetchAndClean(baseUrl);
      expect(cleaned).toBe('Hello');
    } finally {
      restoreEnvValue('WEB_FETCH_MAX_CHARS', previousMaxChars);
    }
  });

  it('ignores ambient proxy variables so pinned targets are fetched directly', async () => {
    const previousHttpProxy = process.env.HTTP_PROXY;
    const previousHttpsProxy = process.env.HTTPS_PROXY;
    const previousNoProxy = process.env.NO_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.NO_PROXY = '';

    try {
      const cleaned = await fetchAndClean(baseUrl);
      expect(cleaned).toContain('Hello World!');
    } finally {
      restoreEnvValue('HTTP_PROXY', previousHttpProxy);
      restoreEnvValue('HTTPS_PROXY', previousHttpsProxy);
      restoreEnvValue('NO_PROXY', previousNoProxy);
    }
  });

  it('does not allow environment variables to enable redirects', async () => {
    const previousMaxRedirects = process.env.WEB_FETCH_MAX_REDIRECTS;
    process.env.WEB_FETCH_MAX_REDIRECTS = '1';

    try {
      await expect(fetchAndClean(redirectUrl)).rejects.toThrow('302');
    } finally {
      restoreEnvValue('WEB_FETCH_MAX_REDIRECTS', previousMaxRedirects);
    }
  });

  it('appends a compact link directory', async () => {
    const cleaned = await fetchAndClean(baseUrl);
    expect(cleaned).toContain('[LINKS]');
    expect(cleaned).toContain('Guide Index ->');
    expect(cleaned).toContain('FAQ ->');
  });

  it('returns structured links for traversal-aware callers', async () => {
    const document = await fetchAndCleanDocument(baseUrl);

    expect(document.text).toContain('Hello World!');
    expect(document.links).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Guide Index',
        url: `${baseUrl}/guide`
      }),
      expect.objectContaining({
        label: 'FAQ',
        url: 'https://example.com/faq'
      })
    ]));
    expect(document.combined).toContain('[LINKS]');
  });

  it('blocks localhost fetches when local-development bypass is not explicitly enabled', async () => {
    delete process.env.ARCANOS_ALLOW_LOCALHOST_FETCH;
    await expect(fetchAndClean(baseUrl)).rejects.toThrow('Private/internal IP addresses are not allowed');
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'true';
  });

  it('keeps localhost fetches blocked in production even when the local bypass flag is set', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLocalhostFlag = process.env.ARCANOS_ALLOW_LOCALHOST_FETCH;
    process.env.NODE_ENV = 'production';
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'true';

    try {
      await expect(fetchAndClean(baseUrl)).rejects.toThrow('Private/internal IP addresses are not allowed');
    } finally {
      restoreEnvValue('NODE_ENV', previousNodeEnv);
      restoreEnvValue('ARCANOS_ALLOW_LOCALHOST_FETCH', previousLocalhostFlag);
    }
  });
});
