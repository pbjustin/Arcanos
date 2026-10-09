import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { resolveGamingDocument, isResolvedGamingDocumentIdentityVerified,
  GAMING_DOCUMENT_ACQUISITION_LIMITS } = await import('../src/services/gamingDocumentResolution.js');

const url = 'https://publisher.example/elden-ring-samurai';
const finalUrl = 'https://publisher.example/guides/elden-ring-samurai';
const request = { game: 'Elden Ring', edition: 'base-game', mode: 'build' as const,
  prompt: 'Explain Samurai Uchigatana bleed setup, Vigor through level 50 and Smithing Stones upgrades.' };
const jsonRecord = `<script type="application/json">${JSON.stringify({ records: [{ game: 'Elden Ring',
  item: 'Uchigatana', stat: 'bleed', value: 45, unit: 'buildup', scope: 'base-game' }] })}</script>`;
const card = '<article><h2>Editorial spotlight</h2><p>Our editorial team creates informative reviews. Every recommendation considers performance carefully. Readers can explore helpful advice about choosing equipment. Thoughtful research helps readers find a dependable choice for an enjoyable adventure.</p></article>';
const article = `${Array.from({ length: 32 }, (_, index) => `<p>In Elden Ring base-game, Samurai route ${index} recommends upgrading the Uchigatana with Smithing Stones and preserving stamina for dodging attacks. <a href="/route-${index}">Check the weapon upgrade location and compare the equipment requirements.</a></p>`).join('')}<p>Late route: raise Vigor through level 50 before improving Dexterity. Upgrade Uchigatana with ordinary Smithing Stones and retain Unsheathe.</p>`;
const html = `<html><head><title>Elden Ring Samurai build</title><script>${'x'.repeat(2_000_000)}</script></head><body><main><article id="article-body"><h1>Elden Ring Samurai build</h1>${article}<div>Correction: this bleed example is unconfirmed on the current patch.</div>${'<div>'.repeat(7)}${jsonRecord}${'</div>'.repeat(7)}<div class="sidebar"><p>Game: Diablo IV. Before leveling, equip the unrelated staff.</p></div></article>${card}</main></body></html>`;

function streamResponse(body: Buffer | string, headers: Record<string, string> = {}, status = 200) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const chunks = Array.from({ length: Math.ceil(buffer.length / 8192) }, (_, index) => buffer.subarray(index * 8192, (index + 1) * 8192));
  const data = Object.assign(Readable.from(chunks), { rawHeaders: Object.entries(headers).flat() });
  data.on('error', () => undefined);
  return { status, data, headers };
}

describe('Gaming mission protected HTTP acquisition with controlled streaming responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Large-page coverage does not measure CPU scheduling under Jest instrumentation.
    // Production deadline and cancellation tests remain independently asserted.
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T12:00:00Z'));
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it.each(['chunked', 'gzip'] as const)('preserves full guide, late evidence, qualifiers and provenance from a large %s response', async encoding => {
    const bytes = Buffer.from(html);
    const transferred = encoding === 'gzip' ? gzipSync(bytes) : bytes;
    const headers = { 'content-type': 'text/html',
      ...(encoding === 'gzip' ? { 'content-encoding': 'gzip', 'content-length': String(transferred.length) } : {}) };
    expect(bytes.length).toBeGreaterThan(2_000_000);
    expect(bytes.length).toBeLessThan(GAMING_DOCUMENT_ACQUISITION_LIMITS.maxDecodedBytes);
    fetch.mockImplementation(async (pinnedUrl: string, options: any) => {
      expect(new URL(pinnedUrl).hostname).toBe('93.184.216.34');
      expect(options).toMatchObject({ decompress: false, responseType: 'stream', maxRedirects: 0, proxy: false });
      expect(options.headers).not.toHaveProperty('Authorization');
      expect(options.headers).not.toHaveProperty('Cookie');
      return streamResponse(transferred, headers);
    });
    const live = await resolveGamingDocument(url);
    const durable = await resolveGamingDocument(url, 1_000_000, { documentPurpose: 'durable' });
    for (const document of [live, durable]) {
      expect(document.text).toContain('Samurai route 0');
      expect(document.text).toContain('Samurai route 31');
      expect(document.text).toContain('Late route: raise Vigor through level 50');
      expect(document.text).not.toMatch(/Editorial spotlight|Diablo IV|unrelated staff|x{100}/u);
      expect(document.extraction.selectedContainer).toBe('#article-body');
      expect(document.metadata).toMatchObject({ title: 'Elden Ring Samurai build', headings: 'Elden Ring Samurai build' });
      expect(document.metrics.truncated).toBe(false);
      expect(document.structureDiagnostics).toMatchObject({ receivedBytes: transferred.length, acceptedBytes: bytes.length,
        rawChars: html.length, completeUnits: 1, partialUnits: 0, budgetOutcome: 'within_budget' });
      expect(document.rawDocument?.truncated).toBe(true);
      expect(document.evidenceUnits).toHaveLength(1);
      expect(document.evidenceUnits![0]).toMatchObject({ integrity: { status: 'complete', reasons: [] },
        context: { qualifiers: expect.arrayContaining(['Correction: this bleed example is unconfirmed on the current patch.']) },
        provenance: { sourceUrl: url, representation: 'json_pointer', jsonOnly: true } });
      expect(document.evidenceUnits![0].context.qualifiers).not.toEqual(expect.arrayContaining([expect.stringContaining('Diablo')]));
      expect(isResolvedGamingDocumentIdentityVerified(document, url)).toBe(true);
      expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, request.game)).status).toBe('verified');
    }
    expect(live.text).toBe(durable.text);
    expect(live.evidenceUnits).toEqual(durable.evidenceUnits);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('binds acquired records and citations to the final canonical redirect identity without accepting forged metadata', async () => {
    fetch.mockImplementation(async (pinnedUrl: string) => {
      const path = new URL(pinnedUrl).pathname;
      return path === new URL(url).pathname
        ? streamResponse('', { 'content-type': 'text/plain', location: '/guides/elden-ring-samurai' }, 307)
        : streamResponse(`<html><title>Elden Ring Samurai guide</title><body><article><h1>Elden Ring Samurai guide</h1><p>In Elden Ring base-game, use Uchigatana and raise Vigor through level 50.</p>${jsonRecord}</article></body></html>`, { 'content-type': 'text/html' });
    });
    const document = await resolveGamingDocument(url);
    expect(document).toMatchObject({ requestedUrl: url, canonicalUrl: finalUrl, publicUrl: finalUrl, host: 'publisher.example',
      acquisition: { requestedUrl: url, finalUrl, redirectCount: 1,
        transitions: [{ fromUrl: url, toUrl: finalUrl, classification: 'same_origin', ruleId: 'gaming.redirect.same_origin' }] } });
    expect(document.evidenceUnits).toHaveLength(1);
    expect(document.evidenceUnits![0].provenance.sourceUrl).toBe(finalUrl);
    expect(isResolvedGamingDocumentIdentityVerified(document, url)).toBe(true);
    expect(isResolvedGamingDocumentIdentityVerified({ ...document, publicUrl: url }, url)).toBe(false);
    expect(isResolvedGamingDocumentIdentityVerified({ ...document,
      evidenceUnits: document.evidenceUnits!.map(unit => ({ ...unit, provenance: { ...unit.provenance, sourceUrl: url } })) }, url)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains restrictions outside selected article text rather than allowing extraction to hide them', async () => {
    fetch.mockImplementation(async () => streamResponse(`<html><title>Elden Ring guide</title><body><article><h1>Elden Ring guide</h1><p>In Elden Ring, equip Uchigatana and practice Unsheathe against early enemies.</p>${jsonRecord}</article><div class="sidebar"><p>No automated use.</p></div></body></html>`, { 'content-type': 'text/html' }));
    const document = await resolveGamingDocument(url);
    expect(document.sourceUseRestricted).toBe(true);
    expect(document.text).not.toContain('No automated use');
    expect(document.evidenceUnits).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects decoded overflow before article selection without widening limits', async () => {
    const compressed = gzipSync(Buffer.from('x'.repeat(GAMING_DOCUMENT_ACQUISITION_LIMITS.maxDecodedBytes + 1)));
    fetch.mockImplementation(async () => streamResponse(compressed, { 'content-type': 'text/html',
      'content-encoding': 'gzip', 'content-length': String(compressed.length) }));
    await expect(resolveGamingDocument(url)).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE',
      acquisition: { stage: 'transport', subreason: 'DECODED_LIMIT' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
