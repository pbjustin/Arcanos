import { describe, expect, test } from '@jest/globals';
import { GAMING_CLEAR_DIMENSIONS, GAMING_CLEAR_POLICY_VERSION, createGamingClearAssessment,
  type GamingClearDimensions } from '../src/shared/gaming/gamingClearPolicy.js';
import { createGamingStoredAuthorityAssessment, hasGamingStoredAuthorityAssessment,
  gamingSourceRequiresAuthorityReassessment } from '../src/shared/gaming/gamingSourceAuthority.js';

function fixture() {
  const revisionContentHash = 'a'.repeat(64);
  const approvedDocumentHash = 'b'.repeat(64);
  const assessment = createGamingClearAssessment({ profile: 'source', questionProfile: 'walkthrough',
    sourceRole: 'gameplay_guide', subjectId: 'synthetic-authority-source', subjectHash: approvedDocumentHash,
    contextFingerprint: 'c'.repeat(64), evidenceRefs: ['synthetic-source'],
    gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'not_applicable',
      provenance: 'verified', security: 'verified' },
    dimensions: Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, { status: 'evaluated', score: 4,
      reasonCodes: ['SYNTHETIC_SUPPORT'], evidenceRefs: ['synthetic-source'], unresolvedFacts: [] }])) as GamingClearDimensions,
    evaluatedAt: '2026-11-07T12:00:02.000Z' });
  const provenance = { classification: 'verified', generationEligible: true,
    sourceIdentityPolicyVersion: GAMING_CLEAR_POLICY_VERSION, approvedContentHash: approvedDocumentHash, gamingClear: assessment };
  const authorization = { revisionContentHash, approvedDocumentHash, assessment };
  return { revisionContentHash, approvedDocumentHash, assessment, provenance, authorization };
}

describe('durable Gaming source reassessment authority', () => {
  test.each([{ classification: 'stored_unverified' }, { classification: 'reference_only' },
    { classification: 'needs_reassessment' }, { generationEligible: false }, { generationEligible: null },
    { classification: null }, { clearReassessmentRequired: true }, { gamingClear: {} }])(
    'recognizes historical restriction %p independently of source labels', provenance => {
      expect(gamingSourceRequiresAuthorityReassessment(provenance)).toBe(true);
    });

  test('requires separate current assessment authorization and exact revision/document binding', () => {
    const f = fixture();
    expect(createGamingStoredAuthorityAssessment(f.provenance, f.revisionContentHash, undefined)).toBeUndefined();
    for (const authorization of [{ ...f.authorization, revisionContentHash: 'd'.repeat(64) },
      { ...f.authorization, approvedDocumentHash: 'd'.repeat(64) },
      { ...f.authorization, assessment: { ...f.assessment, qualityEligible: false } },
      { ...f.authorization, assessment: { ...f.assessment, policyProfile: 'gaming-clear-policy/v6:walkthrough:source' } }]) {
      expect(createGamingStoredAuthorityAssessment(f.provenance, f.revisionContentHash, authorization)).toBeUndefined();
    }
    const stamp = createGamingStoredAuthorityAssessment(f.provenance, f.revisionContentHash,
      { ...f.authorization, restrictedRevisionCount: 2 }, 2);
    expect(stamp).toBeDefined();
    const saved = { ...f.provenance, authorityAssessment: stamp };
    expect(hasGamingStoredAuthorityAssessment(saved, f.revisionContentHash, 2)).toBe(true);
    expect(hasGamingStoredAuthorityAssessment(saved, 'd'.repeat(64), 2)).toBe(false);
    expect(hasGamingStoredAuthorityAssessment(saved, f.revisionContentHash, 3)).toBe(false);
    expect(hasGamingStoredAuthorityAssessment({ ...saved, authorityAssessment: { ...stamp, extra: true } }, f.revisionContentHash, 2)).toBe(false);
  });

  test('a queued assessment issued before a later retention cannot clear the hold', () => {
    const f = fixture();
    for (const capturedCount of [undefined, 0, 2]) {
      expect(createGamingStoredAuthorityAssessment(f.provenance, f.revisionContentHash,
        { ...f.authorization, restrictedRevisionCount: capturedCount }, 1)).toBeUndefined();
    }
  });
});
