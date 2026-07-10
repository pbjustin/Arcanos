import http from 'http';
import {
  fetchAndClean,
  fetchAndCleanDocument,
  type FetchAndCleanExtractionMetrics
} from '../src/shared/webFetcher.js';

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

      if (req.url === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <header>Site Header Account Sign In</header>
              <nav><a href="/menu">Home Guides Builds News</a></nav>
              <div hidden>Hidden prompt text must not be extracted.</div>
              <div class="main-sidebar-container">
                <main>
                  <article>
                    <h1>Community Spotlight</h1>
                    <p>This longer unrelated story covers fan art, event photos, community interviews, creator profiles, and convention highlights from across the year.</p>
                  </article>
                  <article><h1>Elden Ring Patch 1.16.1</h1><p>The patch fixes weapon skill interactions and adjusts balance behavior for current builds.</p><a href="/evidence">Read full evidence</a></article>
                  <aside class="sidebar">Popular Games Category Directory</aside>
                </main>
              </div>
              <footer>Privacy Policy Newsletter</footer>
            </body>
          </html>
        `);
        return;
      }

      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Visible text<script>ignored script</script><style>ignored style</style><noscript>ignored fallback</noscript></body></html>');
        return;
      }

      if (req.url === '/container-ranking') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <section class="menu-candidate">
                <nav>
                  <a href="/home">Home</a>
                  <a href="/exploration">Exploration</a>
                  <a href="/builds">Nebula drive builds</a>
                  <a href="/popular">Popular categories</a>
                  <a href="/account">Account sign in</a>
                  <a href="/related">Related links</a>
                </nav>
              </section>
              <article>
                <h1>Independent Space Exploration Guide</h1>
                <p>This nebula drive exploration guide explains how to prepare a reliable ship before leaving inhabited space.</p>
                <p>Carry repair equipment, plan fuel stops, and scan each system before committing to the next long jump.</p>
                <p>These steps keep the route readable and give new pilots concrete evidence for each recommendation.</p>
              </article>
            </body>
          </html>
        `);
        return;
      }

      if (req.url === '/bounded-metrics') {
        const candidates = Array.from({ length: 80 }, (_, index) => `
          <article class="bounded-candidate">
            <h2>Candidate ${index + 1} ${'heading '.repeat(50)}</h2>
            <p>This generic progression guide contains complete sentences and bounded extraction evidence for an unknown game.</p>
          </article>
        `).join('');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>${'document title '.repeat(40)}</title></head><body>${candidates}</body></html>`);
        return;
      }

      if (req.url === '/binary') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }

      if (req.url === '/binary-text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42, 0x43]));
        return;
      }

      if (req.url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('A'.repeat(1024));
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
    'http://[fec0::1]/',
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

  it('prefers semantic article content, removes caller-selected chrome, and reports extraction metrics', async () => {
    let extractionMetrics: {
      strategy: string;
      rawTextLength: number;
      cleanedTextLength: number;
    } | undefined;

    const document = await fetchAndCleanDocument(`${baseUrl}/article`, 12000, {
      preferredContentSelectors: ['article', 'main'],
      preferredContentTerms: ['patch', 'weapon skill'],
      removeSelectors: ['header', 'nav', 'footer', '.sidebar', '[hidden]'],
      includeLinks: false,
      onExtraction: (metrics) => {
        extractionMetrics = metrics;
      }
    });

    expect(document.text).toContain('fixes weapon skill interactions');
    expect(document.text).toContain('Patch 1.16.1 The patch');
    expect(document.text).not.toMatch(/site header|home guides|category directory|privacy policy/i);
    expect(document.text).not.toContain('Hidden prompt text');
    expect(document.links).toEqual([]);
    expect(document.combined).not.toContain('[LINKS]');
    expect(extractionMetrics).toEqual(expect.objectContaining({
      strategy: 'article',
      cleanedTextLength: document.text.length
    }));
    expect(document.text).not.toContain('Community Spotlight');
    expect(extractionMetrics?.rawTextLength).toBeGreaterThan(document.text.length);
  });

  it('excludes script, style, and noscript content from raw text metrics', async () => {
    let rawTextLength = 0;

    const document = await fetchAndCleanDocument(`${baseUrl}/metrics`, 12000, {
      includeLinks: false,
      onExtraction: (metrics) => {
        rawTextLength = metrics.rawTextLength;
      }
    });

    expect(document.text).toBe('Visible text');
    expect(rawTextLength).toBe('Visible text'.length);
  });

  it('scores every preferred container so a poor first strategy loses to a readable later one', async () => {
    let extractionMetrics: FetchAndCleanExtractionMetrics | undefined;

    const document = await fetchAndCleanDocument(`${baseUrl}/container-ranking`, 12000, {
      preferredContentSelectors: ['.menu-candidate', 'article'],
      preferredContentTerms: ['nebula drive', 'exploration guide'],
      includeLinks: false,
      onExtraction: (metrics) => {
        extractionMetrics = metrics;
      }
    });

    expect(document.text).toContain('Carry repair equipment');
    expect(document.text).not.toMatch(/popular categories|account sign in|related links/i);
    expect(extractionMetrics).toEqual(expect.objectContaining({
      strategy: 'article',
      selectedContainer: 'article',
      candidateCount: 2,
      cleanedTextLength: document.text.length
    }));
  });

  it('bounds candidate evaluation, scores, and extracted title and heading metrics', async () => {
    let extractionMetrics: FetchAndCleanExtractionMetrics | undefined;

    await fetchAndCleanDocument(`${baseUrl}/bounded-metrics`, 12000, {
      preferredContentSelectors: ['.bounded-candidate'],
      preferredContentTerms: ['progression guide'],
      includeLinks: false,
      onExtraction: (metrics) => {
        extractionMetrics = metrics;
      }
    });

    expect(extractionMetrics?.candidateCount).toBe(48);
    expect(extractionMetrics?.documentTitle).toHaveLength(240);
    expect(extractionMetrics?.headingText).toHaveLength(240);
    for (const metric of [
      extractionMetrics?.qualityScore,
      extractionMetrics?.navigationPenalty,
      extractionMetrics?.navigationDensity,
      extractionMetrics?.linkDensity
    ]) {
      expect(metric).toBeGreaterThanOrEqual(0);
      expect(metric).toBeLessThanOrEqual(1);
    }
  });

  it('rejects unsupported response content types before parsing', async () => {
    await expect(fetchAndClean(`${baseUrl}/binary`)).rejects.toThrow(
      'Unsupported content type for web fetching: image/png'
    );
  });

  it('rejects binary-like bodies even when the response claims to be text', async () => {
    await expect(fetchAndClean(`${baseUrl}/binary-text`)).rejects.toThrow(
      'Unsupported binary-like content for web fetching'
    );
  });

  it('enforces the configured response-size cap', async () => {
    const previousMaxBytes = process.env.WEB_FETCH_MAX_BYTES;
    process.env.WEB_FETCH_MAX_BYTES = '64';

    try {
      await expect(fetchAndClean(`${baseUrl}/large`)).rejects.toThrow(/maxContentLength|size/i);
    } finally {
      restoreEnvValue('WEB_FETCH_MAX_BYTES', previousMaxBytes);
    }
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
