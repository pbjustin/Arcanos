export const COGNITIVE_DOMAINS = ['diagnostic', 'code', 'creative', 'natural', 'execution'] as const;
export type CognitiveDomain = typeof COGNITIVE_DOMAINS[number];

export interface CognitiveState {
  cognitiveDomain: CognitiveDomain;
  domainConfidence: number; // 0–1
}
