export type CognitiveDomain =
  | 'diagnostic'
  | 'code'
  | 'creative'
  | 'natural'
  | 'execution';

export interface CognitiveState {
  cognitiveDomain: CognitiveDomain;
  domainConfidence: number; // 0–1
}
