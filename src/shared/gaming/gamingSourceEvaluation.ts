/** Internal diagnostic contract; never grants acquisition, generation, or storage authority. */
import { GAMING_GAME_REGISTRY } from './gamingGameRegistry.js';
export const GAMING_SOURCE_EVALUATION_VERSION = 'gaming-source-evaluation/v1';
export const GAMING_SOURCE_EVALUATION_RULE_VERSION = 'gaming-source-evaluation-rules/v1';
export const GAMING_SOURCE_EVALUATION_STAGES = ['acquisition', 'extraction', 'identity', 'applicability',
  'relevance', 'freshness', 'provenance', 'selection', 'generation'] as const;
export type GamingSourceEvaluationStage = typeof GAMING_SOURCE_EVALUATION_STAGES[number];
export type GamingSourceEvaluationStatus = 'passed' | 'rejected' | 'unknown' | 'not_run' | 'not_applicable';

const REJECTION_STAGES = {
  UNTRUSTED_METADATA_INVALID: 'acquisition', INVALID_URL: 'acquisition', URL_BLOCKED: 'acquisition',
  UNSUPPORTED_SOURCE_FORMAT: 'acquisition', DUPLICATE_URL: 'acquisition', FETCH_BUDGET_EXHAUSTED: 'acquisition',
  SOURCE_TIMEOUT: 'acquisition', SOURCE_INACCESSIBLE: 'acquisition', REDIRECT_NOT_ALLOWED: 'acquisition',
  SOURCE_FETCH_FAILED: 'acquisition', SOURCE_RESPONSE_TOO_LARGE: 'acquisition', SOURCE_TOO_LARGE: 'acquisition',
  RESOLVED_SOURCE_IDENTITY_MISMATCH: 'acquisition', SOURCE_INSTRUCTIONS_REJECTED: 'extraction',
  INSUFFICIENT_EXTRACTION: 'extraction', SOURCE_INTEGRITY_REJECTED: 'extraction', SOURCE_EXTRACTION_FAILED: 'extraction',
  GAME_MISMATCH: 'identity', GAME_IDENTITY_UNVERIFIED: 'identity',
  EDITION_CONFLICT: 'applicability', EDITION_UNVERIFIED: 'applicability', EDITION_REQUIRED: 'applicability',
  PLATFORM_MISMATCH: 'applicability', PLATFORM_UNVERIFIED: 'applicability',
  REGION_MISMATCH: 'applicability', REGION_UNVERIFIED: 'applicability',
  CONTRADICTORY_SOURCE_METADATA: 'applicability', CONFLICTING_EDITION_SCOPE: 'applicability',
  QUESTION_COVERAGE_INSUFFICIENT: 'relevance', CONTRADICTORY_STRUCTURAL_RECORDS: 'relevance',
  PATCH_MISMATCH: 'freshness', NOT_YET_EFFECTIVE: 'freshness', NO_LONGER_EFFECTIVE: 'freshness',
  REQUIRED_FRESHNESS_UNVERIFIED: 'freshness', SOURCE_USE_RESTRICTED: 'provenance',
  REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED: 'provenance',
  GAMING_CLEAR_SOURCE_REJECTED: 'selection', SOURCE_VALIDATION_REJECTED: 'selection',
  REQUEST_CANCELLED: 'selection', EVIDENCE_SELECTION_FAILED: 'selection'
} as const satisfies Record<string, GamingSourceEvaluationStage>;
const STAGE_CODES = new Set(['STAGE_NOT_RUN', 'SOURCE_ACQUIRED', 'EXTRACTION_INTACT', 'EXTRACTION_PARTIAL', 'EXTRACTION_UNVERIFIED',
  'ACQUIRED_IDENTITY_VERIFIED', 'APPLICABILITY_EVALUATED', 'GAMEPLAY_CONTRIBUTION_VERIFIED',
  'FRESHNESS_VERIFIED', 'FRESHNESS_UNVERIFIED', 'FRESHNESS_NOT_APPLICABLE', 'PROVENANCE_ACQUIRED',
  'EVIDENCE_SELECTED', 'EVIDENCE_NOT_SELECTED', 'GENERATION_NOT_EVALUATED', ...Object.keys(REJECTION_STAGES)]);

export interface GamingSourceEvaluationDiagnostic {
  httpStatus?: number;
  extractedChars?: number;
  completeRecords?: number;
  partialRecords?: number;
  ambiguousRecords?: number;
  excludedRecords?: number;
  excludedReferences?: number;
  selectedRecords?: number;
  truncated?: boolean;
  identityRuleId?: string;
  identityCategory?: string;
  authority?: 'official' | 'reviewed_secondary' | 'unknown';
  contentHash?: string;
}
export interface GamingSourceEvaluation {
  contractVersion: typeof GAMING_SOURCE_EVALUATION_VERSION;
  ruleVersion: typeof GAMING_SOURCE_EVALUATION_RULE_VERSION;
  registryVersion: string;
  registryRevision: string;
  requestId?: string;
  traceId?: string;
  workflowId?: string;
  candidateReference?: string;
  submittedIndex: number;
  stages: Record<GamingSourceEvaluationStage, { status: GamingSourceEvaluationStatus; reasonCode: string;
    diagnostic: GamingSourceEvaluationDiagnostic }>;
  outcome: 'accepted' | 'selected' | 'rejected' | 'interrupted';
  rejectionReasons: string[];
  /** Replacement eligibility only. The workflow's existing grants and budgets remain authoritative. */
  recovery: { eligible: boolean; reasonCode: 'REPLACEMENT_CANDIDATE_ELIGIBLE' | 'CANDIDATE_RECOVERY_DENIED' | 'RECOVERY_NOT_REQUIRED' };
}
const correlation = (value?: string): string | undefined => value && /^(?:(?:req|trace)_\d{1,16}_[a-z0-9]{1,32}|[a-f0-9]{16,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(value)
  ? value : undefined;
const diagnosticNumbers = ['httpStatus', 'extractedChars', 'completeRecords', 'partialRecords', 'ambiguousRecords', 'excludedRecords', 'excludedReferences', 'selectedRecords'] as const;
function safeDiagnostic(value: GamingSourceEvaluationDiagnostic): GamingSourceEvaluationDiagnostic {
  const result: GamingSourceEvaluationDiagnostic = {};
  for (const key of diagnosticNumbers) {
    const item = value[key];
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= (key === 'httpStatus' ? 599 : 1_000_000_000)) result[key] = item;
  }
  if (typeof value.truncated === 'boolean') result.truncated = value.truncated;
  if (/^gaming\.identity\.[a-z_]{1,80}$/u.test(value.identityRuleId ?? '')) result.identityRuleId = value.identityRuleId;
  if (['structured_field', 'prose_metadata', 'document_title', 'body_heading', 'body_scope', 'edition_scope', 'acquired_anchors'].includes(value.identityCategory ?? '')) result.identityCategory = value.identityCategory;
  if (['official', 'reviewed_secondary', 'unknown'].includes(value.authority ?? '')) result.authority = value.authority;
  if (/^[a-f0-9]{64}$/u.test(value.contentHash ?? '')) result.contentHash = value.contentHash;
  return result;
}
export function createGamingSourceEvaluation(input: { submittedIndex: number; requestId?: string; traceId?: string;
  workflowId?: string; candidateReference?: string }): GamingSourceEvaluation {
  return { contractVersion: GAMING_SOURCE_EVALUATION_VERSION, ruleVersion: GAMING_SOURCE_EVALUATION_RULE_VERSION,
    registryVersion: GAMING_GAME_REGISTRY.version, registryRevision: GAMING_GAME_REGISTRY.revision,
    requestId: correlation(input.requestId), traceId: correlation(input.traceId), workflowId: correlation(input.workflowId),
    candidateReference: correlation(input.candidateReference), submittedIndex: Math.max(0, Math.min(2, Math.floor(input.submittedIndex))),
    stages: Object.fromEntries(GAMING_SOURCE_EVALUATION_STAGES.map(stage => [stage, {
      status: 'not_run', reasonCode: 'STAGE_NOT_RUN', diagnostic: {} }])) as GamingSourceEvaluation['stages'],
    outcome: 'accepted', rejectionReasons: [], recovery: { eligible: false, reasonCode: 'RECOVERY_NOT_REQUIRED' } };
}
export function updateGamingSourceEvaluation(trace: GamingSourceEvaluation, stage: GamingSourceEvaluationStage,
  status: GamingSourceEvaluationStatus, reasonCode: string, diagnostic: GamingSourceEvaluationDiagnostic = {}): void {
  if (trace.outcome === 'rejected' || trace.outcome === 'interrupted' || trace.stages[stage].status === 'rejected') return;
  trace.stages[stage] = { status, reasonCode: STAGE_CODES.has(reasonCode) ? reasonCode : 'STAGE_NOT_RUN', diagnostic: safeDiagnostic(diagnostic) };
  if (stage === 'selection' && status === 'passed') trace.outcome = 'selected';
}
export function rejectGamingSourceEvaluation(trace: GamingSourceEvaluation, reason: string,
  diagnostic: GamingSourceEvaluationDiagnostic = {}): void {
  if (trace.outcome === 'rejected' || trace.outcome === 'interrupted') return;
  const code = Object.hasOwn(REJECTION_STAGES, reason) ? reason as keyof typeof REJECTION_STAGES : 'SOURCE_VALIDATION_REJECTED';
  // Cancellation is a workflow interruption, not proof that an acquired source failed.
  // Preserve completed and unfinished stages for accurate parser/acquisition diagnostics.
  if (code === 'REQUEST_CANCELLED') {
    trace.outcome = 'interrupted';
    trace.rejectionReasons = [code];
    trace.recovery = { eligible: false, reasonCode: 'CANDIDATE_RECOVERY_DENIED' };
    return;
  }
  trace.stages[REJECTION_STAGES[code]] = { status: 'rejected', reasonCode: code, diagnostic: safeDiagnostic(diagnostic) };
  trace.outcome = 'rejected';
  trace.rejectionReasons = [code];
  const denied = ['UNTRUSTED_METADATA_INVALID', 'INVALID_URL', 'URL_BLOCKED', 'RESOLVED_SOURCE_IDENTITY_MISMATCH',
    'SOURCE_INSTRUCTIONS_REJECTED', 'SOURCE_USE_RESTRICTED', 'FETCH_BUDGET_EXHAUSTED', 'DUPLICATE_URL',
    'REQUEST_CANCELLED', 'EVIDENCE_SELECTION_FAILED'].includes(code);
  trace.recovery = { eligible: !denied, reasonCode: denied ? 'CANDIDATE_RECOVERY_DENIED' : 'REPLACEMENT_CANDIDATE_ELIGIBLE' };
}
/** A second closed projection protects logging even if an internal caller passes extra properties. */
export function projectGamingSourceEvaluation(trace: GamingSourceEvaluation): GamingSourceEvaluation {
  const result = createGamingSourceEvaluation(trace);
  result.outcome = trace.outcome;
  result.rejectionReasons = trace.rejectionReasons.filter(reason => Object.hasOwn(REJECTION_STAGES, reason)).slice(0, 8);
  result.recovery = { eligible: trace.recovery.eligible === true, reasonCode: trace.recovery.reasonCode };
  for (const stage of GAMING_SOURCE_EVALUATION_STAGES) {
    const item = trace.stages[stage];
    result.stages[stage] = { status: item.status, reasonCode: STAGE_CODES.has(item.reasonCode) ? item.reasonCode : 'STAGE_NOT_RUN', diagnostic: safeDiagnostic(item.diagnostic) };
  }
  return result;
}
