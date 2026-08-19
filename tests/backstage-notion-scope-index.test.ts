import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '../src/shared/backstage/backstageNotionScopeIndex.js';

describe('Backstage Notion v5 scope index', () => {
  it('digests equivalent normalized text without mutating visible text', () => {
    const visiblePath = Object.freeze([
      '  ＷＷＥ_２Ｋ\t RAW  ',
      'Women’s   Division',
    ]);

    expect(BACKSTAGE_NOTION_RAG_INDEX_FORMAT).toBe(
      'backstage-notion-rag-index-v5'
    );
    const keys = normalizeBackstageNotionScopePath(visiblePath);
    expect(keys).toHaveLength(2);
    expect(keys.every(key => /^[0-9a-f]{64}$/u.test(key))).toBe(true);
    expect(keys[0]).toBe(normalizeBackstageNotionScopeKey('wwe_2k raw'));
    expect(keys[1]).toBe(normalizeBackstageNotionScopeKey('women’s division'));
    expect(visiblePath).toEqual([
      '  ＷＷＥ_２Ｋ\t RAW  ',
      'Women’s   Division',
    ]);
  });

  it('bounds compatibility expansion to fixed digests and rejects empty keys', () => {
    const expanding = '\uFDFA'.repeat(240);
    expect(Array.from(expanding.normalize('NFKC')).length).toBeGreaterThan(4_000);
    expect(normalizeBackstageNotionScopeKey(expanding)).toMatch(/^[0-9a-f]{64}$/u);
    expect(normalizeBackstageNotionScopeKey('K')).toBe(
      normalizeBackstageNotionScopeKey('K')
    );
    expect(() => normalizeBackstageNotionScopeKey(' \t ')).toThrow(
      'must remain non-empty'
    );
  });
});
