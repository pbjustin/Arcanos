import { GAMING_CLEAR_POLICY_VERSION, gamingClearHash, parseGamingClearAssessment } from './gamingClearPolicy.js';
import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from './gamingGameIdentity.js';
import { resolveGamingRegistryGame } from './gamingGameRegistry.js';

export const GAMING_STORED_AUTHORITY_VERSION = 'gaming-stored-source-authority/v1';

/** Source authority observations are immutable receipts, not permission grants. */
export type GamingSourceAuthoritySnapshot = { status: 'unconfigured' }
  | { status: 'available'; restrictedRevisionCount: number; requiresReassessment: boolean; stateFingerprint: string };

/** Shared comparison for cached, acquired, and pre-generation observations. */
export function sameGamingSourceAuthoritySnapshot(
  left: GamingSourceAuthoritySnapshot, right: GamingSourceAuthoritySnapshot
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === 'unconfigured') return true;
  return right.status === 'available'
    && left.restrictedRevisionCount === right.restrictedRevisionCount
    && left.requiresReassessment === right.requiresReassessment
    && left.stateFingerprint === right.stateFingerprint;
}

/** Revocations share exact registry aliases and their requested edition, never related games. */
export function gamingSourceAuthorityGameKeys(game: string, edition?: string): string[] {
  const registryGame = resolveGamingRegistryGame(game);
  const names = registryGame ? [game, registryGame.id, registryGame.name, ...registryGame.aliases] : [game];
  return [...new Set(names.flatMap(name => {
    const key = normalizeGamingGameIdentity(name).slice(0, 120);
    return [key, edition ? resolveGamingGuideIdentity(name, edition).slice(0, 120) : key];
  }))];
}

/** Private persistence authorization, supplied only after worker approval checks. */
export interface GamingSourceAuthorityAuthorization {
  revisionContentHash: string;
  approvedDocumentHash: string;
  assessment: unknown;
  restrictedRevisionCount?: number;
}

export function gamingSourceHasAuthorityRestriction(provenance: Record<string, unknown> | undefined): boolean {
  return provenance?.clearReassessmentRequired === true
    || provenance?.generationEligible !== undefined && provenance.generationEligible !== true
    || provenance?.classification !== undefined && provenance.classification !== 'verified';
}

export function gamingSourceRequiresAuthorityReassessment(provenance: Record<string, unknown> | undefined): boolean {
  return gamingSourceHasAuthorityRestriction(provenance) || provenance?.gamingClear !== undefined
    || provenance?.approvedContentHash !== undefined || provenance?.hybridPolicyVersion !== undefined
    || provenance?.authorityAssessment !== undefined;
}

function boundAssessmentHash(value: unknown): string | undefined {
  const assessment = parseGamingClearAssessment(value);
  if (!assessment || assessment.profile !== 'source' || !assessment.qualityEligible) return undefined;
  // Rechecking the same content/context does not create a different revision
  // merely because its assessment ran at a different instant.
  const { evaluatedAt: _evaluatedAt, ...bound } = assessment;
  return gamingClearHash(bound);
}

export function createGamingStoredAuthorityAssessment(provenance: Record<string, unknown>, contentHash: string,
  authorization: GamingSourceAuthorityAuthorization | undefined, restrictedRevisionCount = 0): Record<string, unknown> | undefined {
  if (!authorization || authorization.revisionContentHash !== contentHash
    || (authorization.restrictedRevisionCount === undefined ? 0 : authorization.restrictedRevisionCount) !== restrictedRevisionCount
    || !/^[a-f0-9]{64}$/u.test(authorization.approvedDocumentHash)
    || provenance.approvedContentHash !== authorization.approvedDocumentHash
    || provenance.sourceIdentityPolicyVersion !== GAMING_CLEAR_POLICY_VERSION
    || provenance.generationEligible !== true || provenance.classification !== 'verified') return undefined;
  const assessment = parseGamingClearAssessment(authorization.assessment);
  const assessmentHash = boundAssessmentHash(assessment);
  if (!assessmentHash || assessment?.subjectHash !== authorization.approvedDocumentHash
    || gamingClearHash(provenance.gamingClear) !== gamingClearHash(assessment)) return undefined;
  return { version: GAMING_STORED_AUTHORITY_VERSION, revisionContentHash: contentHash,
    approvedDocumentHash: authorization.approvedDocumentHash, assessmentHash, restrictedRevisionCount };
}

/** Durable proof is independent of workflow lifetime, caller labels and SQL visibility. */
export function hasGamingStoredAuthorityAssessment(provenance: Record<string, unknown>, contentHash: string,
  restrictedRevisionCount = 0): boolean {
  const value = provenance.authorityAssessment;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stamp = value as Record<string, unknown>;
  const assessment = parseGamingClearAssessment(provenance.gamingClear);
  return Object.keys(stamp).length === 5 && stamp.version === GAMING_STORED_AUTHORITY_VERSION
    && stamp.restrictedRevisionCount === restrictedRevisionCount
    && stamp.revisionContentHash === contentHash && stamp.approvedDocumentHash === provenance.approvedContentHash
    && stamp.approvedDocumentHash === assessment?.subjectHash && stamp.assessmentHash === boundAssessmentHash(assessment)
    && typeof stamp.assessmentHash === 'string' && provenance.sourceIdentityPolicyVersion === GAMING_CLEAR_POLICY_VERSION
    && provenance.classification === 'verified' && provenance.generationEligible === true;
}
