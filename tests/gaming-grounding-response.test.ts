import { describe, expect, it } from '@jest/globals';
import { shapeClientRouteResult } from '../src/shared/http/clientRouteResultShape.js';
import { ClarificationAgent, IntentRouterAgent, ResponseComposerAgent } from '../src/services/gamingAgents.js';
import type { GamingGrounding, GamingSuccessEnvelope } from '../src/services/gamingModes.js';

const grounding: GamingGrounding = {
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
  const intent = {
    ...IntentRouterAgent.classify({ mode: 'guide', game: 'Kingdom Hearts', prompt: 'Where should I go next?' }),
    mode: 'guide' as const,
  };

  function groundedEnvelope(response: string): GamingSuccessEnvelope {
    return {
      ok: true, route: 'gaming', mode: 'guide',
      data: {
        response,
        sources: [{ url: 'https://guides.example/kingdom-hearts', title: 'Kingdom Hearts guide' }],
        grounding: { ...grounding },
      },
    };
  }

  it('answers once without diagnostic prose or warnings about absent optional context', () => {
    const opening = 'Go to Traverse Town and speak to Cid.';
    const response = `${opening}\nThen return to the next objective described in the guide [1].`;
    expect(intent.platform).toBeUndefined();
    expect(intent.difficulty).toBeUndefined();
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });

    const composed = ResponseComposerAgent.compose({ intent, backendEnvelope: groundedEnvelope(response) });
    expect(composed.data.response).toBe(response);
    expect(composed.data.response.split(opening)).toHaveLength(2);
    for (const diagnostic of [
      'Backend-supported:', 'Inference:', 'the guidance above came from the ARCANOS Gaming backend',
      'ARCANOS Gaming added the section labels', 'Context:', 'Context used:', 'Patch/version:',
    ]) {
      expect(composed.data.response).not.toContain(diagnostic);
    }

    expect(shapeClientRouteResult(composed)).toEqual(groundedEnvelope(response));
    expect(composed.data.grounding).toEqual(grounding);
  });

  it.each([
    '### Quick Answer\nVisit Cid [1].\n\n### Steps\n1. Return to town.\n   - Visit the shop.\n2. Speak to Cid.\n\n### Watch Outs\nStop at your requested checkpoint.',
    'Quick Answer\nVisit Cid.\n\nWhy It Works\nThe guide links him to this objective [1].\n\nWatch Outs\nThis assumes you completed the preceding objective.',
    'Use this route [1].\n\n```text\nTown -> Shop\n  -> Cid\n```\n\n[1]: https://guides.example/kingdom-hearts "Guide"\n',
    'For the version covered by this guide, use the west entrance [1]. The other edition uses the east entrance; which edition are you playing?',
    'On hard difficulty, save the item for the second phase [1]. On normal, the guide recommends using it immediately.',
  ])('preserves complete provider structure, citations, and material qualifications: %#', (response) => {
    const envelope = groundedEnvelope(response);
    expect(ResponseComposerAgent.compose({ intent, backendEnvelope: envelope }).data.response).toBe(response);
  });

  it('preserves source, grounding, and optional audit metadata through composition', () => {
    const envelope = groundedEnvelope('Visit Cid [1].');
    envelope.data.auditTrace = { draft: 'Visit Cid [1].', finalized: 'Visit Cid [1].' };
    envelope.data.hrc = { passed: true };
    envelope.data.grounding!.groundedInSuppliedEvidence = false;
    expect(ResponseComposerAgent.compose({ intent, backendEnvelope: envelope })).toEqual(envelope);
  });

  it('keeps fallback disclosure even when retrieval found grounded evidence', () => {
    const envelope = groundedEnvelope('General guidance while generation is unavailable.');
    envelope.data.fallbackReason = 'GAMING_PROVIDER_UNAVAILABLE';
    envelope.data.grounding!.groundedInSuppliedEvidence = false;
    const composed = ResponseComposerAgent.compose({ intent, backendEnvelope: envelope });
    expect(composed.data.fallbackReason).toBe('GAMING_PROVIDER_UNAVAILABLE');
    expect(composed.data.grounding).toEqual(envelope.data.grounding);
    expect(composed.data.response).toContain('General guidance while generation is unavailable.');
    expect(composed.data.response).not.toBe(envelope.data.response);
  });

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
