import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingArchiveDerivativePath, gamingArchiveGuideUrl, gamingArchiveMetadata,
  gamingArchiveStorageHost } from './testUtils/gamingArchiveFixtures.js';
import type { LiveValidationGamingExecutor } from '../src/liveValidationGamingAdapter.js';
import type { LivePrPreviewModuleObserver } from '../src/liveValidationGamingAdapter.js';

const mockHttp = jest.fn();
const resolve4 = jest.fn<(hostname: string) => Promise<string[]>>();
const resolve6 = jest.fn<(hostname: string) => Promise<string[]>>();
const mockDatabaseAccess = jest.fn(async () => { throw new Error('Database access is forbidden in this source fixture.'); });
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  resolve4(hostname: string) { return resolve4(hostname); }
  resolve6(hostname: string) { return resolve6(hostname); }
  cancel() {}
} }));
jest.unstable_mockModule('../src/core/db/client.js', () => ({
  getPool: () => ({ query: mockDatabaseAccess, connect: mockDatabaseAccess }), isDatabaseConnected: () => true,
  initializeDatabase: mockDatabaseAccess, closePoolIfCurrent: jest.fn(), close: jest.fn(), getStatus: jest.fn()
}));
jest.unstable_mockModule('../src/core/db/index.js', () => ({
  getPool: () => ({ query: mockDatabaseAccess, connect: mockDatabaseAccess }), isDatabaseConnected: () => true,
  query: mockDatabaseAccess, transaction: mockDatabaseAccess
}));
const { resolveGamingDocument, isResolvedGamingDocumentIdentityVerified } = await import('../src/services/gamingDocumentResolution.js');
const { createLiveValidationGamingAdapter } = await import('../src/liveValidationGamingAdapter.js');

const startUrl = 'https://guides.example.org/elden-ring/start?part=B&part=A';
const finalUrl = 'https://guides.example.org/elden-ring/final?chapter=one&chapter=two';
const guideHtml = readFileSync(new URL('./fixtures/gaming-samurai-guide.html', import.meta.url), 'utf8');
const rejection = { code: 'URL_BLOCKED', acquisition: { stage: 'transport', subreason: 'NETWORK_DESTINATION_BLOCKED' } };
const env = { ARCANOS_GAMING_DISCOVERY_DOMAIN_ALLOWLIST: '', ARCANOS_GAMING_DISCOVERY_DOMAIN_BLOCKLIST: '',
  ARCANOS_GAMING_DISCOVERY_ENABLED: 'false', ARCANOS_GAMING_RAG_ENABLED: 'false' };
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks(); mockHttp.mockReset(); resolve4.mockReset().mockResolvedValue(['93.184.216.34']); resolve6.mockReset().mockResolvedValue([]);
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  mockHttp.mockResolvedValue({ status: 200, data: guideHtml, headers: { 'content-type': 'text/html' } });
});
afterEach(() => {
  expect(mockDatabaseAccess).not.toHaveBeenCalled();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('server-owned live-validation source guard inside real Gaming acquisition', () => {
  it('denies the logical initial URL before DNS or HTTP and withholds raw denial text', async () => {
    const sourceGuard = jest.fn(() => { throw new Error('private-denial-sentinel'); });
    const failure = await resolveGamingDocument(startUrl, 100_000, { onRequestUrl: sourceGuard }).catch(error => error);
    expect(failure).toMatchObject(rejection); expect(String(failure)).not.toContain('private-denial-sentinel');
    expect(JSON.stringify(failure)).not.toContain('private-denial-sentinel');
    expect(sourceGuard.mock.calls).toEqual([[startUrl]]);
    expect(resolve4).not.toHaveBeenCalled(); expect(resolve6).not.toHaveBeenCalled(); expect(mockHttp).not.toHaveBeenCalled();
  });

  it('checks a same-origin redirect destination before resolving or requesting its second hop', async () => {
    mockHttp.mockResolvedValueOnce({ status: 302, data: 'moved', headers: { location: finalUrl, 'content-type': 'text/plain' } });
    const sourceGuard = jest.fn((url: string) => { if (url !== startUrl) throw new Error('private-redirect-denial'); });
    await expect(resolveGamingDocument(startUrl, 100_000, { onRequestUrl: sourceGuard })).rejects.toMatchObject({
      ...rejection, acquisition: { ...rejection.acquisition, redirectCount: 1, failingHop: 1 }
    });
    expect(sourceGuard.mock.calls.map(([url]) => url)).toEqual([startUrl, finalUrl]);
    expect(resolve4.mock.calls).toEqual([['guides.example.org']]);
    expect(resolve6.mock.calls).toEqual([['guides.example.org']]); expect(mockHttp).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['private IPv4', ['10.0.0.1'], []],
    ['mixed IPv4', ['93.184.216.34', '192.168.0.1'], []],
    ['private IPv6 beside public IPv4', ['93.184.216.34'], ['fd00::1']]
  ])('retains the existing DNS rejection for %s even when the guard allows the URL', async (_name, ipv4, ipv6) => {
    resolve4.mockResolvedValue(ipv4); resolve6.mockResolvedValue(ipv6);
    const sourceGuard = jest.fn((_url: string) => undefined);
    await expect(resolveGamingDocument(startUrl, 100_000, { onRequestUrl: sourceGuard })).rejects.toMatchObject(rejection);
    expect(sourceGuard.mock.calls).toEqual([[startUrl]]); expect(resolve4).toHaveBeenCalledTimes(1);
    expect(resolve6).toHaveBeenCalledTimes(1); expect(mockHttp).not.toHaveBeenCalled();
  });

  it('preserves guarded redirect acquisition, logical identities and protected IP-pinned request options', async () => {
    mockHttp.mockResolvedValueOnce({ status: 301, data: 'moved', headers: { location: finalUrl, 'content-type': 'text/plain' } });
    const sourceGuard = jest.fn((_url: string) => 'https://127.0.0.1/ignored-return-value');
    const document = await resolveGamingDocument(startUrl, 100_000, { onRequestUrl: sourceGuard });
    expect(sourceGuard.mock.calls.map(([url]) => url)).toEqual([startUrl, finalUrl]);
    expect(document).toMatchObject({ requestedUrl: startUrl, canonicalUrl: finalUrl, publicUrl: finalUrl,
      acquisition: { redirectCount: 1, finalUrl } });
    expect(document.text).toContain('Uchigatana'); expect(isResolvedGamingDocumentIdentityVerified(document, startUrl)).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(2); expect(resolve6).toHaveBeenCalledTimes(2); expect(mockHttp).toHaveBeenCalledTimes(2);
    for (const [url, options] of mockHttp.mock.calls) {
      expect(new URL(url as string).hostname).toBe('93.184.216.34');
      expect(options).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'stream', headers: { Host: 'guides.example.org' } });
    }
  });

  it('guards Archive metadata-derived OCR destinations before their independent DNS and HTTP requests', async () => {
    const metadataUrl = 'https://archive.org/metadata/KH1.5_guide';
    const derivativeUrl = `https://${gamingArchiveStorageHost}${gamingArchiveDerivativePath}`;
    mockHttp.mockResolvedValueOnce({ status: 200, data: JSON.stringify(gamingArchiveMetadata()), headers: { 'content-type': 'application/json' } });
    const sourceGuard = jest.fn((url: string) => { if (url !== metadataUrl) throw new Error('private-archive-denial'); });
    const failure = await resolveGamingDocument(gamingArchiveGuideUrl, 100_000, { onRequestUrl: sourceGuard }).catch(error => error);
    expect(failure).toMatchObject({ code: 'GAMING_ARCHIVE_DOCUMENT_UNAVAILABLE' }); expect(String(failure)).not.toContain('private-archive-denial');
    expect(sourceGuard.mock.calls.map(([url]) => url)).toEqual([metadataUrl, derivativeUrl]);
    expect(resolve4.mock.calls).toEqual([['archive.org']]); expect(resolve6.mock.calls).toEqual([['archive.org']]);
    expect(mockHttp).toHaveBeenCalledTimes(1);
  });

  it('forwards the adapter guard through the real v2 candidate evaluator and resolver', async () => {
    const sourceGuard = jest.fn(() => { throw new Error('private-adapter-denial'); });
    const execute = jest.fn<LiveValidationGamingExecutor>(async () => { throw new Error('Generation must not run for denied sources.'); });
    const adapter = createLiveValidationGamingAdapter(execute, { sourceGuard });
    const observer: LivePrPreviewModuleObserver = { onSourceAcquisition: jest.fn(), onSourceValidation: jest.fn(),
      onAnswerAuditStart: jest.fn(), onAudit: jest.fn(), onFailure: jest.fn() };
    const validated = adapter.validateInput({ query: { contractVersion: 'gaming-hybrid-v2', game: 'Elden Ring', mode: 'build',
      class: 'Samurai', progressPoint: 'just left the tutorial', storagePolicy: 'transient_only', idempotencyKey: 'source-guard-adapter-001',
      question: "I'm a Samurai at the beginning of Elden Ring, just out of the tutorial. I want a Samurai blade build." }, candidateUrls: [startUrl] });
    if (!validated.ok) throw new Error('Expected a valid transient v2 request.');
    const result = await adapter.execute(validated.input, observer);
    expect(result.accepted).toBe(false); expect(result.failureCode).toBe('ACQUISITION_FAILURE');
    expect(sourceGuard.mock.calls).toEqual([[startUrl]]); expect(execute).not.toHaveBeenCalled();
    expect(resolve4).not.toHaveBeenCalled(); expect(resolve6).not.toHaveBeenCalled(); expect(mockHttp).not.toHaveBeenCalled();
    expect(adapter.getLastObservation()?.candidates).toEqual([expect.objectContaining({ decision: 'rejected', reasonCodes: ['URL_BLOCKED'] })]);
    expect(JSON.stringify(adapter.getLastObservation())).not.toContain('private-adapter-denial');
  });
});
