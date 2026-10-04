import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const mockHttp = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { buildGamingRagContext, clearGamingRagCache } = await import('../src/services/gamingWebContext.js');
const { assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');

const sourceUrl = 'https://guides.example.org/samurai-uchigatana';
const envKeys = ['ARCANOS_GAMING_RAG_CHUNK_CHARS', 'ARCANOS_GAMING_RAG_ENABLED', 'ARCANOS_GAMING_CURATED_SOURCES_JSON'] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const input = { game: 'Elden Ring', edition: 'Base game', mode: 'guide' as const,
  prompt: 'Explain Samurai Uchigatana Unsheathe combat rotation.', guideUrl: sourceUrl, guideUrls: [] };
const unscoped = 'UNSCOPED_SENTINEL: this Elden Ring Samurai Uchigatana guide explains Unsheathe with unsupported equipment substitution and combat rotation. Equip the weapon and extra armor to achieve reliable combat damage and safe rolls.';
function page(scopeLabel: string, includeBase = true) {
  const row = (scope: string, description: string) => `<tr><td>Samurai</td><td>Uchigatana</td><td>Unsheathe</td><td>${scope}</td><td>${description}</td></tr>`;
  mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>Elden Ring Samurai Uchigatana guide</title><body><article>
      <p>In Elden Ring, this Samurai Uchigatana guide explains the starting katana and Unsheathe skill with intact gameplay instructions.</p>
      <table><thead><tr><th>Build</th><th>Item</th><th>Skill</th><th>${scopeLabel}</th><th>Description</th></tr></thead><tbody>
      ${includeBase ? row('base-game', 'Use the Unsheathe heavy attack when enemy recovery permits a safe stance-breaking strike.') : ''}
      ${row('Shadow of the Erdtree', 'DLC_ONLY_SENTINEL: use expansion katana after reaching the expansion area.')}
      </tbody></table><p>${unscoped}</p></article></body></html>` }));
}

describe('ordinary live retrieval with acquired edition-scoped records', () => {
  beforeEach(() => {
    clearGamingRagCache();
    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '1600';
    process.env.ARCANOS_GAMING_RAG_ENABLED = 'true';
    process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON = '[]';
  });
  afterEach(() => {
    clearGamingRagCache();
    for (const key of envKeys) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it.each(['Scope', 'Applicability', 'Edition'])('keeps only independently scoped base-game %s facts through selection and CLEAR', async scopeLabel => {
    page(scopeLabel);
    const result = await buildGamingRagContext(input);
    expect(result.context).toContain('Use the Unsheathe heavy attack');
    expect(result.context).not.toMatch(/DLC_ONLY_SENTINEL|UNSCOPED_SENTINEL|Shadow of the Erdtree/u);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].snippet).not.toMatch(/DLC_ONLY_SENTINEL|UNSCOPED_SENTINEL/u);
    expect(result.clearKnowledge!.evidence).toHaveLength(1);
    expect(result.clearKnowledge!.sources[0].freshnessMetadata).toMatchObject({ edition: 'base-game' });
    expect(result.clearKnowledge!.sources[0].clearSourceAssessment!.subjectHash)
      .toBe(result.clearKnowledge!.evidence![0].revisionId.slice('live:'.length));
    expect(assessGamingClearEvidence(input, result.clearKnowledge!).decision).toBe('accept');
    const cached = await buildGamingRagContext(input);
    expect(cached.cacheHit).toBe(true);
    expect(cached.context).toBe(result.context);
  });

  it.each(['Scope', 'Applicability', 'Edition'])('does not revive unscoped prose when acquired %s records are DLC-only', async scopeLabel => {
    page(scopeLabel, false);
    const result = await buildGamingRagContext(input);
    expect(result.context).toBe('');
    expect(result.clearKnowledge!.evidence).toEqual([]);
    expect(assessGamingClearEvidence(input, result.clearKnowledge!).decision).toBe('reject');
  });
});
