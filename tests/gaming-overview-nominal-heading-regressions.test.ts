import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { classifyGamingDocumentQuality, isGamingDocumentOverviewOnly } from '../src/shared/gaming/gamingDocumentIngestionCore.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const url = 'https://guides.example.org/nominal-topic-guide';
const fixtures = [
  { game: 'Elden Ring', topic: 'Uchigatana', heading: 'Elden Ring Uchigatana location guide' },
  { game: 'Fallout 76', topic: 'Practice Blade', heading: 'Fallout 76 Practice Blade acquisition guide' },
  { game: 'Lantern Voyage', topic: 'Lumen Key', heading: 'Lantern Voyage Lumen Key location guide' }
];
const body = (topic: string) => `This article explains how to acquire the ${topic}.`;

/** This is retained evidence with established backend identity; its text must still prove a gameplay claim. */
function knowledge(game: string, text: string, title?: string): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-11-06T12:00:00.000Z';
  return { context: '', sources: [{ game, sourceId: 'nominal-source', url, title,
    sourceType: 'supplied', origin: 'stored', fetchedAt, snippet: text }],
  evidence: [{ sourceId: 'nominal-source', revisionId: 'nominal-revision', recordId: 'nominal-record',
    recordType: 'guide', publicUrl: url, text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt } }] };
}

beforeEach(() => {
  http.mockReset();
  for (const level of ['info', 'warn', 'error', 'debug'] as const) jest.spyOn(logger, level).mockImplementation(() => undefined);
});

describe('nominal topic headings cannot promote overview text into gameplay evidence', () => {
  it('keeps the exact Uchigatana description insufficient after its acquired location-guide heading is prepended', () => {
    const { game, topic, heading } = fixtures[0];
    const description = body(topic);
    expect(isGamingDocumentOverviewOnly(description, undefined, game)).toBe(true);
    expect(classifyGamingDocumentQuality({ cleanedText: description, game, truncated: false, minUsefulTextChars: 40 }))
      .toBe('metadata-only');
    expect(isGamingDocumentOverviewOnly(`${heading} ${description}`, { title: heading, headings: heading }, game)).toBe(true);
    expect(classifyGamingDocumentQuality({ cleanedText: `${heading} ${description}`, metadata: { title: heading, headings: heading },
      game, truncated: false, minUsefulTextChars: 40 })).toBe('metadata-only');
  });

  it.each(fixtures)('does not regain stored coverage or full CLEAR from a $game topic heading', ({ game, topic, heading }) => {
    const input = { game, mode: 'guide' as const, prompt: `What is the ${topic} location in ${game}?` };
    for (const title of [heading, undefined]) {
      const selected = knowledge(game, `${heading} ${body(topic)}`, title);
      expect(assessGamingRequestCoverage(input, selected).coverageSatisfied).toBe(false);
      const assessment = assessGamingClearEvidence(input, selected, { identityVerified: true });
      expect(assessment.gates.claimSupport).toBe('unknown');
      expect(assessment.decision).not.toBe('accept');
    }
  });

  it.each(fixtures)('keeps $game topic labels descriptive across closed guide forms', ({ game, topic }) => {
    for (const suffix of ['guide', 'location guide', 'acquisition guide', 'location walkthrough']) {
      const heading = `${game} ${topic} ${suffix}`;
      expect(isGamingDocumentOverviewOnly(`${heading} ${body(topic)}`, { title: heading, headings: heading }, game)).toBe(true);
      expect(isGamingDocumentOverviewOnly(`${heading} ${body(topic)}`, undefined, game)).toBe(true);
    }
  });

  it.each(fixtures.filter(fixture => fixture.game !== 'Fallout 76'))('rejects an actually acquired $game overview before transient admission', async ({ game, topic, heading }) => {
    // Repetition crosses the existing 120-character prose floor without adding a fact.
    const description = `In the game ${game}, ${body(topic).charAt(0).toLowerCase()}${body(topic).slice(1)}`;
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data:
      `<html><title>${heading}</title><main><h1>${heading}</h1><p>${description}</p><p>${body(topic)}</p></main></html>` });
    const document = await resolveGamingDocument(url);
    expect(document.text.length).toBeGreaterThan(120);
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game,
      truncated: false, minUsefulTextChars: 120 })).toBe('metadata-only');
    const result = await evaluateGamingHybridCandidates({ game, mode: 'guide', protocolVersion: 'gaming-hybrid-v2',
      prompt: `What is the ${topic} location in ${game}?`, candidates: [{ url }] }, { actorKey: 'nominal-overview-reader' });
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ decision: 'rejected', reasonCodes: ['INSUFFICIENT_EXTRACTION'] });
    expect(result.knowledge.evidence ?? []).toEqual([]);
  });

  it.each([
    'Elden Ring Uchigatana is in Deathtouched Catacombs',
    'Elden Ring Uchigatana nestles beneath the northern stairs',
    'Elden Ring Uchigatana gleams beside the blue lantern',
    'Elden Ring Uchigatana nestles beneath the northern stairs location guide',
    'Elden Ring Uchigatana deflects projectiles guide',
    'Elden Ring Uchigatana costs 25 coins location guide'
  ])('preserves an acquired heading containing a material or unfamiliar predicate: %s', heading => {
    const text = `${heading} ${body('Uchigatana')}`;
    expect(isGamingDocumentOverviewOnly(text, { title: heading, headings: heading }, 'Elden Ring')).toBe(false);
    expect(isGamingDocumentOverviewOnly(text, undefined, 'Elden Ring')).toBe(false);
    expect(classifyGamingDocumentQuality({ cleanedText: text, metadata: { title: heading, headings: heading }, game: 'Elden Ring',
      truncated: false, minUsefulTextChars: 40 })).toBe('complete');
  });

  it.each(['Uchigatana deflects projectiles', 'Uchigatana nestles beneath the northern stairs',
    'Uchigatana beneath altar', 'Uchigatana above altar', 'Uchigatana below altar'])(
    'preserves a material heading repeated by a templated description: %s', topic => {
      const heading = `Elden Ring ${topic} guide`;
      const text = `${heading} ${body(topic)}`;
      for (const metadata of [{ title: heading, headings: heading }, undefined]) {
        expect(isGamingDocumentOverviewOnly(text, metadata, 'Elden Ring')).toBe(false);
        expect(classifyGamingDocumentQuality({ cleanedText: text, metadata, game: 'Elden Ring',
          truncated: false, minUsefulTextChars: 40 })).toBe('complete');
      }
    });

  it('keeps actually acquired repeated nominal H1/H2 labels insufficient for stored coverage and full CLEAR', async () => {
    const { game, topic, heading } = fixtures[0];
    const secondary = `${topic} location guide`;
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data:
      `<html><title>${heading}</title><article><h1>${heading}</h1><h2>${secondary}</h2>`
      + `<p>In the game ${game}, this article explains how to acquire the ${topic}.</p><p>${body(topic)}</p></article></html>` });
    const document = await resolveGamingDocument(url);
    expect(document.metadata.headings).toBe(`${heading} | ${secondary}`);
    expect(isGamingDocumentOverviewOnly(document.text, document.metadata, game)).toBe(true);
    const selected = knowledge(game, document.text, heading);
    const input = { game, mode: 'guide' as const, prompt: `What is the ${topic} location?` };
    expect(assessGamingRequestCoverage(input, selected).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, selected, { identityVerified: true }).gates.claimSupport).toBe('unknown');
  });

  it('preserves an actual location fact following the nominal heading and overview', () => {
    const { game, topic, heading } = fixtures[0];
    const text = `${heading} ${body(topic)} The Uchigatana location is beneath the northern stairs in the practice catacombs.`;
    expect(isGamingDocumentOverviewOnly(text, { title: heading, headings: heading }, game)).toBe(false);
    const input = { game, mode: 'guide' as const, prompt: 'What is the Uchigatana location?' };
    expect(assessGamingRequestCoverage(input, knowledge(game, text)).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(input, knowledge(game, text), { identityVerified: true }).gates.claimSupport).toBe('verified');
  });
});
