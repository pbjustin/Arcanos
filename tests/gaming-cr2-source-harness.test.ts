import { describe, expect, test } from '@jest/globals';
import { GamingResolvedSourceHarness, resolvedSourceId } from './testUtils/gamingResolvedSourceHarness.js';

function fixture(provenance: Record<string, unknown>, count = 1) {
  const db = new GamingResolvedSourceHarness();
  db.source = { id: resolvedSourceId, status: 'active', game_key: 'platinum-lantern', game_name: 'Platinum Lantern' };
  db.revisions = [{ id: 'revision-one', source_id: resolvedSourceId, provenance }];
  db.records = Array.from({ length: count }, (_, index) => ({ id: `record-${index}`, status: 'active',
    source_revision_id: 'revision-one', game_key: 'platinum-lantern', record_type: 'guide', search_text: 'crystal bridge' }));
  return db;
}

describe('Gaming SQL harness matches authority and refill boundaries', () => {
  test.each(['gamingClear', 'approvedContentHash', 'hybridPolicyVersion', 'authorityAssessment'])
    ('marker %s requires durable proof even with zero explicit retention history', async marker => {
      const db = fixture({ [marker]: marker === 'gamingClear' ? {} : 'synthetic' });
      const result = await db.query('WITH search_input AS (SELECT 1)', ['platinum-lantern', 'crystal', 'guide', 20, null]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].source_has_non_authoritative_history).toBe(true);
      expect(result.rows[0].source_restricted_revision_count).toBe('0');
    });
  test('uses the real SQL offset rather than repeating the first held page', async () => {
    const db = fixture({ classification: 'reference_only', generationEligible: false }, 40);
    const first = await db.query('WITH search_input AS (SELECT 1)', ['platinum-lantern', 'crystal', 'guide', 20, null]);
    const next = await db.query('WITH search_input AS (SELECT 1)', ['platinum-lantern', 'crystal', 'guide', 20, null, 20]);
    expect(first.rows.map(row => row.record_id)).toEqual(Array.from({ length: 20 }, (_, index) => `record-${index}`));
    expect(next.rows.map(row => row.record_id)).toEqual(Array.from({ length: 20 }, (_, index) => `record-${index + 20}`));
  });
  test('ordinary independently acquired history remains distinct from hybrid-marker history', async () => {
    const db = fixture({ sourceIdentityPolicyVersion: 'synthetic-policy' });
    const result = await db.query('WITH search_input AS (SELECT 1)', ['platinum-lantern', 'crystal', 'guide', 20, null]);
    expect(result.rows[0].source_has_non_authoritative_history).toBe(false);
  });
});
