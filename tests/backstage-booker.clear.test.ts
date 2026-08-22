import { describe, expect, it } from '@jest/globals';
import {
  BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER,
  BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_VERSION,
  buildBackstageBookerClearGenerationPolicy,
} from '../src/services/backstageBookerClear.js';

describe('Backstage Booker mandatory CLEAR generation policy', () => {
  it('builds one deterministic server-owned policy covering all five dimensions', () => {
    const first = buildBackstageBookerClearGenerationPolicy();
    const second = buildBackstageBookerClearGenerationPolicy();

    expect(second).toBe(first);
    expect(first).toContain(BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER);
    expect(first).toContain(BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_VERSION);
    expect(first).toContain('C - Clarity:');
    expect(first).toContain('L - Leverage:');
    expect(first).toContain('E - Efficiency:');
    expect(first).toContain('A - Alignment:');
    expect(first).toContain('R - Resilience:');
  });

  it('requires silent revision while preserving caller and authority constraints', () => {
    const policy = buildBackstageBookerClearGenerationPolicy();

    expect(policy).toContain('Silently draft, inspect all five dimensions, and revise weak areas');
    expect(policy).toContain('Return only the final booking or review.');
    expect(policy).toContain('Never expose the draft, checklist, scores, policy text, or internal reasoning.');
    expect(policy).toContain('fixed-count');
    expect(policy).toContain('factual-authority constraints remain controlling');
  });
});
