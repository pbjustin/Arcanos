import { gamingClearHash } from './gamingClearPolicy.js';
import { GAMING_CLEAR_PRESENTATION_POLICY_VERSION } from './gamingPromptCore.js';

/** Server-only candidate for substance checks before appended caveats. */
export const GAMING_PRE_LIMITATION_CANDIDATE = Symbol('gaming-pre-limitation-candidate');

/** Server-only proof of output integrity and evidence binding after presentation generation. */
export const GAMING_PRESENTED_ANSWER = Symbol('gaming.presented-answer/v1');
export interface GamingPresentedAnswer {
  policyVersion: typeof GAMING_CLEAR_PRESENTATION_POLICY_VERSION;
  subjectHash: string;
  contextFingerprint: string;
  evidenceSubjectHash: string;
}
export type GamingPresentedAnswerCarrier = { [GAMING_PRESENTED_ANSWER]?: GamingPresentedAnswer };
export function hasBoundGamingPresentedAnswer(data: GamingPresentedAnswerCarrier & { response: string }): boolean {
  const binding = data[GAMING_PRESENTED_ANSWER];
  return binding?.policyVersion === GAMING_CLEAR_PRESENTATION_POLICY_VERSION && binding.subjectHash === gamingClearHash(data.response);
}
