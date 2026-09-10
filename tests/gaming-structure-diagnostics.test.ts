import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; } async resolve6() { return []; } cancel() {}
} }));
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { assessGamingStructuralUsability } = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const table = '<table><tr><th>System</th><th>Body</th><th>Site</th><th>Resource</th></tr><tr><td>TEST-ORION-01</td><td>B 2</td><td>PML 7</td><td>Platinum</td></tr></table>';
const url = 'https://example.org/synthetic-structured';
function response(body: string) { http.mockResolvedValue({ data: body, headers: { 'content-type': 'text/html' } }); }
describe('bounded Gaming extraction diagnostics', () => {
  beforeEach(() => jest.resetAllMocks());
  it('separates raw diagnostic preview truncation from complete structural extraction', async () => {
    response(`<html><body>${table}</body></html>`);
    const document = await resolveGamingDocument(url, 100_000, { rawDocumentMaxChars: 8 });
    expect(document.rawDocument?.truncated).toBe(true);
    expect(document.metrics.truncated).toBe(false);
    expect(document.structureDiagnostics).toMatchObject({ strategies: expect.arrayContaining(['html_table']),
      contentType: 'text/html', selectedUnits: 1, completeUnits: 1, partialUnits: 0, ambiguousUnits: 0,
      truncationStages: ['raw_preview'], budgetOutcome: 'within_budget' });
    expect(document.structureDiagnostics!.receivedBytes).toBe(document.structureDiagnostics!.acceptedBytes);
    expect(document.structureDiagnostics!.rawChars).toBeGreaterThan(document.structureDiagnostics!.extractedChars);
    expect(JSON.stringify(document.structureDiagnostics)).not.toMatch(/TEST-ORION|Platinum|example\.org/);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['', 'empty_response'],
    ['<body><p>Verify you are human</p></body>', 'access_challenge'],
    ['<body><p>Sign in to continue</p></body>', 'access_challenge'],
    ['<body><img src="scan.png"></body>', 'image_only_content'],
    ['<body><noscript>Enable JavaScript to use this guide</noscript></body>', 'script_rendering_required']
  ])('reports only demonstrated empty/shell conditions %#', async (body, reason) => {
    response(body);
    const document = await resolveGamingDocument(url);
    expect(document.evidenceUnits ?? []).toHaveLength(0);
    expect(document.text).toBe('');
    expect(document.structureDiagnostics?.subreasons).toContain(reason);
  });
  it('does not diagnose scripts or access challenges from short text alone', async () => {
    response('<body><p>Short but ordinary source text</p></body>');
    const document = await resolveGamingDocument(url);
    expect(document.structureDiagnostics?.subreasons).not.toContain('script_rendering_required');
    expect(document.structureDiagnostics?.subreasons).not.toContain('access_challenge');
  });
  it('retains source-use restrictions outside the preferred container', async () => {
    response(`<html><body>${table}<footer>Do not store this content</footer></body></html>`);
    const document = await resolveGamingDocument(url);
    expect(document.sourceUseRestricted).toBe(true);
  });
  it('does not accept a challenge shell through embedded records', async () => {
    response('<body><p>Verify you are human</p><script type="application/json">{"locations":[{"System":"TEST-ORION-01","Body":"B 2","Site":"PML 7","Resource":"Platinum"}]}</script></body>');
    const document = await resolveGamingDocument(url);
    expect(document.evidenceUnits ?? []).toHaveLength(0);
    expect(document.text).toBe('');
    expect(document.structureDiagnostics?.subreasons).toContain('access_challenge');
  });
  it('preserves grouped-header qualifiers when assessing a location claim', async () => {
    response(table.replace('<table>', '<table><tr><th colspan="4">Example only</th></tr>'));
    const document = await resolveGamingDocument(url);
    expect(document.evidenceUnits?.[0].text).toContain('Example only');
    expect(assessGamingStructuralUsability({ units: document.evidenceUnits, prompt: 'Where is Platinum in TEST-ORION-01?' }))
      .toMatchObject({ hasIntactUsableUnit: true, claimSupported: false, reasonCodes: ['QUALIFIED_RECORD_NOT_AFFIRMATIVE'] });
  });
  it('ignores caller query preferences in durable extraction and original-body content guards', async () => {
    response(`<article><p>${'An ordinary synthetic guide explains preparation and careful resource planning. '.repeat(4)}</p></article>${table}`);
    const first = await resolveGamingDocument(url, 100_000, { preferredContentTerms: ['Platinum'] });
    const second = await resolveGamingDocument(url, 100_000, { preferredContentTerms: ['planning'] });
    expect(first.text).toBe(second.text);
    expect(first.evidenceUnits).toEqual(second.evidenceUnits);
    http.mockResolvedValue({ data: `<script>${'\u0000'.repeat(80)}</script>${table}`, headers: { 'content-type': 'text/html' } });
    await expect(resolveGamingDocument(url)).rejects.toThrow();
  });
  it('does not promote an example-only equipment statistic to an actual claim', async () => {
    http.mockResolvedValue({ data: JSON.stringify({ equipmentStats: [{ item: 'Axe', stat: 'Weight', value: 12,
      unit: 'kg', scope: 'Base edition', qualifier: 'example only' }] }), headers: { 'content-type': 'application/json' } });
    const document = await resolveGamingDocument(url);
    expect(assessGamingStructuralUsability({ units: document.evidenceUnits, prompt: 'What is the Axe weight statistic?' }))
      .toMatchObject({ hasIntactUsableUnit: true, claimSupported: false, reasonCodes: ['QUALIFIED_RECORD_NOT_AFFIRMATIVE'] });
  });
  it.each([false, true])('keeps a bounded prefix and detects omitted conflicts when strategies exceed the unit cap (%s)', async conflicting => {
    const tables = [0, 1].map(group => `<table><tr><th>System</th><th>Body</th><th>Site</th><th>Resource</th></tr>${Array.from({ length: 1023 }, (_, row) =>
      `<tr><td>T-${group}-${row}</td><td>B 2</td><td>PML 7</td><td>Platinum</td></tr>`).join('')}</table>`).join('');
    const records = [1, 2, 3].map(index => ({ system: `JSON-${index}`, body: 'B 2', site: 'PML 7', resource: 'Platinum' }));
    if (conflicting) records[2] = { system: 'T-0-0', body: 'B 2', site: 'PML 7', resource: 'Iron' };
    response(`<body>${tables}<script type="application/json">${JSON.stringify({ records })}</script></body>`);
    const document = await resolveGamingDocument(url, 1_000_000, { documentPurpose: 'durable' });
    expect(document.evidenceUnits?.length).toBeGreaterThan(2000);
    expect(document.evidenceUnits!.length).toBeLessThanOrEqual(2048);
    expect(document.structureDiagnostics).toMatchObject({ budgetOutcome: 'exhausted' });
    expect(document.structureDiagnostics?.subreasons).toContain('extraction_budget_exhausted');
    expect(document.evidenceUnits![0].integrity.status).toBe(conflicting ? 'ambiguous' : 'complete');
    expect(http).toHaveBeenCalledTimes(1);
  });
});
