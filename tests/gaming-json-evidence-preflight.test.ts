import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actualCheerio = await import('cheerio');
const mockLoad = jest.fn(actualCheerio.load);
jest.unstable_mockModule('cheerio', () => ({ ...actualCheerio, load: mockLoad }));
const { extractGamingJsonEvidence, GAMING_JSON_EVIDENCE_LIMITS: limits } =
  await import('../src/services/gamingJsonEvidence.js');

const sourceUrl = 'https://synthetic.example/preflight-records';
const record = { system: 'TEST-ORION-01', body: 'B 2', site: 'PML 7', resource: 'Platinum' };
const serialized = JSON.stringify(record);
const script = `<script type="application/json">${serialized}</script>`;

describe('Gaming inert JSON DOM preflight', () => {
  beforeEach(() => { mockLoad.mockClear(); });

  it.each(['text/html', 'application/xhtml+xml; charset=utf-8'])(
    'avoids DOM parsing for script-free %s while retaining empty-evidence diagnostics', contentType => {
      const body = `<article><p>${'Synthetic guide prose. '.repeat(5_000)}</p></article>`;
      const result = extractGamingJsonEvidence({ body, contentType, sourceUrl });
      expect(mockLoad).not.toHaveBeenCalled();
      expect(result).toEqual({ units: [], attempts: [], subreasons: ['no_supported_structured_records'],
        truncated: false, inputBytes: Buffer.byteLength(body, 'utf8'), outputChars: 0 });
    }
  );

  it('preserves a transport cutoff without parsing script-free malformed HTML', () => {
    const result = extractGamingJsonEvidence({ body: '<article><p>Unfinished synthetic guide',
      contentType: 'text/html', sourceUrl, transportTruncated: true });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(result).toMatchObject({ units: [], attempts: [], outputChars: 0,
      truncated: true, subreasons: ['content_truncated'] });
  });

  it.each([
    ['character', () => ' '.repeat(limits.htmlChars + 1)],
    ['element', () => '<i></i>'.repeat(limits.htmlElements + 1)]
  ] as const)('retains the %s admission bound before the no-script shortcut', (_name, body) => {
    const result = extractGamingJsonEvidence({ body: body(), contentType: 'text/html', sourceUrl });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(result).toMatchObject({ units: [], attempts: [], outputChars: 0,
      truncated: true, subreasons: ['extraction_budget_exhausted'] });
  });

  it('retains an already expired extraction deadline before the no-script shortcut', () => {
    const result = extractGamingJsonEvidence({ body: '<article>No structured records.</article>',
      contentType: 'text/html', sourceUrl, deadlineAt: Date.now() - 1 });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(result).toMatchObject({ units: [], attempts: [], outputChars: 0,
      truncated: true, subreasons: ['extraction_budget_exhausted'] });
  });

  it('checks the extraction deadline again before returning from the no-script shortcut', () => {
    const now = 10_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValueOnce(now)
      .mockReturnValueOnce(now).mockReturnValue(now + limits.elapsedMs);
    try {
      const result = extractGamingJsonEvidence({ body: '<article>No structured records.</article>',
        contentType: 'text/html', sourceUrl });
      expect(mockLoad).not.toHaveBeenCalled();
      expect(result).toMatchObject({ units: [], attempts: [], outputChars: 0,
        truncated: true, subreasons: ['extraction_budget_exhausted'] });
    } finally { clock.mockRestore(); }
  });

  it.each([
    ['uppercase script', `<SCRIPT TYPE="APPLICATION/JSON">${serialized}</SCRIPT>`, 1],
    ['unclosed script', `<script type="application/json">${serialized}`, 0],
    ['malformed opener', '<script', 0],
    ['non-script tag sharing the prefix', `<scripture>${serialized}</scripture>`, 0],
    ['commented script', `<!-- ${script} -->`, 0],
    ['template script', `<template>${script}</template>`, 0]
  ] as const)('leaves the possible %s opener to DOM validation', (_name, body, count) => {
    const result = extractGamingJsonEvidence({ body, contentType: 'text/html', sourceUrl });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(result.units).toHaveLength(count);
    if (count) {
      expect(result.units[0].integrity).toEqual({ status: 'complete', reasons: [] });
      expect(result.units[0].provenance).toMatchObject({ sourceUrl, strategy: 'application_json',
        locator: 'script[1]#', jsonOnly: true });
    }
  });

  it('preserves direct and embedded JSON evidence while parsing only the HTML representation', () => {
    const direct = extractGamingJsonEvidence({ body: serialized, contentType: 'application/json', sourceUrl });
    expect(mockLoad).not.toHaveBeenCalled();
    const embedded = extractGamingJsonEvidence({ body: `<article>${script}</article>`,
      contentType: 'text/html', sourceUrl });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(direct.units).toHaveLength(1);
    expect(embedded.units).toHaveLength(1);
    expect(embedded.units[0].fields).toEqual(direct.units[0].fields);
    expect(embedded.units[0].integrity).toEqual(direct.units[0].integrity);
    expect(direct.units[0].provenance).toMatchObject({ locator: 'response#', jsonOnly: true });
    expect(embedded.units[0].provenance).toMatchObject({ locator: 'script[1]#', jsonOnly: true });
    expect(direct.truncated).toBe(false);
    expect(embedded.truncated).toBe(false);
  });
});
