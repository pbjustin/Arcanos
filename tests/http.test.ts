import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { safeFetchHtml } from '../src/utils/http';

describe('safeFetchHtml', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('rejects invalid urls before attempting fetch', async () => {
    const result = await safeFetchHtml('not a url');
    expect(result.error).toMatch(/Invalid URL/);
    expect(result.raw).toBeNull();
  });

  it('returns an error when response is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'text/html' })
    } as Response);

    const result = await safeFetchHtml('https://example.com');
    expect(result.error).toContain('status 500');
    expect(result.status).toBe(500);
  });

  it('rejects non-html content types', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '"hello"'
    } as Response);

    const result = await safeFetchHtml('https://example.com');
    expect(result.error).toBe('Response is not HTML content');
    expect(result.raw).toBeNull();
  });

  it('returns html content when the response is valid', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<html><body>ok</body></html>'
    } as Response);

    const result = await safeFetchHtml('https://example.com');
    expect(result.error).toBeNull();
    expect(result.raw).toContain('ok');
    expect(result.contentType).toContain('text/html');
  });
});
