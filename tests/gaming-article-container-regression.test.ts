import { describe, expect, it } from '@jest/globals';
import { gamingDocumentFetchOptions } from '../src/services/gamingDocumentExtraction.js';
import { extractFetchAndCleanDocument, type FetchAndCleanExtractionMetrics } from '../src/shared/webFetcher.js';

describe('Gaming named article containers competing with ordinary cards', () => {
  it.each([true, false])('keeps the full guide beside an exact article-content card (linked=%s)', linked => {
    const url = 'https://publisher.example/elden-ring-samurai';
    const guide = '<article><h1>Elden Ring Samurai guide</h1>'
      + Array.from({ length: 25 }, (_, index) => `<p>Guide route ${index}: In Elden Ring, upgrade Uchigatana with Smithing Stones and raise Vigor to 40. Equip a medium armor load before reaching level 50. Practice Unsheathe against safe early enemies.</p>`).join('')
      + '<p>Final route: retain Unsheathe through level 50.</p></article>';
    const cardText = '<h2>Publisher event spotlight</h2><p>Our publisher celebrates achievements across a diverse community. Every event brings players together for shared adventures. Readers can discover new interests through creative activities. Thoughtful preparation helps everyone enjoy an inspiring journey.</p>';
    const card = `<div class="article-content">${linked ? `<a href="/news">${cardText}</a>` : cardText}</div>`;
    let metrics: FetchAndCleanExtractionMetrics | undefined;
    const result = extractFetchAndCleanDocument(url,
      `<html><title>Elden Ring Samurai guide</title><body><main>${guide}${card}</main></body></html>`,
      'text/html', 100_000, gamingDocumentFetchOptions(url, {
        retainFullSelectedText: true,
        onExtraction: value => { metrics = value; }
      }));
    expect(result.text).toContain('Guide route 0');
    expect(result.text).toContain('Guide route 24');
    expect(result.text).toContain('Final route: retain Unsheathe through level 50.');
    expect(result.text).not.toContain('Publisher event spotlight');
    expect(metrics?.selectedContainer).toBe('article');
  });
});
