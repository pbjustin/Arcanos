export interface DirectAnswerModeInstructionOptions {
  moduleLabel: string;
  domainGuidance: string;
  prohibitedBehaviors: string[];
  missingInfoBehavior?: string;
}

const DIRECT_ANSWER_MODE_PATTERN =
  /\b(?:answer|respond|reply|say)\s+directly\b|\bjust\s+answer\b|\b(?:do\s+not|don't|no|without)\s+(?:simulate|simulation|role-?play|pretend)\b|\bno\s+hypothetical(?:\s+runs?)?\b|\bhypothetical\s+run\b/i;

/**
 * Detect when a prompt explicitly asks for a direct, non-simulated answer.
 * Inputs/outputs: prompt-like text -> boolean direct-answer preference.
 * Edge cases: blank and non-string prompts always resolve to false.
 */
export function shouldPreferDirectAnswerMode(prompt: string | null | undefined): boolean {
  const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';

  //audit Assumption: direct-answer mode should only activate on explicit user cues; failure risk: ordinary domain prompts lose their intended persona/style; expected invariant: blank or implicit prompts keep normal module behavior; handling strategy: require a non-empty prompt before regex evaluation.
  if (!normalizedPrompt) {
    return false;
  }

  return DIRECT_ANSWER_MODE_PATTERN.test(normalizedPrompt);
}

/**
 * Build a strict system instruction for module flows that must answer directly.
 * Inputs: module label, domain guidance, and prohibited behaviors.
 * Output: stable system prompt string for direct-answer execution mode.
 * Edge cases: falls back to a generic missing-info instruction when none is supplied.
 */
export function buildDirectAnswerModeSystemInstruction(
  options: DirectAnswerModeInstructionOptions
): string {
  const prohibitedBehaviors = options.prohibitedBehaviors
    .map((behavior) => behavior.trim())
    .filter((behavior) => behavior.length > 0);
  const prohibitedClause = prohibitedBehaviors.length > 0
    ? `Do not ${prohibitedBehaviors.join(', ')}.`
    : 'Do not simulate or role-play.';
  const missingInfoBehavior =
    options.missingInfoBehavior?.trim() ||
    'If required information is missing, say what is missing briefly instead of inventing context.';

  return [
    `You are ${options.moduleLabel}.`,
    options.domainGuidance.trim(),
    'Answer the request directly and concretely.',
    prohibitedClause,
    'If the user requests an exact literal response, return only that literal.',
    missingInfoBehavior
  ].join(' ');
}
