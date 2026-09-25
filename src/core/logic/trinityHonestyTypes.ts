/**
 * Type-only contracts shared by the Trinity pipeline and honesty controls.
 * Keep this module free of runtime dependencies so both layers can depend on it
 * without recreating a circular dependency.
 */

export type TrinitySourceType = 'tool' | 'user_context' | 'memory' | 'inference' | 'template';
export type TrinityConfidence = 'high' | 'medium' | 'low';
export type TrinityVerificationStatus = 'verified' | 'unverified' | 'inferred' | 'unavailable';
export type TrinityResponseMode = 'answer' | 'partial_refusal' | 'refusal';

export interface TrinityCapabilityFlags {
  canBrowse: boolean;
  canVerifyProvidedData: boolean;
  canVerifyLiveData: boolean;
  canConfirmExternalState: boolean;
  canPersistData: boolean;
  canCallBackend: boolean;
}

export interface TrinityToolBackedCapabilities {
  browse?: boolean;
  verifyProvidedData?: boolean;
  verifyLiveData?: boolean;
  confirmExternalState?: boolean;
  persistData?: boolean;
  callBackend?: boolean;
}

export interface TrinityEvidenceTag {
  claimText: string;
  sourceType: TrinitySourceType;
  confidence: TrinityConfidence;
  verificationStatus: TrinityVerificationStatus;
}

export interface TrinityReasoningHonesty {
  responseMode: TrinityResponseMode;
  achievableSubtasks: string[];
  blockedSubtasks: string[];
  userVisibleCaveats: string[];
  evidenceTags: TrinityEvidenceTag[];
  blockedOrRewrittenClaims?: string[];
}

export interface FinalClaimBlockResult {
  text: string;
  blocked: boolean;
  blockedCategories: Array<'live_verification' | 'current_external_state' | 'backend_action'>;
  /** Internal classification metadata only; never publish candidate text or reasoning. */
  ruleIds: TrinityHonestyRuleId[];
}

export type TrinityHonestyRuleId =
  | 'LIVE_VERIFICATION_MODEL_CLAIM'
  | 'UNSUPPORTED_VERIFICATION_CLAIM'
  | 'CURRENT_EXTERNAL_MODEL_CLAIM'
  | 'CURRENT_EXTERNAL_USER_REQUEST'
  | 'BACKEND_ACTION_CLAIM'
  | 'TUTOR_LOCAL_INSTRUCTION_EXEMPT'
  | 'NO_HONESTY_REWRITE';
