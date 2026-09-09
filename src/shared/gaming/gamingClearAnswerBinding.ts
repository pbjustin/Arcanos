import type { GamingClearAssessment } from './gamingClearPolicy.js';
import { gamingClearHash } from './gamingClearPolicy.js';

/** Non-JSON server attestation: scores never become public response fields. */
export const GAMING_CLEAR_APPROVED_ANSWER = Symbol('gaming.clear-approved-answer');
export type GamingClearAnswerCarrier = { [GAMING_CLEAR_APPROVED_ANSWER]?: GamingClearAssessment };
export function hasBoundGamingClearAnswer(data: GamingClearAnswerCarrier & { response: string }): boolean {
  const audit = data[GAMING_CLEAR_APPROVED_ANSWER];
  return audit?.profile === 'answer' && audit.assessmentStatus === 'completed'
    && audit.decision === 'accept' && audit.subjectHash === gamingClearHash(data.response);
}
