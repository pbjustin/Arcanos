import { describe, expect, it, jest } from '@jest/globals';
import { createGamingAcquisitionStages } from './testUtils/gamingAcquisitionStages.js';

const urls = ['https://one.example.org/guide?part=1', 'https://two.example.org/guide?part=2',
  'https://three.example.org/guide?part=3'];
function request(http: ReturnType<typeof jest.fn>, value: string) {
  const url = new URL(value);
  const host = url.host;
  url.hostname = '93.184.216.34';
  return http(url.href, { headers: { Host: host } });
}

describe('bounded Gaming acquisition setup stages', () => {
  it('processes one original sequential document per stage and returns the original result', async () => {
    const delivered: string[] = [];
    const processed: string[] = [];
    const http = jest.fn(async (_url: unknown, options: unknown) => {
      const host = (options as { headers: { Host: string } }).headers.Host;
      delivered.push(host); return host;
    });
    const original = http.getMockImplementation();
    const stages = createGamingAcquisitionStages(http);
    const operation = jest.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(stages.signal);
      for (const url of urls) {
        processed.push(await request(http, url) as string);
        signal.throwIfAborted();
      }
      return { accepted: processed };
    });
    const batch = stages.begin(urls, operation);
    try {
      expect(await batch.advance()).toBeUndefined();
      expect(delivered).toEqual(['one.example.org']);
      expect(processed).toEqual(delivered);
      expect(http).toHaveBeenCalledTimes(2); // Source two entered, but has no response yet.
      expect(await batch.advance()).toBeUndefined();
      expect(delivered).toEqual(['one.example.org', 'two.example.org']);
      expect(http).toHaveBeenCalledTimes(3);
      const result = await batch.advance();
      expect(result).toEqual({ accepted: ['one.example.org', 'two.example.org', 'three.example.org'] });
      expect(await batch.result).toBe(result);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(stages.signal).toBeUndefined();
      await expect(batch.advance()).rejects.toThrow('once per source');
    } finally { await stages.dispose(); }
    expect(http.getMockImplementation()).toBe(original);
  });

  it('does not conflate protected source hosts or query strings', async () => {
    for (const wrong of ['https://wrong.example.org/guide?part=1', 'https://one.example.org/guide?part=2']) {
      const http = jest.fn(async () => 'response');
      const stages = createGamingAcquisitionStages(http);
      const batch = stages.begin([urls[0]], async () => request(http, wrong));
      try {
        await expect(batch.advance()).rejects.toThrow('original order');
        expect(http).toHaveBeenCalledTimes(1);
      } finally { await stages.dispose(); }
    }
  });

  it('preserves the source Host port instead of borrowing the connected IP port', async () => {
    const http = jest.fn(async () => 'response');
    const stages = createGamingAcquisitionStages(http);
    const batch = stages.begin(['https://one.example.org:8443/guide'], async () =>
      http('https://93.184.216.34:8443/guide', { headers: { Host: 'one.example.org' } }));
    try { await expect(batch.advance()).rejects.toThrow('original order'); }
    finally { await stages.dispose(); }
  });

  it('rejects a parallel request instead of treating its entry as completed document processing', async () => {
    const http = jest.fn(async () => 'response');
    const stages = createGamingAcquisitionStages(http);
    const batch = stages.begin(urls, async () => Promise.all(urls.map(url => request(http, url))));
    try { await expect(batch.advance()).rejects.toThrow('original order'); }
    finally { await stages.dispose(); }
  });

  it('forwards the original operation error and drains a rejected operation', async () => {
    const failure = new Error('Synthetic source evaluation failed.');
    const http = jest.fn(async () => 'response');
    const stages = createGamingAcquisitionStages(http);
    const batch = stages.begin(urls, async () => { await request(http, urls[0]); throw failure; });
    await expect(batch.advance()).rejects.toBe(failure);
    await expect(batch.result).rejects.toBe(failure);
    await stages.dispose();
    await stages.dispose();
  });

  it('aborts, releases and drains timeout-like abandoned setup before the shared mock resets', async () => {
    const events: string[] = [];
    const http = jest.fn(async () => { events.push('delivered'); return 'response'; });
    const stages = createGamingAcquisitionStages(http);
    const batch = stages.begin(urls, async signal => {
      try {
        for (const url of urls) { await request(http, url); signal.throwIfAborted(); }
      } finally {
        await Promise.resolve();
        events.push('operation drained');
      }
    });
    // Model Jest leaving the setup hook while the next source is gated.
    // No five-second sleep or relaxed deadline is needed to make this lifecycle exact.
    await batch.advance();
    expect(http).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['delivered']);
    await stages.dispose();
    await expect(batch.result).rejects.toMatchObject({ name: 'AbortError' });
    events.push('mock reset');
    http.mockReset();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events).toEqual(['delivered', 'operation drained', 'mock reset']);
    expect(http).not.toHaveBeenCalled();
  });

  it('rejects overlapping batches, duplicate URLs and use after disposal', async () => {
    const http = jest.fn(async () => 'response');
    const stages = createGamingAcquisitionStages(http);
    expect(() => stages.begin([urls[0], urls[0]], async () => undefined)).toThrow('distinct source URLs');
    const batch = stages.begin([urls[0]], async () => request(http, urls[0]));
    expect(() => stages.begin([urls[1]], async () => undefined)).toThrow('current acquisition batch');
    await batch.advance();
    await stages.dispose();
    expect(() => stages.begin([urls[0]], async () => undefined)).toThrow('disposed');
  });
});
