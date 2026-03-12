import type { AIRequestDTO } from '@shared/types/dto.js';
import type { TrinityRunOptions } from '@core/logic/trinity.js';

type TrinityOutputOptionSubset = Pick<
  TrinityRunOptions,
  'requestedVerbosity' | 'maxWords' | 'answerMode' | 'debugPipeline' | 'strictUserVisibleOutput'
>;

/**
 * Normalize Trinity output-control request fields from camelCase and snake_case aliases.
 *
 * Purpose:
 * - Keep route handlers and worker code aligned on one canonical Trinity run-options shape.
 *
 * Inputs/outputs:
 * - Input: partial AI request body.
 * - Output: normalized Trinity output-control options.
 *
 * Edge case behavior:
 * - Missing fields are omitted so `runThroughBrain` can still apply prompt-based heuristics.
 */
export function buildTrinityOutputControlOptions(
  requestBody: Partial<AIRequestDTO>
): TrinityOutputOptionSubset {
  const normalizedOptions: TrinityOutputOptionSubset = {};
  const requestRecord = requestBody as Partial<AIRequestDTO> & Record<string, unknown>;

  const requestedVerbosity = requestBody.requestedVerbosity ?? requestRecord.requested_verbosity;
  const maxWords = requestBody.maxWords ?? requestRecord.max_words;
  const answerMode = requestBody.answerMode ?? requestRecord.answer_mode;
  const debugPipeline = requestBody.debugPipeline ?? requestRecord.debug_pipeline;
  const strictUserVisibleOutput =
    requestBody.strictUserVisibleOutput ?? requestRecord.strict_user_visible_output;

  //audit Assumption: request aliases should normalize to one canonical field set before entering Trinity; failure risk: stage contracts diverge by route depending on casing; expected invariant: camelCase and snake_case behave identically; handling strategy: coalesce aliases once here and omit undefined values.
  if (requestedVerbosity === 'minimal' || requestedVerbosity === 'normal' || requestedVerbosity === 'detailed') {
    normalizedOptions.requestedVerbosity = requestedVerbosity;
  }
  if (typeof maxWords === 'number' || maxWords === null) {
    normalizedOptions.maxWords = maxWords;
  }
  if (answerMode === 'direct' || answerMode === 'explained' || answerMode === 'audit' || answerMode === 'debug') {
    normalizedOptions.answerMode = answerMode;
  }
  if (typeof debugPipeline === 'boolean') {
    normalizedOptions.debugPipeline = debugPipeline;
  }
  if (typeof strictUserVisibleOutput === 'boolean') {
    normalizedOptions.strictUserVisibleOutput = strictUserVisibleOutput;
  }

  return normalizedOptions;
}
