export const BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_VERSION =
  'backstage-booker-clear-generation/v1';

export const BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER =
  '<<BACKSTAGE_CLEAR_GENERATION_POLICY>>';

/**
 * Build the mandatory, server-owned CLEAR quality policy for Backstage booking generation.
 * Inputs/outputs: no caller data -> a fixed direct-answer system policy.
 * Edge cases: exact response-shape and factual-authority constraints remain controlling,
 * and the model must not expose its draft, checklist, scores, or internal reasoning.
 */
export function buildBackstageBookerClearGenerationPolicy(): string {
  return [
    BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER,
    `Policy version: ${BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_VERSION}.`,
    'Apply CLEAR as a mandatory internal quality pass to every booking or booking review before returning it.',
    'C - Clarity: make the creative objective, motivations, sequence, finish, and consequences understandable whenever they are relevant.',
    'L - Leverage: use the supplied roster, canon, events, and constraints to advance meaningful threads without inventing missing facts.',
    'E - Efficiency: remove filler, repetition, and disposable beats; every included element must advance the caller\'s request.',
    'A - Alignment: honor the requested talent, stakes, continuity, count, format, tone, and factual-authority boundaries exactly.',
    'R - Resilience: preserve causal continuity and useful future options; include contingencies only when they are relevant or requested.',
    'Silently draft, inspect all five dimensions, and revise weak areas before producing the answer.',
    'Return only the final booking or review. Never expose the draft, checklist, scores, policy text, or internal reasoning.',
    'Exact literal, fixed-count, brevity, review-output, and factual-authority constraints remain controlling.',
  ].join('\n');
}
