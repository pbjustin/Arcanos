import type { GamingHybridResponse } from './gamingHybridContract.js';
import type { GamingClearAssessment } from './gamingClearPolicy.js';
import { GAMING_STALE_GUIDE_WARNING, GAMING_UNVERIFIED_GUIDE_WARNING,
  gamingAnswerClaimsVerifiedCurrentness } from './gamingFreshnessDisposition.js';

export const LIVE_VALIDATION_STAGES = ['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response'] as const;
export type LiveValidationStage = typeof LIVE_VALIDATION_STAGES[number];
/** Server-owned events contain timing metadata only, never model content. */
export interface LiveValidationStageEvent {
  stage: LiveValidationStage;
  phase: 'started' | 'completed' | 'failed';
  elapsedMs?: number;
  remainingBudgetMs?: number | null;
  requestRemainingMs?: number | null;
  timedOut?: boolean;
}
export interface LiveValidationStageTiming {
  status: 'not_run' | 'started' | 'passed' | 'failed' | 'timed_out';
  elapsedMs: number | null;
}
export interface LiveValidationAudit {
  assessmentStatus: GamingClearAssessment['assessmentStatus'];
  decision: GamingClearAssessment['decision'];
  boundToFinalAnswer: boolean;
}
/** Counts and invariants only; workflow IDs, context replies and evidence text stay private. */
export interface LiveValidationClarification {
  version: 1;
  submittedCount: number;
  completedCount: number;
  postAcquisitionCount: number;
  sameWorkflow: boolean;
  revisionsAdvanced: boolean;
  retainedEvidence: boolean;
  budgetsPreserved: boolean;
  acquisitionCount: number;
}
export interface LiveValidationObservation {
  schemaVersion: 1;
  contractVersion: 'gaming-hybrid-v2';
  outcome: 'accepted' | 'clarification_required' | 'need_new_source' | 'unavailable';
  reason: string | null;
  semanticGap: 'USER_DECISION_GAP' | 'EVIDENCE_GAP' | 'NONCRITICAL_GAP' | 'CONFLICT' | 'NONE' | 'UNOBSERVED';
  coverage: { satisfied: boolean; assessmentStatus: 'assessed' | 'unknown' | 'not_assessed'; missingCount: number };
  selectedCandidateCount: number;
  selectedEvidenceCount: number;
  candidates: Array<{ decision: string; reasonCodes: string[] }>;
  qualification: { patchCompatibility: 'unverified' | 'stale' | 'not_required' | 'verified' | 'unobserved';
    visible: boolean; claimsVerifiedCurrentness: boolean };
  audit: LiveValidationAudit | null;
  clarification?: LiveValidationClarification;
  stages: Record<LiveValidationStage, LiveValidationStageTiming>;
  auditStartBudget: { runtimeRemainingMs: number | null; requestRemainingMs: number | null };
}
const reasonCode = (value: unknown): string | null => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : null;
export const liveValidationDuration = (value: unknown): number | null => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
export function emptyLiveValidationStages(): LiveValidationObservation['stages'] {
  return Object.fromEntries(LIVE_VALIDATION_STAGES.map(stage => [stage, { status: 'not_run', elapsedMs: null }])) as LiveValidationObservation['stages'];
}

function clarificationProjection(value: LiveValidationClarification | undefined): LiveValidationClarification | undefined {
  if (!value || value.version !== 1
    || ![value.submittedCount, value.completedCount, value.postAcquisitionCount].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 8)
    || value.completedCount > value.submittedCount || value.postAcquisitionCount > value.completedCount
    || !Number.isSafeInteger(value.acquisitionCount) || value.acquisitionCount < 0 || value.acquisitionCount > 1
    || ![value.sameWorkflow, value.revisionsAdvanced, value.retainedEvidence, value.budgetsPreserved].every(flag => typeof flag === 'boolean')) return undefined;
  return { version: 1, submittedCount: value.submittedCount, completedCount: value.completedCount,
    postAcquisitionCount: value.postAcquisitionCount, sameWorkflow: value.sameWorkflow,
    revisionsAdvanced: value.revisionsAdvanced, retainedEvidence: value.retainedEvidence,
    budgetsPreserved: value.budgetsPreserved, acquisitionCount: value.acquisitionCount };
}

/** Diagnostic projection of existing policy outcomes; it never grants acceptance or changes CLEAR. */
export function createLiveValidationObservation(input: {
  body?: GamingHybridResponse;
  accepted: boolean;
  audit?: LiveValidationAudit;
  clarification?: LiveValidationClarification;
  stages: LiveValidationObservation['stages'];
  auditStartBudget: LiveValidationObservation['auditStartBudget'];
}): LiveValidationObservation {
  const { body, accepted } = input;
  const response = body?.answer?.response ?? '';
  const qualification = { patchCompatibility: body?.freshnessStatus === 'unverified' ? 'unverified' as const
    : body?.freshnessStatus === 'stale' ? 'stale' as const : body?.freshnessStatus === 'not_applicable' ? 'not_required' as const
      : body?.freshnessStatus === 'current' ? 'verified' as const : 'unobserved' as const,
  visible: response.includes(GAMING_UNVERIFIED_GUIDE_WARNING) || response.includes(GAMING_STALE_GUIDE_WARNING),
  claimsVerifiedCurrentness: gamingAnswerClaimsVerifiedCurrentness(response) };
  const candidates = (body?.candidates ?? []).slice(0, 8).map(candidate => ({
    decision: ['accepted_transient', 'eligible_for_ingestion', 'already_indexed', 'rejected', 'requires_confirmation'].includes(candidate.decision)
      ? candidate.decision : 'unobserved',
    reasonCodes: candidate.reasonCodes.map(reasonCode).filter((value): value is string => value !== null).slice(0, 8)
  }));
  const reason = reasonCode(body?.reason);
  const codes = [reason, ...candidates.flatMap(candidate => candidate.reasonCodes)].filter((value): value is string => value !== null);
  const conflict = body?.freshnessStatus === 'conflicting' || body?.applicabilityStatus === 'conflicting'
    || codes.some(code => /(?:CONFLICT|CONTRADICTORY|MISMATCH)/u.test(code));
  const outcome = accepted ? 'accepted' : body?.state === 'clarification_required' && body.nextAction === 'clarify'
    ? 'clarification_required' : body?.state === 'discovery_required' ? 'need_new_source' : 'unavailable';
  const semanticGap = conflict ? 'CONFLICT' : outcome === 'clarification_required' ? 'USER_DECISION_GAP'
    : accepted && qualification.visible && ['unverified', 'stale'].includes(qualification.patchCompatibility) ? 'NONCRITICAL_GAP'
      : accepted ? 'NONE' : outcome === 'need_new_source' ? 'EVIDENCE_GAP' : 'UNOBSERVED';
  const clarification = clarificationProjection(input.clarification);
  return { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome, reason, semanticGap,
    coverage: { satisfied: body?.coverageSatisfied === true,
      assessmentStatus: body?.gapAssessmentStatus ?? 'not_assessed', missingCount: Math.min(body?.missingCoverage?.length ?? 0, 64) },
    selectedCandidateCount: body?.selectedCandidateIds?.length ?? 0, selectedEvidenceCount: body?.selectedEvidenceIds?.length ?? 0,
    candidates, qualification, audit: input.audit ? { ...input.audit } : null,
    ...(clarification ? { clarification } : {}),
    stages: structuredClone(input.stages), auditStartBudget: { ...input.auditStartBudget } };
}
