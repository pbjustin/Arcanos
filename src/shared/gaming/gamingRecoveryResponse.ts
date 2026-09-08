import { redactString } from '@shared/redaction.js';
import { assessGamingProgressionRequest, type GamingProgressionInput } from './gamingProgressionPolicy.js';

export type GamingRecoveryClass = 'clarification_required' | 'source_unavailable'
  | 'provider_timeout_with_evidence' | 'provider_timeout_without_evidence' | 'generation_unavailable';

export interface GamingRecoveryInput extends GamingProgressionInput {
  mode: 'guide' | 'build' | 'meta';
  sourceKnown?: boolean;
  evidenceSelected: boolean;
  timedOut?: boolean;
}

export function resolveGamingRecoveryClass(input: GamingRecoveryInput): GamingRecoveryClass {
  if (input.mode === 'guide' && assessGamingProgressionRequest(input).clarificationNeeded) return 'clarification_required';
  if (input.timedOut) return input.evidenceSelected ? 'provider_timeout_with_evidence' : 'provider_timeout_without_evidence';
  return input.evidenceSelected ? 'generation_unavailable' : 'source_unavailable';
}

function safeGameLabel(game?: string): string {
  const label = game?.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff<>[\]{}*_`\\]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, 120);
  return label && redactString(label) === label && !/https?:\/\/|\b\S+@\S+\.\S+\b/iu.test(label) ? label : 'this game';
}

/** Diagnostics stay on the envelope/logs; recovery text never invents gameplay actions. */
export function buildGamingRecoveryResponse(input: GamingRecoveryInput): string {
  const recoveryClass = resolveGamingRecoveryClass(input);
  const game = safeGameLabel(input.game);
  if (recoveryClass === 'clarification_required') {
    const opening = input.sourceKnown
      ? `I have a guide available for ${game}, but I need your current progress point to find the right next step without spoiling later sections.`
      : `To help with your next step in ${game}, I need your current progress point.`;
    const question = input.currentArea || input.contextConflicts?.length
      ? 'What was the last objective you completed?'
      : input.lastCompletedObjective || input.progressPoint
        ? 'What area or world are you in now?'
        : 'Where are you now — for example, your current area or world?';
    return `${opening}\n\n${question}`;
  }
  if (recoveryClass === 'provider_timeout_with_evidence') {
    return 'I found the relevant guide material, but the answer-generation step timed out. Ask me again and I can retry from the same gameplay point.';
  }
  if (recoveryClass === 'provider_timeout_without_evidence') {
    return `I couldn't complete your request about ${game} reliably before it timed out. Please try again with a specific boss, item, location, or objective.`;
  }
  if (recoveryClass === 'generation_unavailable') {
    return 'I found relevant guide material, but I couldn’t complete a reliable answer. Ask me again and I can retry from the same gameplay point.';
  }
  return `I couldn't locate enough guide information to answer your question about ${game} reliably. Try a specific boss, item, location, or objective, or share a guide URL.`;
}
