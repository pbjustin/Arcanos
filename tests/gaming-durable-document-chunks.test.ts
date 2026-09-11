import { describe, expect, it } from '@jest/globals';
import {
  chunkGamingDocument,
  GAMING_DURABLE_DOCUMENT_LIMITS,
  hashGamingDocumentRevision
} from '../src/services/gamingDurableDocumentChunks.js';
import { buildGamingLargeGuideFixture } from './testUtils/gamingLargeGuideFixture.js';

describe('durable Gaming document chunks', () => {
  it('covers a synthetic large guide through its near-end marker with deterministic identities', async () => {
    const fixture = buildGamingLargeGuideFixture();
    const first = await chunkGamingDocument(fixture.text);
    const second = await chunkGamingDocument(fixture.text);
    expect(first).toEqual(second);
    expect(first.documentChars).toBeGreaterThan(500_000);
    expect(first.chunks.length).toBeGreaterThan(100);
    expect(first.chunks.length).toBeLessThanOrEqual(500);
    expect(first.indexedChars).toBe(first.text.length);
    expect(first.coverageStatus).toBe('complete');
    expect(first.documentTruncated).toBe(false);
    expect(first.chunks.some(chunk => chunk.text.includes(fixture.markers.late))).toBe(true);
    expect(first.chunks.some(chunk => chunk.text.includes(fixture.markers.nearEnd))).toBe(true);
    for (const [index, chunk] of first.chunks.entries()) {
      expect(chunk.ordinal).toBe(index);
      expect(chunk.totalChunks).toBe(first.chunks.length);
      expect(chunk.text).toBe(first.text.slice(chunk.startChar, chunk.endChar));
      expect(chunk.text.length).toBeLessThanOrEqual(GAMING_DURABLE_DOCUMENT_LIMITS.maxChunkChars);
      if (index) {
        expect(chunk.startChar).toBeLessThanOrEqual(first.chunks[index - 1].endChar);
        expect(first.chunks[index - 1].endChar - chunk.startChar).toBeLessThanOrEqual(240);
      }
    }
  });

  it('hashes late content and policy changes while preserving unchanged refresh identity', () => {
    const { text, markers } = buildGamingLargeGuideFixture();
    const original = hashGamingDocumentRevision(text, '{}');
    expect(hashGamingDocumentRevision(text, '{}')).toBe(original);
    expect(hashGamingDocumentRevision(text.replace(markers.late, 'Different synthetic late objective.'), '{}')).not.toBe(original);
    expect(hashGamingDocumentRevision(text, '{}', 'gaming-document-chunks-v2')).not.toBe(original);
  });

  it('marks a deterministic bounded prefix when document or record bounds are reached', async () => {
    const text = 'Synthetic checkpoint. '.repeat(60_000);
    const result = await chunkGamingDocument(text);
    expect(result.text.length).toBeLessThanOrEqual(1_000_000);
    expect(result.chunks).toHaveLength(500);
    expect(result.documentTruncated).toBe(true);
    expect(result.coverageStatus).toBe('partial');
    expect(result.indexedChars).toBe(result.chunks.at(-1)?.endChar);
    expect(result.indexedChars).toBeLessThan(result.text.length);
  });

  it('handles enormous paragraphs and malformed Unicode without broken code points or controls', async () => {
    const result = await chunkGamingDocument(`\uD800\u0000${'🗝'.repeat(110_000)}\uDC00`);
    expect(result.documentTruncated).toBe(false);
    expect(result.indexedChars).toBe(result.text.length);
    for (const chunk of result.chunks) {
      expect(chunk.text).not.toMatch(/[\u0000-\u001f]/u);
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });

  it('preserves explicit heading provenance without inventing OCR page numbers', async () => {
    const result = await chunkGamingDocument(`# Synthetic objective\n\n${'Follow the checkpoint route. '.repeat(200)}`);
    expect(result.chunks[0].headingPath).toEqual(['Synthetic objective']);
    expect(result.chunks[0]).not.toHaveProperty('page');
  });

  it('yields during chunking so cancellation prevents completion', async () => {
    const controller = new AbortController();
    const work = chunkGamingDocument('Synthetic route objective. '.repeat(30_000), { signal: controller.signal });
    controller.abort(new Error('Synthetic cancellation'));
    await expect(work).rejects.toThrow();
  });
});
