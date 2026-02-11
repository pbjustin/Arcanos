export type CognitiveDomain =
  | 'diagnostic'
  | 'code'
  | 'creative'
  | 'natural'
  | 'execution';

/**
 * CognitiveState groups domain classification metadata.
 * Currently unused - StoredIntent and IntentPatch use the fields directly.
 * Retained for potential future refactoring to consolidate domain state.
 */
export interface CognitiveState {
  cognitiveDomain: CognitiveDomain;
  domainConfidence: number; // 0–1
}
