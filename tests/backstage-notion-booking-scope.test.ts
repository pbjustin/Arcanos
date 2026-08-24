import { describe, expect, it } from '@jest/globals';

import {
  classifyBackstageNotionBookingCandidateScope,
  deduplicateBackstageNotionBookingCandidates,
  resolveBackstageNotionBookingScopePlan,
} from '../src/shared/backstage/backstageNotionBookingScope.js';

function candidate(input: {
  pageTitle: string;
  pagePath?: string[];
  headingPath?: string[];
  category?: string;
}) {
  return {
    pageTitle: input.pageTitle,
    pagePath: input.pagePath ?? ['WWE Universe', input.pageTitle],
    headingPath: input.headingPath ?? [],
    category: input.category ?? 'general',
  };
}

describe('Backstage Notion booking scope policy', () => {
  it('derives a closed Raw plan without retaining the prompt', () => {
    const privateMarker = 'PRIVATE-BOOKING-PROMPT';
    const plan = resolveBackstageNotionBookingScopePlan(
      `Book Monday Night Raw next week. ${privateMarker}`
    );

    expect(plan).toEqual({
      strategy: 'brand',
      detectedBrands: ['raw'],
      allowedBrands: ['raw'],
      explicitCrossBrand: false,
      fallbackReason: null,
    });
    expect(JSON.stringify(plan)).not.toContain(privateMarker);
  });

  it('prioritizes Raw hierarchy, retains neutral continuity, and excludes other brands', () => {
    const plan = resolveBackstageNotionBookingScopePlan('Book Raw next week.');

    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({
        pageTitle: 'World Heavyweight Championship',
        pagePath: ['WWE Universe', 'Raw', 'Championships'],
        category: 'championships',
      })
    ).disposition).toBe('preferred');
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({ pageTitle: 'Shared roster', category: 'roster' })
    ).disposition).toBe('neutral');
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({ pageTitle: 'SmackDown continuity', category: 'smackdown' })
    ).disposition).toBe('excluded');
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({ pageTitle: 'NXT continuity', category: 'nxt' })
    ).disposition).toBe('excluded');
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({
        pageTitle: 'Weekly continuity',
        pagePath: ['WWE Universe', 'Weekly continuity'],
        category: 'smackdown',
      })
    ).disposition).toBe('excluded');
  });

  it('admits only explicitly named brands in a cross-brand booking', () => {
    const plan = resolveBackstageNotionBookingScopePlan(
      'Book a Raw vs SmackDown cross-brand storyline.'
    );

    expect(plan).toMatchObject({
      strategy: 'cross_brand',
      detectedBrands: ['raw', 'smackdown'],
      allowedBrands: ['raw', 'smackdown'],
      explicitCrossBrand: true,
    });
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({ pageTitle: 'Raw weekly show' })
    ).disposition).toBe('preferred');
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({ pageTitle: 'SmackDown weekly show' })
    ).disposition).toBe('preferred');
    expect(classifyBackstageNotionBookingCandidateScope(
      plan,
      candidate({ pageTitle: 'NXT weekly show' })
    ).disposition).toBe('excluded');
  });

  it('opens the bounded brand union only for an explicit unspecified cross-brand request', () => {
    expect(resolveBackstageNotionBookingScopePlan(
      'Create a cross-brand event around the Raw champion.'
    )).toMatchObject({
      strategy: 'cross_brand',
      detectedBrands: ['raw'],
      allowedBrands: ['raw', 'smackdown', 'nxt'],
      explicitCrossBrand: true,
    });
  });

  it('uses the documented all-context fallback for an underspecified show', () => {
    const plan = resolveBackstageNotionBookingScopePlan(
      'Book next week using the active storylines.'
    );

    expect(plan).toEqual({
      strategy: 'fallback_all',
      detectedBrands: [],
      allowedBrands: [],
      explicitCrossBrand: false,
      fallbackReason: 'underspecified_query',
    });
  });

  it('does not treat generic raw output or a brand split as cross-brand scope', () => {
    expect(resolveBackstageNotionBookingScopePlan(
      'Preserve the raw output while planning the brand split.'
    )).toEqual({
      strategy: 'fallback_all',
      detectedBrands: [],
      allowedBrands: [],
      explicitCrossBrand: false,
      fallbackReason: 'underspecified_query',
    });
  });

  it('keeps the highest-ranked representative for duplicate content hashes', () => {
    const ranked = [
      { id: 'high', chunk: { contentHash: 'same' } },
      { id: 'unique', chunk: { contentHash: 'unique' } },
      { id: 'low', chunk: { contentHash: 'same' } },
    ];

    expect(deduplicateBackstageNotionBookingCandidates(ranked)).toEqual({
      candidates: ranked.slice(0, 2),
      duplicatesRemoved: 1,
    });
  });
});
