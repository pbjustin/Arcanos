import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { countGamingHtmlElements, stripGamingHtmlTags } from '../src/services/gamingDocumentExtraction.js';

const cases = [
  '', 'plain Unicode é中😀', '<', '<a', '<a<a<a', '<>', '<a></a>', '<A><é><中>',
  '<a<b>tail<c>', '<a title=">">text<b>', '<!-- <a> comment -->',
  'before<broken <i title="<nested>">after', '<a\nattribute="value">tail<unfinished',
  '<script>const asset = "<a>";</script><p>guide</p>', '<a>\u0000<z>'
];

describe('linear Gaming HTML budget and source-use scans', () => {
  it.each(cases)('preserves existing complete-span semantics for bounded input %#', body => {
    const completeStarts = body.match(/<[A-Za-z][^>]*>/g)?.length ?? 0;
    for (const cap of [0, 1, 30_000]) {
      expect(countGamingHtmlElements(body, cap)).toBe(Math.min(completeStarts, cap + 1));
    }
    expect(stripGamingHtmlTags(body)).toBe(body.replace(/<[^>]*>/gu, ' '));
  });

  it('retains the exact 30,000-element admission boundary and stops after proving overflow', () => {
    expect(countGamingHtmlElements('<i>'.repeat(30_000), 30_000)).toBe(30_000);
    expect(countGamingHtmlElements('<i>'.repeat(30_001) + '<a'.repeat(50_000), 30_000)).toBe(30_001);
  });

  it('preserves incomplete trailing text and restrictions after complete removed spans', () => {
    const body = '<header>Menu</header><p>No automated use.</p><broken <unfinished';
    expect(stripGamingHtmlTags(body)).toBe(' Menu  No automated use. <broken <unfinished');
  });

  it('preserves restrictions and incomplete trailing text across a strip batch boundary', () => {
    const body = '<>'.repeat(2_049) + '<p>No automated use.</p><unfinished';
    expect(stripGamingHtmlTags(body)).toBe(' '.repeat(2_049) + ' No automated use. <unfinished');
  });

  it('bounds five-million-character unclosed and dense closed scans in a disposable Node child', () => {
    // Native type stripping imports only this pure module; no app, DNS, HTTP or database starts.
    // SIGKILL contains a regression even if a synchronous scan blocks JavaScript timers.
    const moduleUrl = new URL('../src/services/gamingDocumentExtraction.ts', import.meta.url).href;
    const script = `const { countGamingHtmlElements, stripGamingHtmlTags } = await import(${JSON.stringify(moduleUrl)});
      const results = [];
      for (const closed of [false, true]) {
        const body = (closed ? '<>' : '<a').repeat(2_500_000);
        const started = performance.now();
        const count = countGamingHtmlElements(body, 30_000);
        const output = stripGamingHtmlTags(body);
        const validProjection = closed ? output.length === 2_500_000 && output.trim().length === 0 : output === body;
        results.push({ chars: body.length, count, validProjection, outputChars: output.length, elapsedMs: performance.now() - started });
      }
      process.stdout.write(JSON.stringify(results));`;
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 4_096
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([
      expect.objectContaining({ chars: 5_000_000, count: 0, validProjection: true, outputChars: 5_000_000 }),
      expect.objectContaining({ chars: 5_000_000, count: 0, validProjection: true, outputChars: 2_500_000 })
    ]);
  }, 10_000);
});
