import { describe, expect, it } from '@jest/globals';
import { shapeClientRouteResult } from '../src/shared/http/clientRouteResultShape.js';

const grounding = {
  groundingStatus: 'grounded',
  requestedSourceCount: 1,
  fetchedSourceCount: 1,
  fetchedSuppliedSourceCount: 1,
  usableSourceCount: 1,
  citableSourceCount: 1,
  selectedChunkCount: 2,
  suppliedEvidenceSourceCount: 1,
  groundedInSuppliedEvidence: true,
};

describe('Gaming grounding public projection', () => {
  it('preserves only bounded grounding fields on success', () => {
    const shaped = shapeClientRouteResult({
      ok: true, route: 'gaming', mode: 'guide',
      data: {
        response: 'Use the selected guide evidence.', sources: [],
        grounding: { ...grounding, privateFetchUrl: 'https://example.com/private', rawText: 'private document' },
      },
    });
    expect(shaped).toEqual({
      ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Use the selected guide evidence.', sources: [], grounding },
    });
  });

  it.each(['GAMING_SOURCE_UNREADABLE', 'GAMING_SOURCE_UNAVAILABLE'])('preserves %s without raw diagnostics', (code) => {
    const failureGrounding = {
      ...grounding,
      groundingStatus: 'insufficient_evidence',
      usableSourceCount: 0, citableSourceCount: 0, selectedChunkCount: 0,
      suppliedEvidenceSourceCount: 0, groundedInSuppliedEvidence: false,
    };
    const shaped = shapeClientRouteResult({
      ok: false, route: 'gaming', mode: 'guide',
      error: {
        code, message: 'private upstream exception',
        details: { grounding: { ...failureGrounding, raw: 'private body' }, privateFetchUrl: 'private URL' },
      },
    });
    expect(shaped).toMatchObject({
      ok: false, route: 'gaming', mode: 'guide', error: { code, details: { grounding: failureGrounding } },
    });
    expect(JSON.stringify(shaped)).not.toContain('private');
  });

  it.each([NaN, Infinity, -1, 1.5, 1_000_001, '1'])('omits malformed count %s rather than projecting it', (count) => {
    const shaped = shapeClientRouteResult({
      ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Example response.', sources: [], grounding: { ...grounding, selectedChunkCount: count } },
    }) as { data: Record<string, unknown> };
    expect(shaped.data.grounding).toBeUndefined();
  });
});
